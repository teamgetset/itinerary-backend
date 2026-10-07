import { and, count, desc, eq, ilike, inArray, isNull, or, type SQL } from "drizzle-orm";
import type { PgColumn, PgTable } from "drizzle-orm/pg-core";
import type { z } from "zod";
import { db, type Tx } from "../../db/client.ts";
import {
  activities,
  branches,
  currencies,
  destinations,
  hotels,
  itineraryActivities,
  itineraryDays,
  media,
  packageActivities,
  packageCategories,
  packageExclusions,
  packageHighlights,
  packageHotels,
  packageImages,
  packageInclusions,
  packagePrices,
  packages,
} from "../../db/schema.ts";
import { AppError, conflict, notFound } from "../../lib/errors.ts";
import { pageMeta, type AdminContext } from "../../lib/http.ts";
import { log } from "../../lib/logger.ts";
import { escapeLike } from "../../lib/text.ts";
import { audit } from "../audit.ts";
import { activeCurrencies } from "../currencies.ts";
import { loadImages } from "../media/dto.ts";
import { schedulePdfRefresh, ensureCurrentPdf } from "../pdf/service.ts";
import { revalidate } from "../revalidate.ts";
import { uniqueSlug, withImages } from "../shared.ts";
import type {
  activitiesInput,
  adminPackageQuery,
  createPackageInput,
  galleryInput,
  highlightsInput,
  hotelsInput,
  inclusionsInput,
  itineraryInput,
  pricesInput,
  updatePackageInput,
} from "./input.ts";
import { PRICE_TYPES, loadPackageGraph, priceTable, type PackageGraph } from "./read.ts";
import { refreshSearchText } from "./search-text.ts";

type PackageRow = typeof packages.$inferSelect;
const notDeleted = isNull(packages.deletedAt);

async function findPackage(id: string): Promise<PackageRow> {
  const [row] = await db.select().from(packages).where(and(eq(packages.id, id), notDeleted)).limit(1);
  if (!row) throw notFound("Package");
  return row;
}

/** Field-level error, shaped like validation errors so forms can show it next to the input. */
const fieldError = (path: string, message: string) => new AppError(400, "VALIDATION_ERROR", message, [{ path, message }]);

async function assertReferences(input: { branchId?: string; destinationId?: string; categoryId?: string | null; heroImageId?: string | null }) {
  const checks: [string | null | undefined, () => Promise<unknown[]>, string, string][] = [
    [input.branchId, () => db.select({ id: branches.id }).from(branches).where(eq(branches.id, input.branchId!)), "branchId", "Choose a branch."],
    [input.destinationId, () => db.select({ id: destinations.id }).from(destinations).where(eq(destinations.id, input.destinationId!)), "destinationId", "Choose a destination."],
    [input.categoryId, () => db.select({ id: packageCategories.id }).from(packageCategories).where(eq(packageCategories.id, input.categoryId!)), "categoryId", "That category no longer exists."],
    [input.heroImageId, () => db.select({ id: media.id }).from(media).where(and(eq(media.id, input.heroImageId!), eq(media.kind, "IMAGE"))), "heroImageId", "Choose an image from the media library."],
  ];
  for (const [value, query, path, message] of checks) {
    if (value && !(await query()).length) throw fieldError(path, message);
  }
}

/** After any content change: re-index search, refresh the site, and rebuild the PDF if the package is live. */
async function afterChange(pkg: Pick<PackageRow, "id" | "status">) {
  if (pkg.status === "PUBLISHED") {
    revalidate("catalog");
    schedulePdfRefresh(pkg.id);
  }
}

/**
 * Published packages may not be incomplete: an edit to a live package that would fail the publish
 * checklist is rolled back. (Unpublish first to rework it.) Runs inside the edit's transaction.
 */
async function assertStillPublishable(tx: Tx, id: string) {
  const graph = await loadPackageGraph(eq(packages.id, id), tx);
  const failed = graph ? (await publishChecklist(graph)).filter((item) => !item.ok) : [];
  if (failed.length) {
    throw new AppError(
      422,
      "PUBLISHED_INCOMPLETE",
      "This change would leave the live package incomplete. Complete it, or unpublish the package first.",
      failed.map((item) => ({ path: item.key, message: item.message ?? `${item.label} is incomplete.` })),
    );
  }
}

