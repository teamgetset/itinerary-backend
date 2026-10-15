import { z } from "zod";
import { Branch, Enquiry, Media, Package, withId, type BranchDoc } from "../db/models.ts";
import { notFound } from "../lib/errors.ts";
import { crudRoutes, nullableText, optionalId } from "./crud.ts";
import { loadImages, type ImageDto } from "./media/dto.ts";
import { seoDto, seoInput, slugInput, uniqueSlug, withImages } from "./shared.ts";

type BranchRow = Omit<BranchDoc, "_id"> & { id: string };

const branchInput = z
  .object({
    name: z.string().trim().min(1).max(80),
    slug: slugInput.optional(),
    shortDescription: z.string().trim().max(400).optional(),
    description: z.string().trim().max(2000).optional(),
    bannerImageId: optionalId,
    thumbnailImageId: optionalId,
    addressLines: z.array(z.string().trim().min(1).max(120)).max(6).optional(),
    city: z.string().trim().min(1).max(80),
    countryCode: z.string().trim().toUpperCase().regex(/^[A-Z]{2}$/, "Two-letter country code, e.g. AE"),
    countryName: z.string().trim().min(1).max(80),
    airportCode: z.string().trim().toUpperCase().regex(/^[A-Z]{3}$/, "Three-letter airport code, e.g. DXB").nullish(),
    airportCity: nullableText(80),
    phone: z.string().trim().min(5).max(40),
    whatsapp: z.string().regex(/^\d{8,15}$/, "Digits only, with the country code, e.g. 971585689114").nullish(),
    email: z.email().max(254).nullish(),
    latitude: z.number().min(-90).max(90).nullish(),
    longitude: z.number().min(-180).max(180).nullish(),
    mapUrl: z.url().max(500).nullish(),
    displayOrder: z.number().int().min(0).optional(),
    isActive: z.boolean().optional(),
  })
  .extend(seoInput.shape);

export const branchAdminRoutes = crudRoutes({
  entity: "branch",
  label: "Branch",
  model: Branch,
  create: branchInput,
  update: branchInput.partial(),
  search: ["name", "city"],
  sort: { displayOrder: 1, name: 1 },
  toDto: async (rows) => {
    const image = await loadImages(rows.flatMap((row) => [row.bannerImageId, row.thumbnailImageId, row.ogImageId]));
    return rows.map((row) => withImages(row, image));
  },
  prepare: async (data, existing) => (!existing && !data.slug ? { ...data, slug: await uniqueSlug(Branch, data.name) } : data),
  refs: { bannerImageId: Media, thumbnailImageId: Media, ogImageId: Media },
  // Every package (also archived and deleted ones) keeps its branch: a branch with packages can only be switched off.
  inUse: async (id) => !!(await Package.exists({ branchId: id })),
  onDelete: async (id) => {
    await Enquiry.updateMany({ branchId: id }, { $set: { branchId: null } });
  },
  tags: ["catalog"],
  // Branches shape the whole site: only admins create, edit or remove them.
  roles: { write: "ADMIN", delete: "ADMIN" },
  orderable: true,
});

// ---------------------------------------------------------------------------------------------
// Public

export function branchDto(row: BranchRow, image: (id: string | null) => ImageDto | null, packageCount?: number) {
  return {
    slug: row.slug,
    name: row.name,
    shortDescription: row.shortDescription,
    description: row.description,
    bannerImage: image(row.bannerImageId),
    thumbnailImage: image(row.thumbnailImageId),
    addressLines: row.addressLines,
    city: row.city,
    country: { code: row.countryCode, name: row.countryName },
    airport: row.airportCode ? { code: row.airportCode, city: row.airportCity ?? row.city } : null,
    phone: row.phone,
    whatsapp: row.whatsapp,
    email: row.email,
    mapUrl: row.mapUrl,
    latitude: row.latitude,
    longitude: row.longitude,
    ...(packageCount !== undefined && { packageCount }),
    seo: seoDto(row, image),
  };
}

export type BranchDto = ReturnType<typeof branchDto>;

const publishedPackages = { status: "PUBLISHED" as const, deletedAt: null };

/** Published packages per branch or destination id. */
export async function publishedCounts(field: "branchId" | "destinationId") {
  const groups = await Package.aggregate<{ _id: string; total: number }>([
    { $match: publishedPackages },
    { $group: { _id: `$${field}`, total: { $sum: 1 } } },
  ]);
  return new Map(groups.map((group) => [group._id, group.total]));
}

export async function listPublicBranches() {
  const rows = (await Branch.find({ isActive: true }).sort({ displayOrder: 1, name: 1 }).lean<BranchDoc[]>()).map(withId);
  const counts = await publishedCounts("branchId");
  const image = await loadImages(rows.flatMap((row) => [row.bannerImageId, row.thumbnailImageId, row.ogImageId]));
  return rows.map((row) => branchDto(row, image, counts.get(row.id) ?? 0));
}

export async function getPublicBranch(slug: string) {
  const doc = await Branch.findOne({ slug, isActive: true }).lean<BranchDoc>();
  if (!doc) throw notFound("Branch");
  const row = withId(doc);
  const total = await Package.countDocuments({ ...publishedPackages, branchId: row.id });
  const image = await loadImages([row.bannerImageId, row.thumbnailImageId, row.ogImageId]);
  return branchDto(row, image, total);
}
