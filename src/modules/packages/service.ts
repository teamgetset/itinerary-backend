import type { Model } from "mongoose";
import type { z } from "zod";
import { transaction } from "../../db/client.ts";
import {
  Activity,
  Branch,
  Category,
  Currency,
  Destination,
  Hotel,
  Media,
  Package,
  defined,
  withId,
  type BranchDoc,
  type CategoryDoc,
  type DestinationDoc,
  type MediaDoc,
  type PackageDoc,
} from "../../db/models.ts";
import { AppError, invalidReference, notFound } from "../../lib/errors.ts";
import { pageMeta, type AdminContext } from "../../lib/http.ts";
import { log } from "../../lib/logger.ts";
import { contains } from "../../lib/text.ts";
import { audit } from "../audit.ts";
import { activeCurrencies } from "../currencies.ts";
import { loadImages } from "../media/dto.ts";
import { itineraryPdfInfo } from "../pdf/itinerary-pdf.ts";
import { revalidate } from "../revalidate.ts";
import { uniqueSlug, withImages } from "../shared.ts";
import type {
  activitiesInput,
  adminPackageQuery,
  createPackageInput,
  galleryInput,
  highlightsInput,
  hotelsInput,
  importantInfoInput,
  inclusionsInput,
  itineraryInput,
  pricesInput,
  updatePackageInput,
} from "./input.ts";
import { getContentBlock } from "../content.ts";
import { PRICE_TYPES, loadPackageGraph, packageInfo, priceTable, type PackageGraph } from "./read.ts";
import { refreshSearchText } from "./search-text.ts";

type PackageRow = Omit<PackageDoc, "_id"> & { id: string };
const notDeleted = { deletedAt: null };

async function findPackage(id: string): Promise<PackageRow> {
  const doc = await Package.findOne({ _id: id, ...notDeleted }).lean<PackageDoc>();
  if (!doc) throw notFound("Package");
  return withId(doc);
}

/** Field-level error, shaped like validation errors so forms can show it next to the input. */
const fieldError = (path: string, message: string) => new AppError(400, "VALIDATION_ERROR", message, [{ path, message }]);

async function assertReferences(input: { branchId?: string; destinationId?: string; categoryId?: string | null; heroImageId?: string | null; ogImageId?: string | null }) {
  const checks: [string | null | undefined, () => Promise<unknown>, string, string][] = [
    [input.branchId, () => Branch.exists({ _id: input.branchId }), "branchId", "Choose a branch."],
    [input.destinationId, () => Destination.exists({ _id: input.destinationId }), "destinationId", "Choose a destination."],
    [input.categoryId, () => Category.exists({ _id: input.categoryId }), "categoryId", "That category no longer exists."],
    [input.heroImageId, () => Media.exists({ _id: input.heroImageId, kind: "IMAGE" }), "heroImageId", "Choose an image from the media library."],
  ];
  for (const [value, query, path, message] of checks) {
    if (value && !(await query())) throw fieldError(path, message);
  }
  if (input.ogImageId && !(await Media.exists({ _id: input.ogImageId }))) throw invalidReference("ogImageId");
}

/** After any content change: refresh the site if the package is live. */
async function afterChange(pkg: Pick<PackageRow, "id" | "status">) {
  if (pkg.status === "PUBLISHED") revalidate("catalog");
}

/** Marks the package as edited (updatedAt, updatedById) when only a section changed. */
const touch = (id: string, admin: AdminContext) => Package.updateOne({ _id: id }, { $set: { updatedById: admin.id } });

// ---------------------------------------------------------------------------------------------
// Admin list and editor