/** Marks the package as edited (updated_at, updated_by) when only a child list changed. */
const touch = (tx: Tx, id: string, admin: AdminContext) =>
  tx.update(packages).set({ updatedById: admin.id, updatedAt: new Date() }).where(eq(packages.id, id));

// ---------------------------------------------------------------------------------------------
// Admin list and editor

export async function listAdminPackages(query: z.infer<typeof adminPackageQuery>) {
  const where = and(
    notDeleted,
    query.status ? eq(packages.status, query.status) : undefined,
    query.branchId ? eq(packages.branchId, query.branchId) : undefined,
    query.destinationId ? eq(packages.destinationId, query.destinationId) : undefined,
    query.categoryId ? eq(packages.categoryId, query.categoryId) : undefined,
    query.featured ? eq(packages.isFeatured, query.featured === "true") : undefined,
    query.q
      ? or(
          ilike(packages.title, `%${escapeLike(query.q)}%`),
          ilike(packages.slug, `%${escapeLike(query.q)}%`),
          ilike(destinations.name, `%${escapeLike(query.q)}%`),
          ilike(branches.name, `%${escapeLike(query.q)}%`),
        )
      : undefined,
  );
  const from = () =>
    db
      .select({ pkg: packages, branch: branches, destination: destinations, category: packageCategories })
      .from(packages)
      .innerJoin(branches, eq(branches.id, packages.branchId))
      .innerJoin(destinations, eq(destinations.id, packages.destinationId))
      .leftJoin(packageCategories, eq(packageCategories.id, packages.categoryId));

  const [rows, [{ total }]] = await Promise.all([
    from()
      .where(where)
      .orderBy(desc(packages.updatedAt))
      .limit(query.pageSize)
      .offset((query.page - 1) * query.pageSize),
    db
      .select({ total: count() })
      .from(packages)
      .innerJoin(branches, eq(branches.id, packages.branchId))
      .innerJoin(destinations, eq(destinations.id, packages.destinationId))
      .where(where),
  ]);

  const ids = rows.map((row) => row.pkg.id);
  const [image, prices, active] = await Promise.all([
    loadImages(db, rows.map((row) => row.pkg.heroImageId)),
    ids.length ? db.select().from(packagePrices).where(inArray(packagePrices.packageId, ids)) : [],
    activeCurrencies(),
  ]);
  const codes = new Set(active.map((currency) => currency.code));
  const items = rows.map(({ pkg, branch, destination, category }) => ({
    id: pkg.id,
    slug: pkg.slug,
    title: pkg.title,
    status: pkg.status,
    branch: { id: branch.id, name: branch.name, slug: branch.slug },
    destination: { id: destination.id, name: destination.name, slug: destination.slug },
    category: category ? { id: category.id, name: category.name } : null,
    durationDays: pkg.durationDays,
    durationNights: pkg.durationNights,
    startingPrice: priceTable(prices.filter((p) => p.packageId === pkg.id), codes).ADULT,
    /** Every price, for the admin's pricing overview. */
    prices: priceTable(prices.filter((p) => p.packageId === pkg.id), codes),
    seo: { title: pkg.seoTitle, description: pkg.seoDescription, noindex: pkg.noindex },
    heroImage: image(pkg.heroImageId),
    isFeatured: pkg.isFeatured,
    isRecommended: pkg.isRecommended,
    publishedAt: pkg.publishedAt,
    updatedAt: pkg.updatedAt,
  }));
  return { items, meta: pageMeta(query.page, query.pageSize, total) };
}

export async function loadEditorGraph(id: string) {
  const graph = await loadPackageGraph(and(eq(packages.id, id), notDeleted)!);
  if (!graph) throw notFound("Package");
  return graph;
}

