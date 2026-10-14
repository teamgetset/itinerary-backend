import { randomUUID } from "node:crypto";
import { transaction } from "../../db/client.ts";
import { AdminUser, Media, Package, type AdminUserDoc, type MediaDoc, type PackageDoc } from "../../db/models.ts";
import { AppError, conflict, notFound } from "../../lib/errors.ts";
import type { AdminContext } from "../../lib/http.ts";
import { log } from "../../lib/logger.ts";
import { audit } from "../audit.ts";
import { deleteDocument, readDocument, storeDocument, type StoredImage } from "../media/store.ts";
import { revalidate } from "../revalidate.ts";
import { safeFileName } from "../storage.ts";

/*
 * Itinerary PDFs are prepared outside GETSET and uploaded by an admin: one per package, required to publish.
 * They are stored privately (Cloudinary raw/authenticated, or local disk) and only ever streamed by the API.
 *
 * The package never points at a missing file: a new upload is stored and verified, then recorded and switched to in one
 * transaction (which also archives the old record), and only then is the old file deleted, followed by its record.
 * A file that cannot be deleted is logged and its archived record kept, so it can be cleaned up later. The media
 * library cannot archive a PDF that a package uses (see media/routes.ts).
 */

/** 4 MB: the admin uploads through Vercel, whose request limit is 4.5 MB including the form's overhead. */
export const PDF_MAX_BYTES = 4 * 1024 * 1024;
const PDF_SIGNATURE = Buffer.from("%PDF-");

export const pdfNotAvailable = () => new AppError(404, "PDF_NOT_AVAILABLE", "The itinerary PDF for this package is not available yet.");

/** Checks an upload: not empty, not too large, declared as a PDF, and really one (its first bytes). */
export function checkPdf(file: File, data: Buffer) {
  if (data.length === 0) throw new AppError(400, "EMPTY_FILE", "The file is empty.");
  if (data.length > PDF_MAX_BYTES) throw new AppError(413, "FILE_TOO_LARGE", "Itinerary PDFs can be up to 4 MB.");
  if (file.type !== "application/pdf") throw new AppError(400, "UNSUPPORTED_FILE", "Upload the itinerary as a PDF file.");
  if (!data.subarray(0, PDF_SIGNATURE.length).equals(PDF_SIGNATURE)) {
    log.warn("pdf.upload_rejected", { reason: "signature" });
    throw new AppError(400, "UNSUPPORTED_FILE", "This file is not a valid PDF.");
  }
}

/** What the admin sees about a package's PDF; null when it has none. */
export async function itineraryPdfInfo(mediaId: string | null) {
  if (!mediaId) return null;
  const row = await Media.findOne({ _id: mediaId, deletedAt: null }).lean<MediaDoc>();
  if (!row) return null;
  const uploader = row.uploadedById ? await AdminUser.findById(row.uploadedById, { name: 1 }).lean<Pick<AdminUserDoc, "name">>() : null;
  return { mediaId: row._id, fileName: row.fileName, sizeBytes: row.sizeBytes, uploadedAt: row.createdAt, uploadedBy: uploader?.name ?? null };
}

/**
 * Deletes a PDF that is no longer used (its record already archived): the file first, then the record. Runs after the
 * change is committed, so a failure is logged for clean-up and never reported as the change itself failing.
 * Returns whether the file is gone.
 */
async function deleteUnusedPdf(mediaId: string): Promise<boolean> {
  let storageKey: string | undefined;
  try {
    const row = await Media.findById(mediaId).lean<MediaDoc>();
    if (!row) return true;
    storageKey = row.storageKey;
    await deleteDocument(row);
  } catch (error) {
    log.error("pdf.file_delete_failed", { mediaId, storageKey, error });
    return false;
  }
  // The file is gone; the archived record left behind points at nothing and is safe to delete by hand.
  await Media.deleteOne({ _id: mediaId }).catch((error) => log.error("pdf.record_delete_failed", { mediaId, storageKey, fileDeleted: true, error }));
  return true;
}

const LEFT_BEHIND = "could not be deleted from storage. The failure is logged so the file can be cleaned up.";

