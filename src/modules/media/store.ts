import { env } from "../../config/env.ts";
import type { CloudinaryAsset } from "../../db/models.ts";
import { log } from "../../lib/logger.ts";
import { destroyDocument, destroyImage, documentPublicId, downloadDocument, uploadDocument, uploadImage } from "../cloudinary.ts";
import { newKey, storage } from "../storage.ts";

/*
 * Where newly uploaded images go: Cloudinary (STORAGE_PROVIDER=cloudinary) or the local disk.
 * `imageStore` is an object so tests can switch provider and replace the Cloudinary calls with a fake.
 */
export const imageStore = {
  provider: env.STORAGE_PROVIDER,
  cloudinary: { upload: uploadImage, destroy: destroyImage },
};

export interface StoredImage {
  storageKey: string;
  cloudinary: CloudinaryAsset | null;
}

/** Stores an image's bytes for the media document `mediaId`. Throws when the provider fails or answers unexpectedly. */
export async function storeImage(mediaId: string, data: Buffer, type: { mime: string; ext: string }): Promise<StoredImage> {
  if (imageStore.provider === "cloudinary") {
    const { asset } = await imageStore.cloudinary.upload(mediaId, data);
    if (asset.resourceType !== "image" || asset.bytes !== data.length || !asset.secureUrl.startsWith("https://")) {
      throw new Error(`Cloudinary stored an unexpected asset for ${mediaId}`);
    }
    return { storageKey: asset.publicId, cloudinary: asset };
  }
  const key = newKey("images", type.ext);
  await storage.put(key, data, type.mime);
  return { storageKey: key, cloudinary: null };
}

/** Removes a just-stored image whose database record could not be saved, so no orphan is left behind. */
export async function discardImage(stored: StoredImage) {
  try {
    if (stored.cloudinary) await imageStore.cloudinary.destroy(stored.cloudinary.publicId);
    else await storage.delete(stored.storageKey);
  } catch (error) {
    log.error("media.discard_failed", { storageKey: stored.storageKey, error });
  }
}

// ---------------------------------------------------------------------------------------------
// Documents (itinerary PDFs). Same provider switch; on Cloudinary they are private and read back with a signed link.

export const documentStore = {
  provider: env.STORAGE_PROVIDER,
  cloudinary: { upload: uploadDocument, download: downloadDocument, destroy: destroyDocument },
};

/** Stores an itinerary PDF under `key` ("documents/itineraries/<package>/<media id>.pdf"); verified before returning. */
export async function storeDocument(key: string, data: Buffer): Promise<StoredImage> {
  if (documentStore.provider === "cloudinary") {
    const { asset } = await documentStore.cloudinary.upload(documentPublicId(key), data);
    if (asset.resourceType !== "raw" || asset.type !== "authenticated" || asset.bytes !== data.length) {
      throw new Error(`Cloudinary stored an unexpected asset for ${key}`);
    }
    return { storageKey: asset.publicId, cloudinary: asset };
  }
  await storage.put(key, data, "application/pdf");
  return { storageKey: key, cloudinary: null };
}

/** The bytes of a stored PDF: from Cloudinary (private) when it lives there, else from local storage. */
export async function readDocument(row: { storageKey: string; cloudinary: CloudinaryAsset | null }): Promise<Buffer | null> {
  if (row.cloudinary) return documentStore.cloudinary.download(row.cloudinary.publicId);
  return storage.get(row.storageKey);
}

/** Deletes a stored PDF, wherever it lives. Throws when the provider fails, so callers can report it. */
export async function deleteDocument(row: { storageKey: string; cloudinary: CloudinaryAsset | null }) {
  if (row.cloudinary) await documentStore.cloudinary.destroy(row.cloudinary.publicId);
  else await storage.delete(row.storageKey);
}