/** Everything the admin package editor needs, with ids for every reference. */
export async function packageEditorDto(graph: PackageGraph) {
  const image = await loadImages(db, [
    graph.heroImageId,
    graph.ogImageId,
    ...graph.images.map((row) => row.mediaId),
    ...graph.itineraryDays.map((day) => day.imageId),
  ]);
  const { branch, destination, category, images, highlights, inclusions, exclusions, prices, hotels: hotelRows, activities: activityRows, itineraryDays: days, searchText: _searchText, ...fields } = graph;
  return {
    ...withImages(fields, image),
    branch: { id: branch.id, name: branch.name, slug: branch.slug },
    destination: { id: destination.id, name: destination.name, slug: destination.slug },
    category: category ? { id: category.id, name: category.name } : null,
    gallery: images.map((row) => ({ mediaId: row.mediaId, image: image(row.mediaId) })),
    highlights: highlights.map(({ title, description, icon }) => ({ title, description, icon })),
    inclusions: inclusions.map(({ title, description }) => ({ title, description })),
    exclusions: exclusions.map(({ title, description }) => ({ title, description })),
    itinerary: days.map((day) => ({
      dayNumber: day.dayNumber,
      title: day.title,
      description: day.description,
      stay: day.stay,
      hotelId: day.hotelId,
      hotel: day.hotel ? { name: day.hotel.name } : null,
      meals: day.meals,
      imageId: day.imageId,
      image: image(day.imageId),
      activities: day.activities.map((activity) => ({
        time: activity.time?.slice(0, 5) ?? null,
        title: activity.title,
        description: activity.description,
        location: activity.location,
        type: activity.activityType,
        activityId: activity.activityId,
      })),
    })),
    prices: prices.map(({ currencyCode, priceType, amount }) => ({ currencyCode, priceType, amount })),
    hotels: hotelRows.map((row) => ({
      hotelId: row.hotelId,
      hotel: { name: row.hotel.name, starCategory: row.hotel.starCategory, location: row.hotel.location },
      nights: row.nights,
      roomType: row.roomType,
      mealPlan: row.mealPlan,
      isDefault: row.isDefault,
    })),
    activities: activityRows.map((row) => ({ activityId: row.activityId, activity: { name: row.activity.name } })),
  };
}

// ---------------------------------------------------------------------------------------------
// Create and update

export async function createPackage(input: z.infer<typeof createPackageInput>, admin: AdminContext) {
  await assertReferences(input);
  const id = await db.transaction(async (tx) => {
    const slug = input.slug ?? (await uniqueSlug(tx, packages, packages.slug, input.title));
    const [row] = await tx
      .insert(packages)
      .values({ ...input, slug, status: "DRAFT", createdById: admin.id, updatedById: admin.id })
      .returning({ id: packages.id });
    await refreshSearchText(tx, eq(packages.id, row!.id));
    await audit(tx, admin, "PACKAGE_CREATED", "package", row!.id, { title: input.title });
    return row!.id;
  });
  log.info("package.created", { packageId: id, adminUserId: admin.id });
  return id;
}

export async function updatePackage(id: string, input: z.infer<typeof updatePackageInput>, admin: AdminContext) {
  const existing = await findPackage(id);
  const days = input.durationDays ?? existing.durationDays;
  const nights = input.durationNights ?? existing.durationNights;
  if (nights > days) throw fieldError("durationNights", "Nights cannot be more than days.");
  await assertReferences(input);
  await db.transaction(async (tx) => {
    await tx.update(packages).set({ ...input, updatedById: admin.id }).where(eq(packages.id, id));
    if (existing.status === "PUBLISHED") await assertStillPublishable(tx, id);
    await refreshSearchText(tx, eq(packages.id, id));
    await audit(tx, admin, "PACKAGE_UPDATED", "package", id, { section: "details", fields: Object.keys(input) });
  });
  log.info("package.updated", { packageId: id, adminUserId: admin.id });
  await afterChange(existing);
}

/** Replaces one section of the package (highlights, itinerary, prices...) in a single transaction. */
async function replaceSection(id: string, admin: AdminContext, section: string, write: (tx: Tx) => Promise<void>) {
  const existing = await findPackage(id);
  await db.transaction(async (tx) => {
    await write(tx);
    if (existing.status === "PUBLISHED") await assertStillPublishable(tx, id);
    await touch(tx, id, admin);
    await audit(tx, admin, "PACKAGE_UPDATED", "package", id, { section });
  });
  log.info("package.updated", { packageId: id, adminUserId: admin.id, section });
  await afterChange(existing);
}