export async function listAdminPackages(query: z.infer<typeof adminPackageQuery>) {
  const filter: Record<string, unknown> = {
    ...notDeleted,
    ...defined({ status: query.status, branchId: query.branchId, destinationId: query.destinationId, categoryId: query.categoryId }),
    ...(query.featured && { isFeatured: query.featured === "true" }),
  };
  if (query.q) {
    // Title, slug, or the name of its destination or branch.
    const [destinations, branches] = [
      await Destination.find({ name: contains(query.q) }, { _id: 1 }).lean<{ _id: string }[]>(),
      await Branch.find({ name: contains(query.q) }, { _id: 1 }).lean<{ _id: string }[]>(),
    ];
    filter.$or = [
      { title: contains(query.q) },
      { slug: contains(query.q) },
      { destinationId: { $in: destinations.map((row) => row._id) } },
      { branchId: { $in: branches.map((row) => row._id) } },
    ];
  }
  const [docs, total] = await Promise.all([
    Package.find(filter)
      .sort({ updatedAt: -1 })
      .skip((query.page - 1) * query.pageSize)
      .limit(query.pageSize)
      .lean<PackageDoc[]>(),
    Package.countDocuments(filter),
  ]);

  const ids = (field: "branchId" | "destinationId" | "categoryId") => [...new Set(docs.map((doc) => doc[field]).filter((id): id is string => !!id))];
  const pdfIds = docs.flatMap((doc) => [doc.itineraryPdfId, doc.itineraryPdfWithoutLogoId]).filter((id): id is string => !!id);
  const [branches, destinations, categories, image, active, pdfs] = await Promise.all([
    Branch.find({ _id: { $in: ids("branchId") } }).lean<BranchDoc[]>(),
    Destination.find({ _id: { $in: ids("destinationId") } }).lean<DestinationDoc[]>(),
    Category.find({ _id: { $in: ids("categoryId") } }).lean<CategoryDoc[]>(),
    loadImages(docs.map((doc) => doc.heroImageId)),
    activeCurrencies(),
    pdfIds.length ? Media.find({ _id: { $in: pdfIds }, deletedAt: null }, { fileName: 1, sizeBytes: 1, createdAt: 1 }).lean<MediaDoc[]>() : [],
  ]);
  const byId = <T extends { _id: string }>(rows: T[]) => new Map(rows.map((row) => [row._id, row]));
  const [branchById, destinationById, categoryById, pdfById] = [byId(branches), byId(destinations), byId(categories), byId(pdfs)];
  const codes = new Set(active.map((currency) => currency.code));
  const items = docs.map((pkg) => {
    const branch = branchById.get(pkg.branchId)!;
    const destination = destinationById.get(pkg.destinationId)!;
    const category = pkg.categoryId ? categoryById.get(pkg.categoryId) : undefined;
    const pdfSummary = (mediaId: string | null | undefined) => {
      const pdf = mediaId ? pdfById.get(mediaId) : undefined;
      return pdf ? { fileName: pdf.fileName, sizeBytes: pdf.sizeBytes, uploadedAt: pdf.createdAt } : null;
    };
    return {
      id: pkg._id,
      slug: pkg.slug,
      title: pkg.title,
      status: pkg.status,
      branch: { id: branch._id, name: branch.name, slug: branch.slug },
      destination: { id: destination._id, name: destination.name, slug: destination.slug },
      category: category ? { id: category._id, name: category.name } : null,
      durationDays: pkg.durationDays,
      durationNights: pkg.durationNights,
      startingPrice: priceTable(pkg.prices, codes).ADULT,
      /** Every price, for the admin's pricing overview. */
      prices: priceTable(pkg.prices, codes),
      seo: { title: pkg.seoTitle, description: pkg.seoDescription, noindex: pkg.noindex },
      heroImage: image(pkg.heroImageId),
      itineraryPdf: pdfSummary(pkg.itineraryPdfId),
      itineraryPdfWithoutLogo: pdfSummary(pkg.itineraryPdfWithoutLogoId),
      isFeatured: pkg.isFeatured,
      isRecommended: pkg.isRecommended,
      publishedAt: pkg.publishedAt,
      updatedAt: pkg.updatedAt,
    };
  });
  return { items, meta: pageMeta(query.page, query.pageSize, total) };
}

export async function loadEditorGraph(id: string) {
  const graph = await loadPackageGraph({ _id: id, ...notDeleted });
  if (!graph) throw notFound("Package");
  return graph;
}

