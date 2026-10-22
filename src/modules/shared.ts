import type { Model } from "mongoose";
import { z } from "zod";
import { Package } from "../db/models.ts";
import { SLUG_PATTERN, escapeRegex, slugSchemaMessage, slugify } from "../lib/text.ts";
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
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function uniqueSlug(model: Model<any>, wanted: string, excludeId?: string) {
  const base = slugify(wanted) || "item";
  const rows = await model
    .find({ slug: { $regex: `^${escapeRegex(base)}` }, ...(excludeId && { _id: { $ne: excludeId } }) }, { slug: 1 })
    .lean<{ slug: string }[]>();
  const taken = new Set(rows.map((row) => row.slug));
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

/** For admin lists: the title of each linked package ("... (deleted)" once deleted), null for none. */
export async function packageTitles(ids: (string | null)[]) {
  const wanted = [...new Set(ids.filter((id): id is string => !!id))];
  const rows = wanted.length ? await Package.find({ _id: { $in: wanted } }, { title: 1, deletedAt: 1 }).lean<{ _id: string; title: string; deletedAt: Date | null }[]>() : [];
  const titles = new Map(rows.map((row) => [row._id, row.deletedAt ? `${row.title} (deleted)` : row.title]));
  return (id: string | null) => (id ? (titles.get(id) ?? null) : null);
}