export const saveHighlights = (id: string, input: z.infer<typeof highlightsInput>, admin: AdminContext) =>
  replaceSection(id, admin, "highlights", async (tx) => {
    await tx.delete(packageHighlights).where(eq(packageHighlights.packageId, id));
    if (input.items.length) {
      await tx.insert(packageHighlights).values(input.items.map((item, index) => ({ ...item, packageId: id, displayOrder: index })));
    }
    await refreshSearchText(tx, eq(packages.id, id));
  });

export const saveInclusions = (id: string, input: z.infer<typeof inclusionsInput>, admin: AdminContext, kind: "inclusions" | "exclusions") =>
  replaceSection(id, admin, kind, async (tx) => {
    const table = kind === "inclusions" ? packageInclusions : packageExclusions;
    await tx.delete(table).where(eq(table.packageId, id));
    if (input.items.length) {
      await tx.insert(table).values(input.items.map((item, index) => ({ ...item, packageId: id, displayOrder: index })));
    }
  });

export async function saveItinerary(id: string, input: z.infer<typeof itineraryInput>, admin: AdminContext) {
  // References are checked up front so a bad hotel or activity gives a clear message, not a database error.
  const hotelIds = input.days.flatMap((day) => (day.hotelId ? [day.hotelId] : []));
  const activityIds = input.days.flatMap((day) => (day.activities ?? []).flatMap((a) => (a.activityId ? [a.activityId] : [])));
  const imageIds = input.days.flatMap((day) => (day.imageId ? [day.imageId] : []));
  await assertAllExist(hotels, hotels.id, hotelIds, "days", "A selected hotel no longer exists.");
  await assertAllExist(activities, activities.id, activityIds, "days", "A linked activity no longer exists.");
  await assertAllExist(media, media.id, imageIds, "days", "A day image no longer exists.");

  await replaceSection(id, admin, "itinerary", async (tx) => {
    // Activities go with their days (on delete cascade).
    await tx.delete(itineraryDays).where(eq(itineraryDays.packageId, id));
    for (const [index, day] of input.days.entries()) {
      const { activities: dayActivities = [], ...fields } = day;
      const [created] = await tx
        .insert(itineraryDays)
        .values({ ...fields, packageId: id, dayNumber: index + 1 })
        .returning({ id: itineraryDays.id });
      if (dayActivities.length) {
        await tx.insert(itineraryActivities).values(
          dayActivities.map(({ type, ...activity }, order) => ({
            ...activity,
            activityType: type,
            itineraryDayId: created!.id,
            displayOrder: order,
          })),
        );
      }
    }
  });
}

export async function savePrices(id: string, input: z.infer<typeof pricesInput>, admin: AdminContext) {
  const known = new Set((await db.select({ code: currencies.code }).from(currencies)).map((row) => row.code));
  input.prices.forEach((price, index) => {
    if (!known.has(price.currencyCode)) throw fieldError(`prices.${index}.currencyCode`, `${price.currencyCode} is not a supported currency.`);
  });
  await replaceSection(id, admin, "pricing", async (tx) => {
    await tx.delete(packagePrices).where(eq(packagePrices.packageId, id));
    if (input.prices.length) await tx.insert(packagePrices).values(input.prices.map((price) => ({ ...price, packageId: id })));
  });
}

export async function saveHotels(id: string, input: z.infer<typeof hotelsInput>, admin: AdminContext) {
  await assertAllExist(hotels, hotels.id, input.hotels.map((h) => h.hotelId), "hotels", "A selected hotel no longer exists.");
  await replaceSection(id, admin, "hotels", async (tx) => {
    await tx.delete(packageHotels).where(eq(packageHotels.packageId, id));
    if (input.hotels.length) {
      await tx.insert(packageHotels).values(input.hotels.map((hotel, index) => ({ ...hotel, packageId: id, displayOrder: index })));
    }
  });
}

export async function saveActivities(id: string, input: z.infer<typeof activitiesInput>, admin: AdminContext) {
  await assertAllExist(activities, activities.id, input.activityIds, "activityIds", "A selected activity no longer exists.");
  await replaceSection(id, admin, "activities", async (tx) => {
    await tx.delete(packageActivities).where(eq(packageActivities.packageId, id));
    if (input.activityIds.length) {
      await tx.insert(packageActivities).values(input.activityIds.map((activityId, index) => ({ packageId: id, activityId, displayOrder: index })));
    }
  });
}