/** Everything the admin package editor needs, with ids for every reference. */
export async function packageEditorDto(graph: PackageGraph) {
  const image = await loadImages([graph.heroImageId, graph.ogImageId, ...graph.gallery, ...graph.itinerary.map((day) => day.imageId)]);
  const {
    branch,
    destination,
    category,
    gallery,
    highlights,
    inclusions,
    exclusions,
    prices,
    hotels: hotelRows,
    activities: activityRows,
    activityIds: _activityIds,
    itinerary: days,
    searchText: _searchText,
    ...fields
  } = graph;
  return {
    ...withImages(fields, image),
    branch: { id: branch.id, name: branch.name, slug: branch.slug },
    destination: { id: destination.id, name: destination.name, slug: destination.slug },
    category: category ? { id: category.id, name: category.name } : null,
    gallery: gallery.map((mediaId) => ({ mediaId, image: image(mediaId) })),
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
        type: activity.type,
        activityId: activity.activityId,
      })),
    })),
    prices: prices.map(({ currencyCode, priceType, amount }) => ({ currencyCode, priceType, amount })),
    hotels: hotelRows.map((row) => ({
      hotelId: row.hotelId,
      hotel: row.hotel ? { name: row.hotel.name, starCategory: row.hotel.starCategory, location: row.hotel.location } : null,
      nights: row.nights,
      roomType: row.roomType,
      mealPlan: row.mealPlan,
      isDefault: row.isDefault,
    })),
    activities: activityRows.map((row) => ({ activityId: row.activityId, activity: { name: row.activity.name } })),
    itineraryPdf: await itineraryPdfInfo(graph.itineraryPdfId),
    itineraryPdfWithoutLogo: await itineraryPdfInfo(graph.itineraryPdfWithoutLogoId ?? null),
    // Exactly what the package page shows under "Good to know" and "Important information", and whether those are
    // already the package's own lists or still the shared content (see packageInfo).
    ...packageInfo(graph, await getContentBlock("package.defaults")),
    ownInfo: !!graph.ownInfo,
  };
}

// ---------------------------------------------------------------------------------------------
// Create and update

