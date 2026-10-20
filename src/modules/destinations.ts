import { z } from "zod";
import { Activity, Destination, Media, Package, withId, type ActivityDoc, type DestinationDoc, type PackageDoc } from "../db/models.ts";
import { notFound } from "../lib/errors.ts";
import { idParam, ok, type AdminContext } from "../lib/http.ts";
import { publishedCounts } from "./branches.ts";
import { activityDtos } from "./catalog.ts";
import { contentLinksTo, removeContentLinksTo } from "./content.ts";
import { crudRoutes, nullableText, optionalId } from "./crud.ts";
import { loadImages, type ImageDto } from "./media/dto.ts";
import { markPackageDeleted } from "./packages/delete.ts";
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

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;
const pagePath = (slug: string) => `/destinations/${slug}`;

/** What deleting a destination also changes, listed in the admin's confirmation before anything happens. */
async function deletionEffects(id: string) {
  const destination = await Destination.findOne({ _id: id, deletedAt: null }).lean<DestinationDoc>();
  if (!destination) throw notFound("Destination");
  const packages = await Package.find({ destinationId: id, deletedAt: null }, { title: 1, status: 1 }).sort({ title: 1 }).lean<Pick<PackageDoc, "title" | "status">[]>();
  const activities = await Activity.find({ destinationId: id }, { name: 1 }).sort({ name: 1 }).lean<Pick<ActivityDoc, "name">[]>();
  const links = await contentLinksTo(pagePath(destination.slug));
  return [
    packages.length && {
      summary: `${plural(packages.length, "package", "packages")} going there will be deleted too and leave the website:`,
      items: packages.map((pkg) => `${pkg.title} (${pkg.status.toLowerCase()})`),
      note: "To keep a package, move it to another destination in its Details tab first.",
    },
    activities.length && {
      summary: `${plural(activities.length, "activity stays", "activities stay")}, no longer linked to a destination:`,
      items: activities.map((activity) => activity.name),
    },
    links.length && { summary: "Links to its page are removed from Global content:", items: links },
  ].filter(Boolean);
}

/**
 * Deleting a destination takes what depends on it along, inside the delete's transaction, so nothing is left
 * pointing at a page that is gone: its packages are deleted (as with a package's own Delete), its add-on activities
 * unlinked, links to its page taken out of the site content. The destination itself is soft-deleted and its slug
 * released, so deleted packages and old enquiries keep a valid reference and the name can be used again.
 */
async function deleteDestination(id: string, admin: AdminContext) {
  const destination = (await Destination.findById(id).lean<DestinationDoc>())!;
  const packages = (await Package.find({ destinationId: id, deletedAt: null }, { slug: 1, status: 1 }).lean<Pick<PackageDoc, "_id" | "slug" | "status">[]>()).map(withId);
  for (const pkg of packages) await markPackageDeleted(pkg, admin, { destination: destination.slug });
  await Activity.updateMany({ destinationId: id }, { $set: { destinationId: null } });
  await removeContentLinksTo(pagePath(destination.slug), admin);
  await Destination.updateOne({ _id: id }, { $set: { isActive: false, slug: `${destination.slug}-deleted-${Date.now().toString(36)}` } });
}

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
  softDelete: true,
  onDelete: deleteDestination,
  afterSave: (id) => refreshSearchText({ destinationId: id }),
  tags: ["catalog"],
  orderable: true,
}).get("/:id/delete-check", async (c) => ok(c, { effects: await deletionEffects(idParam(c)) }));

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
