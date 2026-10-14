import { z } from "zod";
import { HeroSlide, Media, withId, type HeroSlideDoc } from "../db/models.ts";
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
  model: HeroSlide,
  create: slideInput,
  update: slideInput.partial(),
  search: ["title"],
  sort: { displayOrder: 1, createdAt: 1 },
  refs: { imageId: Media },
  toDto: async (rows) => {
    const image = await loadImages(rows.map((row) => row.imageId));
    return rows.map((row) => withImages(row, image));
  },
  tags: ["hero"],
  orderable: true,
});

export async function listPublicHeroSlides() {
  const rows = (await HeroSlide.find({ isPublished: true }).sort({ displayOrder: 1, createdAt: 1 }).lean<HeroSlideDoc[]>()).map(withId);
  const image = await loadImages(rows.map((row) => row.imageId));
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
