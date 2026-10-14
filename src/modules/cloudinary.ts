import { v2 as cloudinary, type UploadApiResponse } from "cloudinary";
import { env } from "../config/env.ts";
import type { CloudinaryAsset } from "../db/models.ts";

/*
 * Cloudinary, server side only: uploads are signed with the API secret here, never in a browser.
 * Images: public assets with a fixed public id, <CLOUDINARY_FOLDER>/images/<media id>.
 * Documents (itinerary PDFs): private assets (raw, authenticated) at <CLOUDINARY_FOLDER>/<storage key>; nobody can fetch
 * them without a signature, so the API downloads them with a short-lived signed link and streams them itself.
 * Fixed public ids make uploads idempotent: uploading again returns the existing asset instead of a duplicate.
 */

let configured = false;

function client() {
  if (!configured) {
    if (!env.CLOUDINARY_CLOUD_NAME || !env.CLOUDINARY_API_KEY || !env.CLOUDINARY_API_SECRET || !env.CLOUDINARY_FOLDER) {
      throw new Error("Cloudinary is not configured: set CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY, CLOUDINARY_API_SECRET and CLOUDINARY_FOLDER");
    }
    cloudinary.config({ cloud_name: env.CLOUDINARY_CLOUD_NAME, api_key: env.CLOUDINARY_API_KEY, api_secret: env.CLOUDINARY_API_SECRET, secure: true });
    configured = true;
  }
  return cloudinary;
}

export const imagesFolder = () => `${env.CLOUDINARY_FOLDER}/images`;
export const imagePublicId = (mediaId: string) => `${imagesFolder()}/${mediaId}`;

const toAsset = (r: UploadApiResponse): CloudinaryAsset => ({
  publicId: r.public_id,
  secureUrl: r.secure_url,
  version: r.version,
  format: r.format || null,
  resourceType: r.resource_type,
  type: r.type,
  width: r.width ?? null,
  height: r.height ?? null,
  bytes: r.bytes,
});

/**
 * Uploads an image under its fixed public id. `existing` is true when Cloudinary already had it (nothing re-uploaded);
 * `etag` is Cloudinary's MD5 of the stored file.
 */
export async function uploadImage(mediaId: string, data: Buffer): Promise<{ asset: CloudinaryAsset; existing: boolean; etag?: string }> {
  const response = await new Promise<UploadApiResponse>((resolve, reject) =>
    client()
      .uploader.upload_stream(
        {
          public_id: imagePublicId(mediaId),
          asset_folder: imagesFolder(),
          resource_type: "image",
          type: "upload",
          overwrite: false,
          unique_filename: false,
        },
        (error, result) => (error || !result ? reject(new Error(error?.message ?? "Cloudinary returned no result")) : resolve(result)),
      )
      .end(data),
  );
  return { asset: toAsset(response), existing: !!(response as UploadApiResponse & { existing?: boolean }).existing, etag: response.etag };
}

export async function destroyImage(publicId: string) {
  await client().uploader.destroy(publicId, { resource_type: "image", type: "upload", invalidate: true });
}

/** Public ids of the image assets under a prefix (Admin API; for verification). */
export async function listImageIds(prefix: string) {
  const ids: string[] = [];
  let cursor: string | undefined;
  do {
    const page = await client().api.resources({ resource_type: "image", type: "upload", prefix, max_results: 500, next_cursor: cursor });
    ids.push(...page.resources.map((resource: { public_id: string }) => resource.public_id));
    cursor = page.next_cursor;
  } while (cursor);
  return ids;
}

// ---------------------------------------------------------------------------------------------
// Documents (itinerary PDFs): private

/** "documents/itineraries/<package>/v1-with-logo.pdf" -> "<folder>/documents/itineraries/<package>/v1-with-logo.pdf". */
export const documentPublicId = (storageKey: string) => `${env.CLOUDINARY_FOLDER}/${storageKey}`;
export const documentsFolder = () => `${env.CLOUDINARY_FOLDER}/documents`;

/** Uploads a PDF as a private asset under its fixed public id (raw public ids keep the .pdf extension). */
export async function uploadDocument(publicId: string, data: Buffer): Promise<{ asset: CloudinaryAsset; existing: boolean; etag?: string }> {
  const response = await new Promise<UploadApiResponse>((resolve, reject) =>
    client()
      .uploader.upload_stream(
        {
          public_id: publicId,
          asset_folder: publicId.slice(0, publicId.lastIndexOf("/")),
          resource_type: "raw",
          type: "authenticated",
          overwrite: false,
          unique_filename: false,
        },
        (error, result) => (error || !result ? reject(new Error(error?.message ?? "Cloudinary returned no result")) : resolve(result)),
      )
      .end(data),
  );
  return { asset: toAsset(response), existing: !!(response as UploadApiResponse & { existing?: boolean }).existing, etag: response.etag };
}

/**
 * A signed download link for a private document, valid for `ttlSeconds`. It carries a signature, so it must never be
 * logged or sent to a browser: the API fetches it server side.
 */
export const privateDocumentUrl = (publicId: string, ttlSeconds = 300) =>
  client().utils.private_download_url(publicId, "", { resource_type: "raw", type: "authenticated", expires_at: Math.floor(Date.now() / 1000) + ttlSeconds });

/** The bytes of a private document. */
export async function downloadDocument(publicId: string): Promise<Buffer> {
  const response = await fetch(privateDocumentUrl(publicId), { signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`Cloudinary document download failed (HTTP ${response.status})`);
  return Buffer.from(await response.arrayBuffer());
}

/** Public ids of the private documents under a prefix (Admin API; for verification). */
export async function listDocumentIds(prefix: string) {
  const ids: string[] = [];
  let cursor: string | undefined;
  do {
    const page = await client().api.resources({ resource_type: "raw", type: "authenticated", prefix, max_results: 500, next_cursor: cursor });
    ids.push(...page.resources.map((resource: { public_id: string }) => resource.public_id));
    cursor = page.next_cursor;
  } while (cursor);
  return ids;
}
