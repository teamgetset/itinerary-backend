import { and, asc, count, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import { db } from "../db/client.ts";
import { activities, destinations, packages } from "../db/schema.ts";
import { notFound } from "../lib/errors.ts";
import { activityDtos } from "./catalog.ts";
import { crudRoutes, nullableText, optionalId } from "./crud.ts";
import { loadImages, type ImageDto } from "./media/dto.ts";
import { refreshSearchText } from "./packages/search-text.ts";
import { seoDto, seoInput, slugInput, uniqueSlug, withImages } from "./shared.ts";

type DestinationRow = typeof destinations.$inferSelect;

const destinationInput = z
  .object({
    name: z.string().trim().min(1).max(80),
    slug: slugInput.optional(),
    kind: z.enum(["COUNTRY", "PLACE"]).optional(),
    countryCode: z.string().trim().toUpperCase().regex(/^[A-Z]{2}$/, "Two-letter country code, e.g. GE"),
    countryName: z.string().trim().min(1).max(80),
    region: nullableText(80),
    shortDescription: z.string().trim().max(400).optional(),
    description: z.string().trim().max(5000).optional(),
    heroImageId: optionalId,
    thumbnailImageId: optionalId,
    facts: z
      .array(z.object({ label: z.string().trim().min(1).max(40), value: z.string().trim().min(1).max(200) }))
      .max(12)
      .optional(),
    displayOrder: z.number().int().min(0).optional(),
    isActive: z.boolean().optional(),
  })
  .extend(seoInput.shape);

export const destinationAdminRoutes = crudRoutes({
  entity: "destination",
  label: "Destination",
  table: destinations,
  create: destinationInput,
  update: destinationInput.partial(),
  search: [destinations.name, destinations.countryName, destinations.region],
  orderBy: [asc(destinations.displayOrder), asc(destinations.name)],
  filters: (query) => [query.active ? eq(destinations.isActive, query.active === "true") : undefined],
  toDto: async (rows) => {
    const image = await loadImages(db, rows.flatMap((row) => [row.heroImageId, row.thumbnailImageId, row.ogImageId]));
    return rows.map((row) => withImages(row, image));
  },
  prepare: async (data, existing) =>
    !existing && !data.slug ? { ...data, slug: await uniqueSlug(db, destinations, destinations.slug, data.name) } : data,
  afterSave: (tx, id) => refreshSearchText(tx, eq(packages.destinationId, id)),
  tags: ["catalog"],
  orderable: destinations.displayOrder,
});

// ---------------------------------------------------------------------------------------------
// Public

export function destinationDto(row: DestinationRow, image: (id: string | null) => ImageDto | null) {
  return {
    slug: row.slug,
    name: row.name,
    kind: row.kind,
    country: { code: row.countryCode, name: row.countryName },
    region: row.region,
    shortDescription: row.shortDescription,
    description: row.description,
    heroImage: image(row.heroImageId),
    thumbnailImage: image(row.thumbnailImageId),
    facts: row.facts,
    seo: seoDto(row, image),
  };
}

export type DestinationDto = ReturnType<typeof destinationDto>;

export async function listPublicDestinations() {
  const rows = await db
    .select()
    .from(destinations)
    .where(eq(destinations.isActive, true))
    .orderBy(asc(destinations.displayOrder), asc(destinations.name));
  const counts = await db
    .select({ destinationId: packages.destinationId, total: count() })
    .from(packages)
    .where(and(eq(packages.status, "PUBLISHED"), isNull(packages.deletedAt)))
    .groupBy(packages.destinationId);
  const image = await loadImages(db, rows.flatMap((row) => [row.heroImageId, row.thumbnailImageId, row.ogImageId]));
  return rows.map((row) => ({
    ...destinationDto(row, image),
    packageCount: counts.find((c) => c.destinationId === row.id)?.total ?? 0,
  }));
}

/** A destination with its bookable add-on activities (for destination pages). */
export async function getPublicDestination(slug: string) {
  const [row] = await db
    .select()
    .from(destinations)
    .where(and(eq(destinations.slug, slug), eq(destinations.isActive, true)))
    .limit(1);
  if (!row) throw notFound("Destination");
  const [image, activityRows] = await Promise.all([
    loadImages(db, [row.heroImageId, row.thumbnailImageId, row.ogImageId]),
    db
      .select()
      .from(activities)
      .where(and(eq(activities.destinationId, row.id), eq(activities.isActive, true)))
      .orderBy(asc(activities.displayOrder), asc(activities.name)),
  ]);
  const experiences = (await activityDtos(activityRows)).map((activity) => ({
    slug: activity.slug,
    name: activity.name,
    description: activity.description,
    image: activity.image ?? null,
    prices: activity.prices,
  }));
  return { ...destinationDto(row, image), experiences };
}