export async function createPackage(input: z.infer<typeof createPackageInput>, admin: AdminContext) {
  await assertReferences(input);
  const id = await transaction(async () => {
    const slug = input.slug ?? (await uniqueSlug(Package, input.title));
    const [created] = await Package.create([{ ...defined(input), slug, status: "DRAFT", createdById: admin.id, updatedById: admin.id }]);
    const createdId = created!._id as string;
    await refreshSearchText({ _id: createdId });
    await audit(admin, "PACKAGE_CREATED", "package", createdId, { title: input.title });
    return createdId;
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
  await transaction(async () => {
    await Package.updateOne({ _id: id }, { $set: { ...defined(input), updatedById: admin.id } });
    await refreshSearchText({ _id: id });
    await audit(admin, "PACKAGE_UPDATED", "package", id, { section: "details", fields: Object.keys(input) });
  });
  log.info("package.updated", { packageId: id, adminUserId: admin.id });
  await afterChange(existing);
}

/** Replaces one section of the package (highlights, itinerary, prices...) in a single transaction. */
async function replaceSection(id: string, admin: AdminContext, section: string, write: () => Promise<unknown>) {
  const existing = await findPackage(id);
  await transaction(async () => {
    await write();
    await touch(id, admin);
    await audit(admin, "PACKAGE_UPDATED", "package", id, { section });
  });
  log.info("package.updated", { packageId: id, adminUserId: admin.id, section });
  await afterChange(existing);
}

const setSection = (id: string, fields: Partial<PackageDoc>) => Package.updateOne({ _id: id }, { $set: fields });

export const saveHighlights = (id: string, input: z.infer<typeof highlightsInput>, admin: AdminContext) =>
  replaceSection(id, admin, "highlights", async () => {
    await setSection(id, {
      highlights: input.items.map((item) => ({ title: item.title, description: item.description ?? null, icon: item.icon ?? null })),
    });
    await refreshSearchText({ _id: id });
  });

export const saveListSection = (id: string, input: z.infer<typeof inclusionsInput>, admin: AdminContext, kind: "inclusions" | "exclusions") =>
  replaceSection(id, admin, kind, () => setSection(id, { [kind]: input.items.map((item) => ({ title: item.title, description: item.description ?? null })) }));

/** The package's "Good to know" and "Important information" as shown now (packageInfo). */
const shownInfo = async (id: string) => packageInfo(await loadEditorGraph(id), await getContentBlock("package.defaults"));

/**
 * Saving either list gives the package its own copy of both (ownInfo): from then on its page shows exactly what was
 * saved, and changes to the shared content no longer affect it. The other list is kept as it is shown now.
 */
export async function saveGoodToKnow(id: string, input: z.infer<typeof inclusionsInput>, admin: AdminContext) {
  const { importantInfo } = await shownInfo(id);
  const goodToKnow = input.items.map((item) => ({ title: item.title, description: item.description ?? null }));
  await replaceSection(id, admin, "goodToKnow", () => setSection(id, { goodToKnow, importantInfo, ownInfo: true }));
}

export async function saveImportantInfo(id: string, input: z.infer<typeof importantInfoInput>, admin: AdminContext) {
  const { goodToKnow } = await shownInfo(id);
  await replaceSection(id, admin, "importantInfo", () => setSection(id, { importantInfo: input.items, goodToKnow, ownInfo: true }));
}

export async function saveItinerary(id: string, input: z.infer<typeof itineraryInput>, admin: AdminContext) {
  // References are checked up front so a bad hotel or activity gives a clear message, not a broken link.
  const hotelIds = input.days.flatMap((day) => (day.hotelId ? [day.hotelId] : []));
  const activityIds = input.days.flatMap((day) => (day.activities ?? []).flatMap((a) => (a.activityId ? [a.activityId] : [])));
  const imageIds = input.days.flatMap((day) => (day.imageId ? [day.imageId] : []));
  await assertAllExist(Hotel, hotelIds, "days", "A selected hotel no longer exists.");
  await assertAllExist(Activity, activityIds, "days", "A linked activity no longer exists.");
  await assertAllExist(Media, imageIds, "days", "A day image no longer exists.");

  await replaceSection(id, admin, "itinerary", () =>
    setSection(id, {
      itinerary: input.days.map((day, index) => ({
        dayNumber: index + 1,
        title: day.title,
        description: day.description ?? "",
        stay: day.stay ?? null,
        hotelId: day.hotelId ?? null,
        meals: day.meals ?? [],
        imageId: day.imageId ?? null,
        activities: (day.activities ?? []).map((activity) => ({
          time: activity.time ?? null,
          title: activity.title,
          description: activity.description ?? null,
          location: activity.location ?? null,
          type: activity.type ?? "OTHER",
          activityId: activity.activityId ?? null,
        })),
      })),
    }),
  );
}

export async function savePrices(id: string, input: z.infer<typeof pricesInput>, admin: AdminContext) {
  const known = new Set((await Currency.find({}, { _id: 1 }).lean<{ _id: string }[]>()).map((row) => row._id));
  input.prices.forEach((price, index) => {
    if (!known.has(price.currencyCode)) throw fieldError(`prices.${index}.currencyCode`, `${price.currencyCode} is not a supported currency.`);
  });
  await replaceSection(id, admin, "pricing", () =>
    setSection(id, { prices: input.prices.map(({ currencyCode, priceType, amount }) => ({ currencyCode, priceType, amount })) }),
  );
}

export async function saveHotels(id: string, input: z.infer<typeof hotelsInput>, admin: AdminContext) {
  // A row with nothing filled in is dropped rather than stored empty.
  const rows = input.hotels.filter((hotel) => hotel.hotelId || hotel.nights || hotel.roomType || hotel.mealPlan);
  await assertAllExist(Hotel, rows.flatMap((h) => (h.hotelId ? [h.hotelId] : [])), "hotels", "A selected hotel no longer exists.");
  await replaceSection(id, admin, "hotels", () =>
    setSection(id, {
      hotels: rows.map((hotel) => ({
        hotelId: hotel.hotelId ?? null,
        nights: hotel.nights ?? null,
        roomType: hotel.roomType ?? null,
        mealPlan: hotel.mealPlan ?? null,
        isDefault: hotel.isDefault ?? true,
      })),
    }),
  );
}

export async function saveActivities(id: string, input: z.infer<typeof activitiesInput>, admin: AdminContext) {
  await assertAllExist(Activity, input.activityIds, "activityIds", "A selected activity no longer exists.");
  await replaceSection(id, admin, "activities", () => setSection(id, { activityIds: input.activityIds }));
}

export async function saveGallery(id: string, input: z.infer<typeof galleryInput>, admin: AdminContext) {
  await assertAllExist(Media, input.mediaIds, "mediaIds", "A selected photo no longer exists.");
  await replaceSection(id, admin, "gallery", () => setSection(id, { gallery: input.mediaIds }));
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function assertAllExist(model: Model<any>, ids: string[], path: string, message: string) {
  const unique = [...new Set(ids)];
  if (unique.length && (await model.countDocuments({ _id: { $in: unique } })) !== unique.length) throw fieldError(path, message);
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

/** What the admin is shown as done or still missing. Guidance only: publishing never requires it (see publishPackage). */
export async function publishChecklist(graph: PackageGraph): Promise<ChecklistItem[]> {
  const active = await activeCurrencies();
  const missingPrices = active.flatMap((currency) =>
    PRICE_TYPES.filter((type) => !graph.prices.some((p) => p.currencyCode === currency.code && p.priceType === type)).map(
      (type) => `${PRICE_LABEL[type]} ${currency.code}`,
    ),
  );
  const days = graph.itinerary.length;
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
          ? "Add at least one itinerary day."
          : days > graph.durationDays
            ? `The itinerary has ${days} days but the package lasts ${graph.durationDays}.`
            : undefined,
    },
    // Only the version with the logo is listed; the one without it is an extra choice for customers.
    { key: "itineraryPdf", label: "Itinerary PDF with logo", ok: !!graph.itineraryPdfId, message: graph.itineraryPdfId ? undefined : "Upload the itinerary PDF with the logo." },
  ];
}

/**
 * Publishes the package whatever its checklist says: the checklist is guidance for the admin, not a gate. Items still
 * incomplete are recorded with the publication, and the website shows only the parts that are filled in.
 */
export async function publishPackage(id: string, admin: AdminContext) {
  const graph = await loadEditorGraph(id);
  const incomplete = (await publishChecklist(graph)).filter((item) => !item.ok).map((item) => item.key);
  await transaction(async () => {
    await Package.updateOne({ _id: id }, { $set: { status: "PUBLISHED", publishedAt: graph.publishedAt ?? new Date(), updatedById: admin.id } });
    await audit(admin, "PACKAGE_PUBLISHED", "package", id, {
      itineraryPdfId: graph.itineraryPdfId,
      itineraryPdfWithoutLogoId: graph.itineraryPdfWithoutLogoId ?? null,
      ...(incomplete.length && { incomplete }),
    });
  });
  log.info("package.published", { packageId: id, adminUserId: admin.id, ...(incomplete.length && { incomplete }) });
  revalidate("catalog");
}

export async function setPackageStatus(id: string, status: "DRAFT" | "ARCHIVED", admin: AdminContext) {
  const existing = await findPackage(id);
  const action = status === "DRAFT" ? "PACKAGE_UNPUBLISHED" : "PACKAGE_ARCHIVED";
  await transaction(async () => {
    await Package.updateOne({ _id: id }, { $set: { status, updatedById: admin.id } });
    await audit(admin, action, "package", id, { from: existing.status });
  });
  log.info(status === "DRAFT" ? "package.unpublished" : "package.archived", { packageId: id, adminUserId: admin.id });
  if (existing.status === "PUBLISHED") revalidate("catalog");
}

/**
 * Soft delete, whatever the status: the package leaves the admin and the website. The slug is released so it can be
 * reused; history (enquiries, audit) keeps pointing at the document.
 */
export async function deletePackage(id: string, admin: AdminContext) {
  const existing = await findPackage(id);
  await transaction(async () => {
    await Package.updateOne(
      { _id: id },
      { $set: { deletedAt: new Date(), slug: `${existing.slug}-deleted-${Date.now().toString(36)}`, updatedById: admin.id } },
    );
    await audit(admin, "PACKAGE_DELETED", "package", id, { slug: existing.slug, from: existing.status });
  });
  if (existing.status === "PUBLISHED") revalidate("catalog");
}

/** A new draft with the same content, so a similar trip can start from an existing one. */
export async function duplicatePackage(id: string, admin: AdminContext) {
  const graph = await loadEditorGraph(id);
  return transaction(async () => {
    const {
      id: _id, slug, title, status: _status, publishedAt: _p, createdAt: _c, updatedAt: _u, deletedAt: _d,
      // Each package owns its PDF files (replacing or removing one deletes the file), so a copy starts without them.
      itineraryPdfId: _pdf,
      itineraryPdfWithoutLogoId: _pdfWithoutLogo,
      branch: _b, destination: _de, category: _ca, activities: _a, hotels, itinerary, ...fields
    } = graph;
    const [copy] = await Package.create([
      {
        ...fields,
        hotels: hotels.map(({ hotel: _h, ...row }) => row),
        itinerary: itinerary.map(({ hotel: _h, ...day }) => ({ ...day, activities: day.activities.map(({ activity: _a, ...entry }) => entry) })),
        title: `${title} (copy)`,
        slug: await uniqueSlug(Package, `${slug}-copy`),
        status: "DRAFT",
        isFeatured: false,
        createdById: admin.id,
        updatedById: admin.id,
      },
    ]);
    const copyId = copy!._id as string;
    await refreshSearchText({ _id: copyId });
    await audit(admin, "PACKAGE_DUPLICATED", "package", copyId, { from: id });
    return copyId;
  });
}

/** Re-index packages after a branch, destination or category is renamed. */
export const reindexPackages = (filter: Record<string, unknown>) => refreshSearchText({ ...filter, ...notDeleted });
