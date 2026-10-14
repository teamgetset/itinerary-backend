import { Media, type MediaDoc } from "../../db/models.ts";
import { storage } from "../storage.ts";

export type MediaRow = MediaDoc;

export interface ImageDto {
  id: string;
  url: string;
  alt: string;
  focalPoint: string | null;
}

/** Images on Cloudinary are delivered from there; the rest from this API's /media path. */
const imageUrl = (row: MediaRow) => row.cloudinary?.secureUrl ?? storage.publicUrl(row.storageKey);

export const imageDto = (row: MediaRow | null | undefined): ImageDto | null =>
  row ? { id: row._id, url: imageUrl(row), alt: row.altText, focalPoint: row.focalPoint } : null;

/** Admin view: everything about a file. */
export const mediaDto = (row: MediaRow) => ({
  id: row._id,
  kind: row.kind,
  url: row.kind === "IMAGE" ? imageUrl(row) : null,
  fileName: row.fileName,
  mimeType: row.mimeType,
  sizeBytes: row.sizeBytes,
  alt: row.altText,
  focalPoint: row.focalPoint,
  createdAt: row.createdAt,
  deletedAt: row.deletedAt,
});

/** Loads the media documents referenced by a page of records in one query. */
export async function loadImages(ids: (string | null | undefined)[]) {
  const unique = [...new Set(ids.filter((id): id is string => !!id))];
  const rows = unique.length ? await Media.find({ _id: { $in: unique } }).lean<MediaRow[]>() : [];
  const byId = new Map(rows.map((row) => [row._id, row]));
  return (id: string | null | undefined) => imageDto(id ? byId.get(id) : null);
}
