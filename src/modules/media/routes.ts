import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import { Media, Package, defined, type MediaDoc } from "../../db/models.ts";
import { AppError, badRequest, inUse, notFound } from "../../lib/errors.ts";
import { idParam, ok, pageMeta, pageQuery, readBody, readQuery, type AppEnv } from "../../lib/http.ts";
import { log } from "../../lib/logger.ts";
import { contains } from "../../lib/text.ts";
import { requireRole } from "../auth/middleware.ts";
import { audit } from "../audit.ts";
import { IMAGE_MAX_BYTES, safeFileName, sniffImage } from "../storage.ts";
import { usesPdf } from "../pdf/itinerary-pdf.ts";
import { mediaDto } from "./dto.ts";
import { discardImage, storeImage, type StoredImage } from "./store.ts";

/* The media library: upload once, reuse anywhere (packages, branches, hero slides...). */

const focalPoint = z
  .string()
  .trim()
  .regex(/^(left|center|right|\d{1,3}%)( (top|center|bottom|\d{1,3}%))?$/, "Use a CSS position such as \"center 25%\"")
  .nullish();

const listQuery = pageQuery.extend({
  q: z.string().trim().max(100).optional(),
  kind: z.enum(["IMAGE", "DOCUMENT"]).default("IMAGE"),
});

export const mediaAdminRoutes = new Hono<AppEnv>()
  .get("/", async (c) => {
    const query = readQuery(c, listQuery);
    const filter = {
      deletedAt: null,
      kind: query.kind,
      ...(query.q && { $or: [{ fileName: contains(query.q) }, { altText: contains(query.q) }] }),
    };
    const [rows, total] = await Promise.all([
      Media.find(filter)
        .sort({ createdAt: -1 })
        .skip((query.page - 1) * query.pageSize)
        .limit(query.pageSize)
        .lean<MediaDoc[]>(),
      Media.countDocuments(filter),
    ]);
    return ok(c, rows.map(mediaDto), pageMeta(query.page, query.pageSize, total));
  })
  .get("/:id", async (c) => {
    const row = await Media.findById(idParam(c)).lean<MediaDoc>();
    if (!row) throw notFound("File");
    return ok(c, mediaDto(row));
  })
  .post(
    "/",
    requireRole("EDITOR"),
    bodyLimit({
      maxSize: IMAGE_MAX_BYTES + 512 * 1024,
      onError: () => {
        throw new AppError(413, "FILE_TOO_LARGE", "Images can be up to 10 MB");
      },
    }),
    async (c) => {
      const form = await c.req.parseBody().catch(() => {
        throw badRequest("INVALID_UPLOAD", "Send the image as multipart/form-data in a field named \"file\"");
      });
      const file = form.file;
      if (!(file instanceof File)) throw badRequest("INVALID_UPLOAD", "Choose an image to upload");
      if (file.size === 0) throw badRequest("INVALID_UPLOAD", "The file is empty");
      if (file.size > IMAGE_MAX_BYTES) throw new AppError(413, "FILE_TOO_LARGE", "Images can be up to 10 MB");

      const data = Buffer.from(await file.arrayBuffer());
      // The real type comes from the bytes; the name and the browser's claimed type are not trusted.
      const type = sniffImage(data);
      if (!type) {
        log.warn("media.upload_rejected", { reason: "type", claimed: file.type });
        throw badRequest("UNSUPPORTED_FILE", "Upload a JPEG, PNG, WebP or AVIF image");
      }
      const meta = z
        .object({ alt: z.string().trim().max(250).optional(), focalPoint })
        .parse({ alt: form.alt || undefined, focalPoint: form.focalPoint || undefined });

      const id = randomUUID();
      let stored: StoredImage;
      try {
        stored = await storeImage(id, data, type);
      } catch (error) {
        log.error("media.upload_failed", { error });
        throw new AppError(502, "STORAGE_ERROR", "The file could not be stored. Please try again.");
      }
      const admin = c.get("admin");
      const fileName = safeFileName(file.name, type.ext).replace(/\.[a-z0-9]+$/i, "") + `.${type.ext}`;
      const row = await Media.create({
        _id: id,
        kind: "IMAGE",
        storageKey: stored.storageKey,
        cloudinary: stored.cloudinary,
        fileName,
        mimeType: type.mime,
        sizeBytes: data.length,
        altText: meta.alt ?? "",
        focalPoint: meta.focalPoint ?? null,
        uploadedById: admin.id,
      }).then(
        (created) => created.toObject() as MediaDoc,
        async (error) => {
          // The file is stored but its record is not: remove the file rather than leave an orphan.
          await discardImage(stored);
          throw error;
        },
      );
      await audit(admin, "MEDIA_UPLOADED", "media", row._id, { fileName });
      return ok(c, mediaDto(row), undefined, 201);
    },
  )
  .patch("/:id", requireRole("EDITOR"), async (c) => {
    const id = idParam(c);
    const input = await readBody(c, z.object({ alt: z.string().trim().max(250).optional(), focalPoint }));
    const fields = defined({ altText: input.alt, focalPoint: input.focalPoint });
    const row = Object.keys(fields).length
      ? await Media.findOneAndUpdate({ _id: id }, { $set: fields }, { returnDocument: "after" }).lean<MediaDoc>()
      : await Media.findById(id).lean<MediaDoc>();
    if (!row) throw notFound("File");
    await audit(c.get("admin"), "MEDIA_UPDATED", "media", id);
    return ok(c, mediaDto(row));
  })
  /** Archive: the file stays reachable where it is already used, but leaves the library. */
  .delete("/:id", requireRole("ADMIN"), async (c) => {
    const id = idParam(c);
    // Except a package's itinerary PDF, which is only served while its record is live: replace or remove it in the package.
    if (await Package.exists(usesPdf(id))) throw inUse();
    const archived = await Media.updateOne({ _id: id, deletedAt: null }, { $set: { deletedAt: new Date() } });
    if (!archived.matchedCount) throw notFound("File");
    await audit(c.get("admin"), "MEDIA_ARCHIVED", "media", id);
    return ok(c, { id, deleted: true });
  });