/** Uploads a package's itinerary PDF, replacing the current one if there is one. */
export async function uploadItineraryPdf(packageId: string, file: File, admin: AdminContext) {
  const pkg = await Package.findOne({ _id: packageId, deletedAt: null }, { status: 1 }).lean<Pick<PackageDoc, "status">>();
  if (!pkg) throw notFound("Package");
  const data = Buffer.from(await file.arrayBuffer());
  checkPdf(file, data);

  const mediaId = randomUUID();
  let stored: StoredImage;
  try {
    stored = await storeDocument(`documents/itineraries/${packageId}/${mediaId}.pdf`, data);
  } catch (error) {
    log.error("pdf.upload_failed", { packageId, error });
    throw new AppError(502, "STORAGE_ERROR", "The PDF could not be stored. Please try again.");
  }

  const fileName = `${safeFileName(file.name, "pdf").replace(/\.pdf$/i, "")}.pdf`;
  let previousId: string | null;
  try {
    previousId = await transaction(async () => {
      const current = await Package.findOne({ _id: packageId, deletedAt: null }, { itineraryPdfId: 1 }).lean<Pick<PackageDoc, "itineraryPdfId">>();
      if (!current) throw notFound("Package");
      await Media.create([
        {
          _id: mediaId,
          kind: "DOCUMENT",
          storageKey: stored.storageKey,
          cloudinary: stored.cloudinary,
          fileName,
          mimeType: "application/pdf",
          sizeBytes: data.length,
          altText: "",
          uploadedById: admin.id,
        },
      ]);
      await Package.updateOne({ _id: packageId }, { $set: { itineraryPdfId: mediaId, updatedById: admin.id } });
      const previous = current.itineraryPdfId;
      if (previous) await Media.updateOne({ _id: previous }, { $set: { deletedAt: new Date() } });
      await audit(admin, previous ? "ITINERARY_PDF_REPLACED" : "ITINERARY_PDF_UPLOADED", "package", packageId, {
        mediaId,
        fileName,
        sizeBytes: data.length,
        ...(previous && { previousMediaId: previous }),
      });
      return previous;
    });
  } catch (error) {
    // Usually nothing was recorded and the old PDF is still in place, so the new file is deleted rather than left as an
    // orphan. But the error can arrive after a commit (an unknown commit result), so the file is deleted only once no
    // package is confirmed to point at it; if that cannot be checked, it is kept and logged for clean-up.
    const where = { packageId, mediaId, storageKey: stored.storageKey };
    const inUse = await Package.exists({ itineraryPdfId: mediaId }).then(Boolean, (lookup) => {
      log.error("pdf.discard_skipped", { ...where, reason: "lookup_failed", error: lookup });
      return null;
    });
    if (inUse) log.error("pdf.discard_skipped", { ...where, reason: "in_use" });
    if (inUse === false) await deleteDocument(stored).catch((cleanup) => log.error("pdf.discard_failed", { ...where, error: cleanup }));
    throw error;
  }

  const previousDeleted = previousId ? await deleteUnusedPdf(previousId) : true;
  if (pkg.status === "PUBLISHED") revalidate("catalog");
  log.info(previousId ? "pdf.replaced" : "pdf.uploaded", { packageId, mediaId, bytes: data.length, adminUserId: admin.id });
  return {
    pdf: await itineraryPdfInfo(mediaId),
    ...(!previousDeleted && { warning: `The new PDF is live, but the previous file ${LEFT_BEHIND}` }),
  };
}

/** Removes a draft or archived package's PDF. A published package must keep one (replace it instead). */
export async function removeItineraryPdf(packageId: string, admin: AdminContext) {
  const mediaId = await transaction(async () => {
    const pkg = await Package.findOne({ _id: packageId, deletedAt: null }, { itineraryPdfId: 1, status: 1 }).lean<Pick<PackageDoc, "itineraryPdfId" | "status">>();
    if (!pkg) throw notFound("Package");
    if (!pkg.itineraryPdfId) throw notFound("Itinerary PDF");
    if (pkg.status === "PUBLISHED") {
      throw conflict("PDF_REQUIRED", "A published package needs its itinerary PDF. Upload a replacement, or unpublish the package first.");
    }
    await Package.updateOne({ _id: packageId }, { $set: { itineraryPdfId: null, updatedById: admin.id } });
    await Media.updateOne({ _id: pkg.itineraryPdfId }, { $set: { deletedAt: new Date() } });
    await audit(admin, "ITINERARY_PDF_REMOVED", "package", packageId, { mediaId: pkg.itineraryPdfId });
    return pkg.itineraryPdfId;
  });
  const fileDeleted = await deleteUnusedPdf(mediaId);
  log.info("pdf.removed", { packageId, mediaId, fileDeleted, adminUserId: admin.id });
  return { removed: true, fileDeleted, ...(!fileDeleted && { warning: `The PDF was removed from the package, but its file ${LEFT_BEHIND}` }) };
}

/** A package's current PDF with its bytes, or null when it has none (or its file is missing, which is logged). */
export async function readItineraryPdf(mediaId: string | null): Promise<{ row: MediaDoc; data: Buffer } | null> {
  if (!mediaId) return null;
  const row = await Media.findOne({ _id: mediaId, deletedAt: null }).lean<MediaDoc>();
  if (!row) return null;
  let data: Buffer | null;
  try {
    data = await readDocument(row);
  } catch (error) {
    log.error("pdf.read_failed", { mediaId, error });
    throw new AppError(502, "STORAGE_ERROR", "The itinerary PDF could not be loaded. Please try again.");
  }
  if (!data) log.error("pdf.file_missing", { mediaId, storageKey: row.storageKey });
  return data ? { row, data } : null;
}

/** Headers for streaming a PDF. `fileName` must already be safe (a slug-based or sanitised name). */
export const pdfHeaders = (fileName: string, size: number, disposition: "attachment" | "inline") => ({
  "Content-Type": "application/pdf",
  "Content-Disposition": `${disposition}; filename="${fileName}"`,
  "Content-Length": String(size),
  "X-Content-Type-Options": "nosniff",
});
