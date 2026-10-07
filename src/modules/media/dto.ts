import { inArray } from "drizzle-orm";
import type { Db, Tx } from "../../db/client.ts";
import { media } from "../../db/schema.ts";
import { storage } from "../storage.ts";

export type MediaRow = typeof media.$inferSelect;

export interface ImageDto {
  id: string;
  url: string;
  alt: string;
  focalPoint: string | null;
}

export const imageDto = (row: MediaRow | null | undefined): ImageDto | null =>
  row ? { id: row.id, url: storage.publicUrl(row.storageKey), alt: row.altText, focalPoint: row.focalPoint } : null;

/** Admin view: everything about a file. */
export const mediaDto = (row: MediaRow) => ({
  id: row.id,
  kind: row.kind,
  url: row.kind === "IMAGE" ? storage.publicUrl(row.storageKey) : null,
  fileName: row.fileName,
  mimeType: row.mimeType,
  sizeBytes: row.sizeBytes,
  alt: row.altText,
  focalPoint: row.focalPoint,
  createdAt: row.createdAt,
  deletedAt: row.deletedAt,
});

/** Loads the media rows referenced by a page of records in one query. */
export async function loadImages(db: Db | Tx, ids: (string | null | undefined)[]) {
  const unique = [...new Set(ids.filter((id): id is string => !!id))];
  const rows = unique.length ? await db.select().from(media).where(inArray(media.id, unique)) : [];
  const byId = new Map(rows.map((row) => [row.id, row]));
  return (id: string | null | undefined) => imageDto(id ? byId.get(id) : null);
}
