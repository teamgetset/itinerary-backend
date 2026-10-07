import { and, like, ne } from "drizzle-orm";
import type { PgColumn, PgTable } from "drizzle-orm/pg-core";
import { z } from "zod";
import type { Db, Tx } from "../db/client.ts";
import { SLUG_PATTERN, escapeLike, slugSchemaMessage, slugify } from "../lib/text.ts";
import { nullableText, optionalId } from "./crud.ts";
import type { ImageDto } from "./media/dto.ts";

export const slugInput = z.string().trim().max(80).regex(SLUG_PATTERN, slugSchemaMessage);

/** SEO fields for branches, destinations and packages. */
export const seoInput = z.object({
  seoTitle: nullableText(70),
  seoDescription: nullableText(170),
  canonicalUrl: z.url().max(500).nullish(),
  ogTitle: nullableText(90),
  ogDescription: nullableText(200),
  ogImageId: optionalId,
  noindex: z.boolean().optional(),
});

interface SeoRow {
  seoTitle: string | null;
  seoDescription: string | null;
  canonicalUrl: string | null;
  ogTitle: string | null;
  ogDescription: string | null;
  ogImageId: string | null;
  noindex: boolean;
}

export const seoDto = (row: SeoRow, image: (id: string | null) => ImageDto | null) => ({
  title: row.seoTitle,
  description: row.seoDescription,
  canonicalUrl: row.canonicalUrl,
  ogTitle: row.ogTitle,
  ogDescription: row.ogDescription,
  ogImage: image(row.ogImageId),
  noindex: row.noindex,
});

/** "bali-island-escape", or "bali-island-escape-2" when taken. */
export async function uniqueSlug(
  db: Db | Tx,
  table: PgTable & { id: PgColumn },
  slugColumn: PgColumn,
  wanted: string,
  excludeId?: string,
) {
  const base = slugify(wanted) || "item";
  const rows = await db
    .select({ slug: slugColumn })
    .from(table as PgTable)
    .where(and(like(slugColumn, `${escapeLike(base)}%`), excludeId ? ne(table.id, excludeId) : undefined));
  const taken = new Set(rows.map((row) => row.slug as string));
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) if (!taken.has(`${base}-${n}`)) return `${base}-${n}`;
}

/** Adds `<name>Image` objects next to each `<name>ImageId`, for admin forms that show a preview. */
export function withImages<T extends Record<string, unknown>>(row: T, image: (id: string | null) => ImageDto | null) {
  const extra: Record<string, ImageDto | null> = {};
  for (const [key, value] of Object.entries(row)) {
    if (key.endsWith("ImageId") || key === "imageId") extra[key.replace(/Id$/, "")] = image((value as string) ?? null);
  }
  return { ...row, ...extra };
}
