import { and, asc, count, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import { db } from "../db/client.ts";
import { branches, packages } from "../db/schema.ts";
import { notFound } from "../lib/errors.ts";
import { crudRoutes, nullableText, optionalId } from "./crud.ts";
import { loadImages, type ImageDto } from "./media/dto.ts";
import { refreshSearchText } from "./packages/search-text.ts";
import { seoDto, seoInput, slugInput, uniqueSlug, withImages } from "./shared.ts";

type BranchRow = typeof branches.$inferSelect;

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
  table: branches,
  create: branchInput,
  update: branchInput.partial(),
  search: [branches.name, branches.city],
  orderBy: [asc(branches.displayOrder), asc(branches.name)],
  toDto: async (rows) => {
    const image = await loadImages(db, rows.flatMap((row) => [row.bannerImageId, row.thumbnailImageId, row.ogImageId]));
    return rows.map((row) => withImages(row, image));
  },
  prepare: async (data, existing) =>
    !existing && !data.slug ? { ...data, slug: await uniqueSlug(db, branches, branches.slug, data.name) } : data,
  afterSave: (tx, id) => refreshSearchText(tx, eq(packages.branchId, id)),
  tags: ["catalog"],
  // Branches shape the whole site: only admins create, edit or remove them.
  roles: { write: "ADMIN", delete: "ADMIN" },
  orderable: branches.displayOrder,
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

const publishedPackages = and(eq(packages.status, "PUBLISHED"), isNull(packages.deletedAt));

export async function listPublicBranches() {
  const rows = await db.select().from(branches).where(eq(branches.isActive, true)).orderBy(asc(branches.displayOrder), asc(branches.name));
  const counts = await db
    .select({ branchId: packages.branchId, total: count() })
    .from(packages)
    .where(publishedPackages)
    .groupBy(packages.branchId);
  const image = await loadImages(db, rows.flatMap((row) => [row.bannerImageId, row.thumbnailImageId, row.ogImageId]));
  return rows.map((row) => branchDto(row, image, counts.find((c) => c.branchId === row.id)?.total ?? 0));
}

export async function getPublicBranch(slug: string) {
  const [row] = await db.select().from(branches).where(and(eq(branches.slug, slug), eq(branches.isActive, true))).limit(1);
  if (!row) throw notFound("Branch");
  const [{ total }] = await db.select({ total: count() }).from(packages).where(and(publishedPackages, eq(packages.branchId, row.id)));
  const image = await loadImages(db, [row.bannerImageId, row.thumbnailImageId, row.ogImageId]);
  return branchDto(row, image, total);
}