export async function saveGallery(id: string, input: z.infer<typeof galleryInput>, admin: AdminContext) {
  await assertAllExist(media, media.id, input.mediaIds, "mediaIds", "A selected photo no longer exists.");
  await replaceSection(id, admin, "gallery", async (tx) => {
    await tx.delete(packageImages).where(eq(packageImages.packageId, id));
    if (input.mediaIds.length) {
      await tx.insert(packageImages).values(input.mediaIds.map((mediaId, index) => ({ packageId: id, mediaId, displayOrder: index })));
    }
  });
}

async function assertAllExist(table: PgTable, column: PgColumn, ids: string[], path: string, message: string) {
  const unique = [...new Set(ids)];
  if (!unique.length) return;
  const found = await db.select({ id: column }).from(table).where(inArray(column, unique));
  if (found.length !== unique.length) throw fieldError(path, message);
}

// ---------------------------------------------------------------------------------------------
// Publishing

export interface ChecklistItem {
  key: string;
  label: string;
  ok: boolean;
  message?: string;
}

const PRICE_LABEL = { ADULT: "Adult", CHILD: "Child", INFANT: "Infant" } as const;

/** Drafts may be incomplete; published packages may not. Every item must pass before publishing. */
export async function publishChecklist(graph: PackageGraph): Promise<ChecklistItem[]> {
  const active = await activeCurrencies();
  const missingPrices = active.flatMap((currency) =>
    PRICE_TYPES.filter((type) => !graph.prices.some((p) => p.currencyCode === currency.code && p.priceType === type)).map(
      (type) => `${PRICE_LABEL[type]} ${currency.code}`,
    ),
  );
  const days = graph.itineraryDays.length;
  return [
    { key: "branch", label: "Branch", ok: graph.branch.isActive, message: graph.branch.isActive ? undefined : `${graph.branch.name} branch is switched off.` },
    { key: "destination", label: "Destination", ok: graph.destination.isActive, message: graph.destination.isActive ? undefined : `${graph.destination.name} is switched off.` },
    { key: "title", label: "Package title and slug", ok: !!graph.title && !!graph.slug },
    { key: "heroImage", label: "Hero image", ok: !!graph.heroImageId, message: graph.heroImageId ? undefined : "Add a hero image." },
    { key: "description", label: "Overview", ok: !!graph.description.trim(), message: graph.description.trim() ? undefined : "Write an overview." },
    { key: "duration", label: "Duration", ok: graph.durationDays > 0 && graph.durationNights <= graph.durationDays },
    {
      key: "pricing",
      label: "Pricing (adult, child and infant in every currency)",
      ok: missingPrices.length === 0,
      message: missingPrices.length ? `Missing: ${missingPrices.join(", ")}.` : undefined,
    },
    {
      key: "itinerary",
      label: "Day-by-day itinerary",
      ok: days > 0 && days <= graph.durationDays,
      message:
        days === 0
          ? "At least one itinerary day is required before publishing."
          : days > graph.durationDays
            ? `The itinerary has ${days} days but the package lasts ${graph.durationDays}.`
            : undefined,
    },
  ];
}

export async function publishPackage(id: string, admin: AdminContext) {
  const graph = await loadEditorGraph(id);
  const checklist = await publishChecklist(graph);
  const failed = checklist.filter((item) => !item.ok);
  if (failed.length) {
    throw new AppError(422, "PUBLISH_BLOCKED", "This package is not ready to publish", failed.map((item) => ({ path: item.key, message: item.message ?? `${item.label} is incomplete.` })));
  }
  // The PDF is part of a published package: build it (if this content has none yet) before going live.
  const pdf = await ensureCurrentPdf(id, admin);
  await db.transaction(async (tx) => {
    await tx
      .update(packages)
      .set({ status: "PUBLISHED", publishedAt: graph.publishedAt ?? new Date(), updatedById: admin.id })
      .where(eq(packages.id, id));
    await audit(tx, admin, "PACKAGE_PUBLISHED", "package", id, { pdfVersion: pdf.version });
  });
  log.info("package.published", { packageId: id, adminUserId: admin.id, pdfVersion: pdf.version });
  revalidate("catalog");
}

