import { z } from "zod";
import { Media, Package, Testimonial, withId, type TestimonialDoc } from "../db/models.ts";
import { pageMeta } from "../lib/http.ts";
import { crudRoutes, nullableText, optionalId } from "./crud.ts";
import { loadImages, type ImageDto } from "./media/dto.ts";
import { withImages } from "./shared.ts";

type TestimonialRow = Omit<TestimonialDoc, "_id"> & { id: string };

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
  model: Testimonial,
  create: testimonialInput,
  update: testimonialInput.partial(),
  search: ["customerName", "place", "review"],
  sort: { displayOrder: 1, createdAt: 1 },
  filters: (query) => [
    query.published ? { isPublished: query.published === "true" } : undefined,
    /^[1-5]$/.test(query.rating ?? "") ? { rating: Number(query.rating) } : undefined,
  ],
  toDto: async (rows) => {
    const image = await loadImages(rows.map((row) => row.imageId));
    return rows.map((row) => withImages(row, image));
  },
  refs: { imageId: Media, packageId: Package },
  softDelete: true,
  tags: ["testimonials", "catalog"],
  orderable: true,
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

const visible = { isPublished: true, deletedAt: null };

export async function listPublicTestimonials(page: number, pageSize: number) {
  const [docs, total] = await Promise.all([
    Testimonial.find(visible)
      .sort({ displayOrder: 1, createdAt: 1 })
      .skip((page - 1) * pageSize)
      .limit(pageSize)
      .lean<TestimonialDoc[]>(),
    Testimonial.countDocuments(visible),
  ]);
  const rows = docs.map(withId);
  const image = await loadImages(rows.map((row) => row.imageId));
  return { items: rows.map((row) => testimonialDto(row, image)), meta: pageMeta(page, pageSize, total) };
}

/** Published reviews linked to packages, keyed by package id. */
export async function testimonialsForPackages(packageIds: string[]) {
  if (!packageIds.length) return new Map<string, ReturnType<typeof testimonialDto>[]>();
  const rows = (
    await Testimonial.find({ ...visible, packageId: { $in: packageIds } })
      .sort({ displayOrder: 1, createdAt: 1 })
      .lean<TestimonialDoc[]>()
  ).map(withId);
  const image = await loadImages(rows.map((row) => row.imageId));
  const byPackage = new Map<string, ReturnType<typeof testimonialDto>[]>();
  for (const row of rows) byPackage.set(row.packageId!, [...(byPackage.get(row.packageId!) ?? []), testimonialDto(row, image)]);
  return byPackage;
}

