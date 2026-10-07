import { asc, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { db } from "../db/client.ts";
import { activities, activityPrices, hotels, packageCategories, packages } from "../db/schema.ts";
import { refreshSearchText } from "./packages/search-text.ts";
import { crudRoutes, nullableText, optionalId } from "./crud.ts";
import { loadImages } from "./media/dto.ts";
import { slugInput, uniqueSlug, withImages } from "./shared.ts";

/* Reusable catalogue items: package categories, hotels and bookable activities. */

// ---------------------------------------------------------------------------------------------
// Categories ("Family", "Honeymoon")

const categoryInput = z.object({
  name: z.string().trim().min(1).max(60),
  slug: slugInput.optional(),
  displayOrder: z.number().int().min(0).optional(),
});

export const categoryAdminRoutes = crudRoutes({
  entity: "package_category",
  label: "Category",
  table: packageCategories,
  create: categoryInput,
  update: categoryInput.partial(),
  search: [packageCategories.name],
  orderBy: [asc(packageCategories.displayOrder), asc(packageCategories.name)],
  toDto: async (rows) => rows,
  prepare: async (data, existing) =>
    !existing && !data.slug ? { ...data, slug: await uniqueSlug(db, packageCategories, packageCategories.slug, data.name) } : data,
  afterSave: (tx, id) => refreshSearchText(tx, eq(packages.categoryId, id)),
  tags: ["catalog"],
  orderable: packageCategories.displayOrder,
});

// ---------------------------------------------------------------------------------------------
// Hotels

const hotelInput = z.object({
  name: z.string().trim().min(1).max(120),
  slug: slugInput.optional(),
  starCategory: z.number().int().min(1).max(5).nullish(),
  rating: z.number().min(0).max(5).multipleOf(0.1).nullish(),
  description: z.string().trim().max(3000).optional(),
  location: z.string().trim().min(1).max(120),
  address: nullableText(300),
  primaryImageId: optionalId,
  isActive: z.boolean().optional(),
});

export const hotelAdminRoutes = crudRoutes({
  entity: "hotel",
  label: "Hotel",
  table: hotels,
  create: hotelInput,
  update: hotelInput.partial(),
  search: [hotels.name, hotels.location],
  orderBy: [asc(hotels.name)],
  filters: (query) => [query.active ? eq(hotels.isActive, query.active === "true") : undefined],
  toDto: async (rows) => {
    const image = await loadImages(db, rows.map((row) => row.primaryImageId));
    return rows.map((row) => withImages(row, image));
  },
  prepare: async (data, existing) =>
    !existing && !data.slug ? { ...data, slug: await uniqueSlug(db, hotels, hotels.slug, data.name) } : data,
  tags: ["catalog"],
});

// ---------------------------------------------------------------------------------------------
// Activities: reusable experiences (Desert Safari, Dhow Cruise), linked to packages and itinerary days.
// Activities tied to a destination and priced are offered as add-ons on that destination's page.

const activityInput = z.object({
  name: z.string().trim().min(1).max(120),
  slug: slugInput.optional(),
  description: z.string().trim().max(3000).optional(),
  imageId: optionalId,
  location: nullableText(120),
  destinationId: optionalId,
  displayOrder: z.number().int().min(0).optional(),
  isActive: z.boolean().optional(),
  /** Price per person when booked on its own, one per currency. Replaces the existing list when sent. */
  prices: z
    .array(z.object({ currencyCode: z.string().regex(/^[A-Z]{3}$/), amount: z.number().min(0).max(10_000_000) }))
    .max(10)
    .refine((list) => new Set(list.map((p) => p.currencyCode)).size === list.length, "One price per currency")
    .optional(),
});

export async function activityDtos(rows: (typeof activities.$inferSelect)[]) {
  const ids = rows.map((row) => row.id);
  const [image, prices] = await Promise.all([
    loadImages(db, rows.map((row) => row.imageId)),
    ids.length ? db.select().from(activityPrices).where(inArray(activityPrices.activityId, ids)) : [],
  ]);
  return rows.map((row) => ({
    ...row,
    image: image(row.imageId),
    prices: Object.fromEntries(prices.filter((p) => p.activityId === row.id).map((p) => [p.currencyCode, p.amount])),
  }));
}

export const activityAdminRoutes = crudRoutes({
  entity: "activity",
  label: "Activity",
  table: activities,
  create: activityInput,
  update: activityInput.partial(),
  search: [activities.name, activities.location],
  orderBy: [asc(activities.displayOrder), asc(activities.name)],
  filters: (query) => [query.destinationId ? eq(activities.destinationId, query.destinationId) : undefined],
  toDto: (rows) => activityDtos(rows as (typeof activities.$inferSelect)[]),
  childFields: ["prices"],
  prepare: async (data, existing) =>
    !existing && !data.slug ? { ...data, slug: await uniqueSlug(db, activities, activities.slug, data.name) } : data,
  afterSave: async (tx, id, data) => {
    if (!data.prices) return;
    await tx.delete(activityPrices).where(eq(activityPrices.activityId, id));
    if (data.prices.length) {
      await tx.insert(activityPrices).values(
        data.prices.map((p: { currencyCode: string; amount: number }) => ({ activityId: id, ...p })),
      );
    }
  },
  tags: ["catalog"],
  orderable: activities.displayOrder,
});
