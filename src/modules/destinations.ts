import { z } from "zod";
import { Activity, Destination, Media, Package, withId, type ActivityDoc, type DestinationDoc } from "../db/models.ts";
import { notFound } from "../lib/errors.ts";
import { publishedCounts } from "./branches.ts";
import { activityDtos } from "./catalog.ts";
import { crudRoutes, nullableText, optionalId } from "./crud.ts";
import { loadImages, type ImageDto } from "./media/dto.ts";
import { refreshSearchText } from "./packages/search-text.ts";
import { seoDto, seoInput, slugInput, uniqueSlug, withImages } from "./shared.ts";

type DestinationRow = Omit<DestinationDoc, "_id"> & { id: string };

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
  model: Destination,
  create: destinationInput,
  update: destinationInput.partial(),
  search: ["name", "countryName", "region"],
  sort: { displayOrder: 1, name: 1 },
  filters: (query) => [query.active ? { isActive: query.active === "true" } : undefined],
  toDto: async (rows) => {
    const image = await loadImages(rows.flatMap((row) => [row.heroImageId, row.thumbnailImageId, row.ogImageId]));
    return rows.map((row) => withImages(row, image));
  },
  prepare: async (data, existing) => (!existing && !data.slug ? { ...data, slug: await uniqueSlug(Destination, data.name) } : data),
  refs: { heroImageId: Media, thumbnailImageId: Media, ogImageId: Media },
  inUse: async (id) => !!(await Package.exists({ destinationId: id })),
  onDelete: async (id) => {
    await Activity.updateMany({ destinationId: id }, { $set: { destinationId: null } });
  },
  afterSave: (id) => refreshSearchText({ destinationId: id }),
  tags: ["catalog"],
  orderable: true,
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
  const rows = (await Destination.find({ isActive: true }).sort({ displayOrder: 1, name: 1 }).lean<DestinationDoc[]>()).map(withId);
  const counts = await publishedCounts("destinationId");
  const image = await loadImages(rows.flatMap((row) => [row.heroImageId, row.thumbnailImageId, row.ogImageId]));
  return rows.map((row) => ({
    ...destinationDto(row, image),
    packageCount: counts.get(row.id) ?? 0,
  }));
}

/** A destination with its bookable add-on activities (for destination pages). */
export async function getPublicDestination(slug: string) {
  const doc = await Destination.findOne({ slug, isActive: true }).lean<DestinationDoc>();
  if (!doc) throw notFound("Destination");
  const row = withId(doc);
  const [image, activityRows] = await Promise.all([
    loadImages([row.heroImageId, row.thumbnailImageId, row.ogImageId]),
    Activity.find({ destinationId: row.id, isActive: true }).sort({ displayOrder: 1, name: 1 }).lean<ActivityDoc[]>(),
  ]);
  const experiences = (await activityDtos(activityRows.map(withId))).map((activity) => ({
    slug: activity.slug,
    name: activity.name,
    description: activity.description,
    image: activity.image ?? null,
    prices: activity.prices,
  }));
  return { ...destinationDto(row, image), experiences };
}