export async function setPackageStatus(id: string, status: "DRAFT" | "ARCHIVED", admin: AdminContext) {
  const existing = await findPackage(id);
  const action = status === "DRAFT" ? "PACKAGE_UNPUBLISHED" : "PACKAGE_ARCHIVED";
  await db.transaction(async (tx) => {
    await tx.update(packages).set({ status, updatedById: admin.id }).where(eq(packages.id, id));
    await audit(tx, admin, action, "package", id, { from: existing.status });
  });
  log.info(status === "DRAFT" ? "package.unpublished" : "package.archived", { packageId: id, adminUserId: admin.id });
  if (existing.status === "PUBLISHED") revalidate("catalog");
}

/** Soft delete. The slug is released so it can be reused; history (enquiries, audit) keeps pointing at the row. */
export async function deletePackage(id: string, admin: AdminContext) {
  const existing = await findPackage(id);
  if (existing.status === "PUBLISHED") throw conflict("PACKAGE_PUBLISHED", "Unpublish or archive the package before deleting it.");
  await db.transaction(async (tx) => {
    await tx
      .update(packages)
      .set({ deletedAt: new Date(), slug: `${existing.slug}-deleted-${Date.now().toString(36)}`, updatedById: admin.id })
      .where(eq(packages.id, id));
    await audit(tx, admin, "PACKAGE_DELETED", "package", id, { slug: existing.slug });
  });
}

/** A new draft with the same content, so a similar trip can start from an existing one. */
export async function duplicatePackage(id: string, admin: AdminContext) {
  const graph = await loadEditorGraph(id);
  const newId = await db.transaction(async (tx) => {
    const {
      id: _id, slug, title, status: _status, publishedAt: _p, createdAt: _c, updatedAt: _u, deletedAt: _d,
      branch: _b, destination: _de, category: _ca, images, highlights, inclusions, exclusions, prices, hotels: hotelRows,
      activities: activityRows, itineraryDays: days, ...fields
    } = graph;
    const [copy] = await tx
      .insert(packages)
      .values({
        ...fields,
        title: `${title} (copy)`,
        slug: await uniqueSlug(tx, packages, packages.slug, `${slug}-copy`),
        status: "DRAFT",
        isFeatured: false,
        createdById: admin.id,
        updatedById: admin.id,
      })
      .returning({ id: packages.id });
    const to = copy!.id;
    const strip = <T extends { id?: string; packageId?: string }>({ id: _x, packageId: _y, ...rest }: T) => ({ ...rest, packageId: to });
    if (images.length) await tx.insert(packageImages).values(images.map(({ packageId: _y, ...rest }) => ({ ...rest, packageId: to })));
    if (highlights.length) await tx.insert(packageHighlights).values(highlights.map(strip));
    if (inclusions.length) await tx.insert(packageInclusions).values(inclusions.map(strip));
    if (exclusions.length) await tx.insert(packageExclusions).values(exclusions.map(strip));
    if (prices.length) await tx.insert(packagePrices).values(prices.map(({ id: _x, packageId: _y, createdAt: _c2, updatedAt: _u2, ...rest }) => ({ ...rest, packageId: to })));
    if (hotelRows.length) await tx.insert(packageHotels).values(hotelRows.map(({ id: _x, packageId: _y, hotel: _h, ...rest }) => ({ ...rest, packageId: to })));
    if (activityRows.length) await tx.insert(packageActivities).values(activityRows.map(({ packageId: _y, activity: _a, ...rest }) => ({ ...rest, packageId: to })));
    for (const { id: _x, packageId: _y, hotel: _h, activities: dayActivities, createdAt: _c3, updatedAt: _u3, ...day } of days) {
      const [createdDay] = await tx.insert(itineraryDays).values({ ...day, packageId: to }).returning({ id: itineraryDays.id });
      if (dayActivities.length) {
        await tx.insert(itineraryActivities).values(dayActivities.map(({ id: _z, itineraryDayId: _w, ...rest }) => ({ ...rest, itineraryDayId: createdDay!.id })));
      }
    }
    await refreshSearchText(tx, eq(packages.id, to));
    await audit(tx, admin, "PACKAGE_DUPLICATED", "package", to, { from: id });
    return to;
  });
  return newId;
}

/** Re-index packages after a branch, destination or category is renamed. */
export const reindexPackages = (where: SQL) => refreshSearchText(db, and(where, notDeleted)!);

