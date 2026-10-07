import { and, asc, eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "../db/client.ts";
import { heroSlides } from "../db/schema.ts";
import { crudRoutes, nullableText, safeHref } from "./crud.ts";
import { loadImages } from "./media/dto.ts";
import { withImages } from "./shared.ts";

/* Homepage hero carousel. The headline and buttons over it are site content ("home.hero"); slides are the photos. */

const slideInput = z.object({
  title: z.string().trim().min(1).max(100),
  description: nullableText(200),
  /** Short tag in the caption, e.g. an airport code. */
  label: nullableText(12),
  imageId: z.uuid(),
  buttonText: nullableText(40),
  buttonLink: safeHref.nullish(),
  displayOrder: z.number().int().min(0).optional(),
  isPublished: z.boolean().optional(),
});

export const heroSlideAdminRoutes = crudRoutes({
  entity: "hero_slide",
  label: "Hero slide",
  table: heroSlides,
  create: slideInput,
  update: slideInput.partial(),
  search: [heroSlides.title],
  orderBy: [asc(heroSlides.displayOrder), asc(heroSlides.createdAt)],
  toDto: async (rows) => {
    const image = await loadImages(db, rows.map((row) => row.imageId));
    return rows.map((row) => withImages(row, image));
  },
  tags: ["hero"],
  orderable: heroSlides.displayOrder,
});

export async function listPublicHeroSlides() {
  const rows = await db
    .select()
    .from(heroSlides)
    .where(and(eq(heroSlides.isPublished, true)))
    .orderBy(asc(heroSlides.displayOrder), asc(heroSlides.createdAt));
  const image = await loadImages(db, rows.map((row) => row.imageId));
  return rows.map((row) => ({
    id: row.id,
    title: row.title,
    description: row.description,
    label: row.label,
    image: image(row.imageId),
    buttonText: row.buttonText,
    buttonLink: row.buttonLink,
  }));
}
