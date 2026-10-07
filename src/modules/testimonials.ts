import { and, asc, count, eq, inArray, isNull } from "drizzle-orm";
import { z } from "zod";
import { db } from "../db/client.ts";
import { testimonials } from "../db/schema.ts";
import { pageMeta } from "../lib/http.ts";
import { crudRoutes, nullableText, optionalId } from "./crud.ts";
import { loadImages, type ImageDto } from "./media/dto.ts";
import { withImages } from "./shared.ts";

type TestimonialRow = typeof testimonials.$inferSelect;

/*
 * Reviews shown site-wide (and on a package page when linked to one).
 * Only publish real reviews, with the customer's permission for any photo, and keep the source so they can be checked.
 */
const testimonialInput = z.object({
  customerName: z.string().trim().min(1).max(80),
  profile: z.string().trim().max(80).optional(),
  imageId: optionalId,
  rating: z.number().int().min(1).max(5),
  review: z.string().trim().min(1).max(2000),
  place: z.string().trim().max(80).optional(),
  sourceName: nullableText(60),
  sourceUrl: z.url().max(500).nullish(),
  reviewedAt: z.iso.date().nullish(),
  packageId: optionalId,
  displayOrder: z.number().int().min(0).optional(),
  isPublished: z.boolean().optional(),
});

export const testimonialAdminRoutes = crudRoutes({
  entity: "testimonial",
  label: "Testimonial",
  table: testimonials,
  create: testimonialInput,
  update: testimonialInput.partial(),
  search: [testimonials.customerName, testimonials.place, testimonials.review],
  orderBy: [asc(testimonials.displayOrder), asc(testimonials.createdAt)],
  filters: (query) => [
    query.published ? eq(testimonials.isPublished, query.published === "true") : undefined,
    /^[1-5]$/.test(query.rating ?? "") ? eq(testimonials.rating, Number(query.rating)) : undefined,
  ],
  toDto: async (rows) => {
    const image = await loadImages(db, rows.map((row) => row.imageId));
    return rows.map((row) => withImages(row, image));
  },
  deletedAt: testimonials.deletedAt,
  tags: ["testimonials", "catalog"],
  orderable: testimonials.displayOrder,
});

export function testimonialDto(row: TestimonialRow, image: (id: string | null) => ImageDto | null) {
  return {
    id: row.id,
    customerName: row.customerName,
    profile: row.profile,
    image: image(row.imageId),
    rating: row.rating,
    review: row.review,
    place: row.place,
    source: row.sourceName ? { name: row.sourceName, url: row.sourceUrl, date: row.reviewedAt } : null,
  };
}

const visible = and(eq(testimonials.isPublished, true), isNull(testimonials.deletedAt));

export async function listPublicTestimonials(page: number, pageSize: number) {
  const [rows, [{ total }]] = await Promise.all([
    db
      .select()
      .from(testimonials)
      .where(visible)
      .orderBy(asc(testimonials.displayOrder), asc(testimonials.createdAt))
      .limit(pageSize)
      .offset((page - 1) * pageSize),
    db.select({ total: count() }).from(testimonials).where(visible),
  ]);
  const image = await loadImages(db, rows.map((row) => row.imageId));
  return { items: rows.map((row) => testimonialDto(row, image)), meta: pageMeta(page, pageSize, total) };
}

/** Published reviews linked to packages, keyed by package id. */
export async function testimonialsForPackages(packageIds: string[]) {
  if (!packageIds.length) return new Map<string, ReturnType<typeof testimonialDto>[]>();
  const rows = await db
    .select()
    .from(testimonials)
    .where(and(visible, inArray(testimonials.packageId, packageIds)))
    .orderBy(asc(testimonials.displayOrder));
  const image = await loadImages(db, rows.map((row) => row.imageId));
  const byPackage = new Map<string, ReturnType<typeof testimonialDto>[]>();
  for (const row of rows) byPackage.set(row.packageId!, [...(byPackage.get(row.packageId!) ?? []), testimonialDto(row, image)]);
  return byPackage;
}

