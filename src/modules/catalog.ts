import { z } from "zod";
import { Activity, Category, Currency, Destination, Hotel, Media, Package, type ActivityDoc } from "../db/models.ts";
import { invalidReference } from "../lib/errors.ts";
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
  model: Category,
  create: categoryInput,
  update: categoryInput.partial(),
  search: ["name"],
  sort: { displayOrder: 1, name: 1 },
  toDto: async (rows) => rows,
  prepare: async (data, existing) => (!existing && !data.slug ? { ...data, slug: await uniqueSlug(Category, data.name) } : data),
  // Packages keep working without a category.
  onDelete: async (id) => {
    await Package.updateMany({ categoryId: id }, { $set: { categoryId: null } });
  },
  afterSave: (id) => refreshSearchText({ categoryId: id }),
  tags: ["catalog"],
  orderable: true,
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
  model: Hotel,
  create: hotelInput,
  update: hotelInput.partial(),
  search: ["name", "location"],
  sort: { name: 1 },
  filters: (query) => [query.active ? { isActive: query.active === "true" } : undefined],
  toDto: async (rows) => {
    const image = await loadImages(rows.map((row) => row.primaryImageId));
    return rows.map((row) => withImages(row, image));
  },
  prepare: async (data, existing) => (!existing && !data.slug ? { ...data, slug: await uniqueSlug(Hotel, data.name) } : data),
  refs: { primaryImageId: Media },
  // A hotel offered by a package cannot be deleted; itinerary days that stay there just lose the link.
  inUse: async (id) => !!(await Package.exists({ "hotels.hotelId": id })),
  onDelete: async (id) => {
    await Package.updateMany({ "itinerary.hotelId": id }, { $set: { "itinerary.$[day].hotelId": null } }, { arrayFilters: [{ "day.hotelId": id }] });
  },
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

type ActivityRow = Omit<ActivityDoc, "_id"> & { id: string };

export async function activityDtos(rows: ActivityRow[]) {
  const image = await loadImages(rows.map((row) => row.imageId));
  return rows.map((row) => ({
    ...row,
    image: image(row.imageId),
    prices: Object.fromEntries(row.prices.map((p) => [p.currencyCode, p.amount])),
  }));
}

export const activityAdminRoutes = crudRoutes({
  entity: "activity",
  label: "Activity",
  model: Activity,
  create: activityInput,
  update: activityInput.partial(),
  search: ["name", "location"],
  sort: { displayOrder: 1, name: 1 },
  filters: (query) => [query.destinationId ? { destinationId: query.destinationId } : undefined],
  toDto: (rows) => activityDtos(rows as ActivityRow[]),
  prepare: async (data, existing) => {
    if (data.prices?.length) {
      const codes = data.prices.map((p: { currencyCode: string }) => p.currencyCode);
      if ((await Currency.countDocuments({ _id: { $in: codes } })) !== codes.length) throw invalidReference("prices");
    }
    return !existing && !data.slug ? { ...data, slug: await uniqueSlug(Activity, data.name) } : data;
  },
  refs: { imageId: Media, destinationId: Destination },
  // An activity a package offers cannot be deleted; timeline entries that mention it just lose the link.
  inUse: async (id) => !!(await Package.exists({ activityIds: id })),
  onDelete: async (id) => {
    await Package.updateMany(
      { "itinerary.activities.activityId": id },
      { $set: { "itinerary.$[].activities.$[entry].activityId": null } },
      { arrayFilters: [{ "entry.activityId": id }] },
    );
  },
  tags: ["catalog"],
  orderable: true,
});
