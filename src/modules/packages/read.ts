import { env } from "../../config/env.ts";
import {
  Activity,
  Branch,
  Category,
  Destination,
  Hotel,
  Media,
  Package,
  PRICE_TYPES,
  withId,
  type ActivityDoc,
  type BranchDoc,
  type CategoryDoc,
  type DestinationDoc,
  type HotelDoc,
  type MediaDoc,
  type PackageDoc,
  type PackagePrice,
  type PriceType,
} from "../../db/models.ts";
import { pageMeta } from "../../lib/http.ts";
import { escapeRegex, normalizeText } from "../../lib/text.ts";
import { branchDto } from "../branches.ts";
import { getContentBlock } from "../content.ts";
import { activeCurrencies } from "../currencies.ts";
import { destinationDto } from "../destinations.ts";
import { loadImages, type ImageDto } from "../media/dto.ts";
import { PDF_VERSIONS, type PdfVersion } from "../pdf/itinerary-pdf.ts";
import { seoDto } from "../shared.ts";
import { testimonialsForPackages } from "../testimonials.ts";

export { PRICE_TYPES, type PriceType };
/** { ADULT: { INR: 26900, AED: 1185 }, CHILD: {...}, INFANT: {...} } - official amounts, no conversion. */
export type PriceTable = Record<PriceType, Record<string, number>>;

type PackageRow = Omit<PackageDoc, "_id"> & { id: string };
type BranchRow = Omit<BranchDoc, "_id"> & { id: string };
type DestinationRow = Omit<DestinationDoc, "_id"> & { id: string };
type CategoryRow = Omit<CategoryDoc, "_id"> & { id: string };

export function priceTable(rows: Pick<PackagePrice, "priceType" | "currencyCode" | "amount">[], currencyCodes: Set<string>): PriceTable {
  const table: PriceTable = { ADULT: {}, CHILD: {}, INFANT: {} };
  for (const row of rows) if (currencyCodes.has(row.currencyCode)) table[row.priceType][row.currencyCode] = row.amount;
  return table;
}

/** One version of a published package's uploaded itinerary PDF (downloaded through the API), or null when there is none. */
async function pdfLink(graph: Pick<PackageGraph, "slug" | "status" | (typeof PDF_VERSIONS)[PdfVersion]>, version: PdfVersion) {
  const mediaId = graph[PDF_VERSIONS[version]];
  if (graph.status !== "PUBLISHED" || !mediaId) return null;
  const file = await Media.findOne({ _id: mediaId, deletedAt: null }, { sizeBytes: 1, createdAt: 1 }).lean<Pick<MediaDoc, "sizeBytes" | "createdAt">>();
  const query = version === "with-logo" ? "" : `?branding=${version}`;
  return file ? { url: `${env.API_URL}/api/public/packages/${graph.slug}/pdf${query}`, sizeBytes: file.sizeBytes, updatedAt: file.createdAt } : null;
}

/**
 * Active branches and destinations, and every category. Packages are public only when published, not deleted,
 * and sold by an active branch to an active destination; these small collections are resolved to id sets first.
 */
async function catalogLookups() {
  const [branches, destinations, categories] = await Promise.all([
    Branch.find({ isActive: true }).lean<BranchDoc[]>(),
    Destination.find({ isActive: true }).lean<DestinationDoc[]>(),
    Category.find().lean<CategoryDoc[]>(),
  ]);
  return {
    branches: new Map(branches.map((row) => [row._id, withId(row)])),
    destinations: new Map(destinations.map((row) => [row._id, withId(row)])),
    categories: new Map(categories.map((row) => [row._id, withId(row)])),
  };
}

// ---------------------------------------------------------------------------------------------
// Listing

export interface PackageFilters {
  branch?: string;
  destination?: string;
  category?: string;
  country?: string;
  minDays?: number;
  maxDays?: number;
  /** Price range on the adult price, in `currency`. */
  minPrice?: number;
  maxPrice?: number;
  currency?: string;
  featured?: boolean;
  recommended?: boolean;
  slugs?: string[];
  q?: string;
  sort?: "recommended" | "price-asc" | "price-desc" | "duration-asc" | "duration-desc" | "newest";
  page: number;
  pageSize: number;
}

/** Search words, normalised like packages.searchText. */
export const searchTerms = (q: string) => normalizeText(q).split(" ").filter(Boolean).slice(0, 8);

const SORTS: Record<NonNullable<PackageFilters["sort"]>, Record<string, 1 | -1>> = {
  recommended: { isFeatured: -1, displayOrder: 1, title: 1 },
  // Packages without a price in the chosen currency come last either way.
  "price-asc": { _noPrice: 1, _price: 1, title: 1 },
  "price-desc": { _noPrice: 1, _price: -1, title: 1 },
  "duration-asc": { durationDays: 1, title: 1 },
  "duration-desc": { durationDays: -1, title: 1 },
  newest: { publishedAt: -1, title: 1 },
};

export async function listPublicPackages(filters: PackageFilters) {
  const currency = filters.currency ?? env.DEFAULT_CURRENCY;
  const { branches, destinations, categories } = await catalogLookups();

  const branchIds = [...branches.values()].filter((b) => !filters.branch || b.slug === filters.branch).map((b) => b.id);
  const destinationIds = [...destinations.values()]
    .filter((d) => (!filters.destination || d.slug === filters.destination) && (!filters.country || d.countryCode === filters.country.toUpperCase()))
    .map((d) => d.id);
  const category = filters.category ? [...categories.values()].find((c) => c.slug === filters.category) : undefined;
  const terms = filters.q ? searchTerms(filters.q) : [];
  const priceRange = filters.minPrice !== undefined || filters.maxPrice !== undefined;

  const filter: Record<string, unknown> = {
    status: "PUBLISHED",
    deletedAt: null,
    branchId: { $in: branchIds },
    destinationId: { $in: destinationIds },
    ...(filters.category && { categoryId: { $in: category ? [category.id] : [] } }),
    ...((filters.minDays !== undefined || filters.maxDays !== undefined) && {
      durationDays: { ...(filters.minDays !== undefined && { $gte: filters.minDays }), ...(filters.maxDays !== undefined && { $lte: filters.maxDays }) },
    }),
    ...(filters.featured !== undefined && { isFeatured: filters.featured }),
    ...(filters.recommended !== undefined && { isRecommended: filters.recommended }),
    ...(filters.slugs?.length && { slug: { $in: filters.slugs } }),
    ...(priceRange && {
      prices: {
        $elemMatch: {
          priceType: "ADULT",
          currencyCode: currency,
          amount: { ...(filters.minPrice !== undefined && { $gte: filters.minPrice }), ...(filters.maxPrice !== undefined && { $lte: filters.maxPrice }) },
        },
      },
    }),
    // Every search word must appear in the normalised search text (lower-case, so no case-insensitive flag needed).
    ...(terms.length && { $and: terms.map((term) => ({ searchText: { $regex: escapeRegex(term) } })) }),
  };

  const [docs, total] = await Promise.all([
    Package.aggregate<PackageDoc>([
      { $match: filter },
      {
        $addFields: {
          _price: {
            $let: {
              vars: {
                adult: {
                  $first: {
                    $filter: { input: "$prices", cond: { $and: [{ $eq: ["$$this.priceType", "ADULT"] }, { $eq: ["$$this.currencyCode", currency] }] } },
                  },
                },
              },
              in: "$$adult.amount",
            },
          },
        },
      },
      { $addFields: { _noPrice: { $cond: [{ $in: [{ $type: "$_price" }, ["missing", "null"]] }, 1, 0] } } },
      { $sort: SORTS[filters.sort ?? "recommended"] },
      { $skip: (filters.page - 1) * filters.pageSize },
      { $limit: filters.pageSize },
      { $project: { _price: 0, _noPrice: 0 } },
    ]),
    Package.countDocuments(filter),
  ]);

  const rows = docs.map((doc) => ({
    pkg: withId(doc),
    branch: branches.get(doc.branchId)!,
    destination: destinations.get(doc.destinationId)!,
    category: doc.categoryId ? (categories.get(doc.categoryId) ?? null) : null,
  }));
  return { items: await summaries(rows), meta: pageMeta(filters.page, filters.pageSize, total) };
}

type SummaryRow = {
  pkg: PackageRow;
  branch: BranchRow;
  destination: DestinationRow;
  category: CategoryRow | null;
};

/** Card-sized package objects, with images loaded for the whole page at once. */
export async function summaries(rows: SummaryRow[]) {
  const [image, currencies] = await Promise.all([loadImages(rows.map((row) => row.pkg.heroImageId)), activeCurrencies()]);
  const codes = new Set(currencies.map((currency) => currency.code));
  return rows.map((row) => summaryDto(row, image, priceTable(row.pkg.prices, codes)));
}

function summaryDto({ pkg, branch, destination, category }: SummaryRow, image: (id: string | null) => ImageDto | null, prices: PriceTable) {
  return {
    id: pkg.id,
    slug: pkg.slug,
    title: pkg.title,
    shortDescription: pkg.shortDescription,
    category: category ? { slug: category.slug, name: category.name } : null,
    branch: {
      slug: branch.slug,
      name: branch.name,
      airport: branch.airportCode ? { code: branch.airportCode, city: branch.airportCity ?? branch.city } : null,
    },
    destination: {
      slug: destination.slug,
      name: destination.name,
      kind: destination.kind,
      country: { code: destination.countryCode, name: destination.countryName },
    },
    duration: { days: pkg.durationDays, nights: pkg.durationNights },
    arrival: pkg.arrivalAirportCode ? { code: pkg.arrivalAirportCode, city: pkg.arrivalCity ?? destination.name } : null,
    heroImage: image(pkg.heroImageId),
    /** Adult price per currency: what cards show as "From". */
    startingPrice: prices.ADULT,
    isFeatured: pkg.isFeatured,
    isRecommended: pkg.isRecommended,
    keywords: pkg.keywords,
  };
}

export type PackageSummaryDto = ReturnType<typeof summaryDto>;

// ---------------------------------------------------------------------------------------------
// Full package (public page, preview, admin editor, PDF)

/**
 * A package with everything it links to: branch, destination, category, hotel options with their hotels,
 * activities, and itinerary days with their hotel. Queries run one after another because this also runs inside
 * transactions (the publish check), where parallel operations are not allowed.
 */
export async function loadPackageGraph(filter: Record<string, unknown>) {
  const doc = await Package.findOne(filter).lean<PackageDoc>();
  if (!doc) return undefined;
  const branch = await Branch.findById(doc.branchId).lean<BranchDoc>();
  const destination = await Destination.findById(doc.destinationId).lean<DestinationDoc>();
  const category = doc.categoryId ? await Category.findById(doc.categoryId).lean<CategoryDoc>() : null;
  const hotelIds = [...new Set([...doc.hotels, ...doc.itinerary].flatMap((row) => (row.hotelId ? [row.hotelId] : [])))];
  const hotels = new Map((hotelIds.length ? await Hotel.find({ _id: { $in: hotelIds } }).lean<HotelDoc[]>() : []).map((row) => [row._id, withId(row)]));
  // The package's add-on activities and the catalogue activities its itinerary steps are linked to.
  const activityIds = [...new Set([...doc.activityIds, ...doc.itinerary.flatMap((day) => day.activities.flatMap((entry) => (entry.activityId ? [entry.activityId] : [])))])];
  const activities = new Map(
    (activityIds.length ? await Activity.find({ _id: { $in: activityIds } }).lean<ActivityDoc[]>() : []).map((row) => [row._id, withId(row)]),
  );
  // References are checked on every write, so these exist; a missing one means the data is damaged.
  if (!branch || !destination) throw new Error(`Package ${doc._id} points at a missing branch or destination`);

  const pkg = withId(doc);
  return {
    ...pkg,
    branch: withId(branch),
    destination: withId(destination),
    category: category ? withId(category) : null,
    // A row without a hotel stays (hotel: null) so the admin keeps it; one pointing at a missing hotel is dropped.
    hotels: pkg.hotels.flatMap((row) => {
      const hotel = row.hotelId ? hotels.get(row.hotelId) : null;
      return hotel === undefined ? [] : [{ ...row, hotel }];
    }),
    activities: pkg.activityIds.flatMap((activityId) => {
      const activity = activities.get(activityId);
      return activity ? [{ activityId, activity }] : [];
    }),
    itinerary: pkg.itinerary.map((day) => ({
      ...day,
      hotel: day.hotelId ? (hotels.get(day.hotelId) ?? null) : null,
      activities: day.activities.map((entry) => ({ ...entry, activity: entry.activityId ? (activities.get(entry.activityId) ?? null) : null })),
    })),
  };
}

export type PackageGraph = NonNullable<Awaited<ReturnType<typeof loadPackageGraph>>>;

/**
 * What the package page shows under "Good to know" and "Important information", and what the admin edits for them.
 * Once the package has its own lists (ownInfo), exactly those. Until then the shared content: the destination's travel
 * facts and the notes for every package (Global content → Package defaults), each followed by anything the package
 * added before it had its own lists.
 */
export function packageInfo(graph: Pick<PackageGraph, "ownInfo" | "goodToKnow" | "importantInfo" | "destination">, defaults: { importantInfo: string[] }) {
  const goodToKnow = (graph.goodToKnow ?? []).map(({ title, description }) => ({ title, description: description ?? null }));
  if (graph.ownInfo) return { goodToKnow, importantInfo: graph.importantInfo };
  return {
    goodToKnow: [...graph.destination.facts.map((fact) => ({ title: fact.label, description: fact.value })), ...goodToKnow],
    importantInfo: [...defaults.importantInfo, ...graph.importantInfo],
  };
}

/** "10:30:00" -> "10:30". */
const shortTime = (time: string | null) => (time ? time.slice(0, 5) : null);

const paragraphs = (text: string) =>
  text
    .split(/\n\s*\n/)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean);

/** The customer-facing package: everything the package page and its preview show. */
export async function packageDetail(graph: PackageGraph) {
  const imageIds = [
    graph.heroImageId,
    graph.ogImageId,
    ...graph.gallery,
    graph.branch.bannerImageId,
    graph.branch.thumbnailImageId,
    graph.branch.ogImageId,
    graph.destination.heroImageId,
    graph.destination.thumbnailImageId,
    graph.destination.ogImageId,
    ...graph.hotels.map((row) => row.hotel?.primaryImageId),
    ...graph.activities.map((row) => row.activity.imageId),
    ...graph.itinerary.map((day) => day.imageId),
    ...graph.itinerary.flatMap((day) => day.activities.map((entry) => entry.activity?.imageId)),
  ];
  const [image, currencies, defaults, reviews] = await Promise.all([
    loadImages(imageIds),
    activeCurrencies(),
    getContentBlock("package.defaults"),
    testimonialsForPackages([graph.id]),
  ]);
  const prices = priceTable(graph.prices, new Set(currencies.map((currency) => currency.code)));

  return {
    ...summaryDto({ pkg: graph, branch: graph.branch, destination: graph.destination, category: graph.category }, image, prices),
    overview: paragraphs(graph.description),
    bestTime: graph.bestTime,
    gallery: graph.gallery.map((mediaId) => image(mediaId)).filter((photo): photo is ImageDto => !!photo),
    highlights: graph.highlights.map(({ title, description }) => ({ title, description })),
    itinerary: graph.itinerary.map((day) => ({
      dayNumber: day.dayNumber,
      title: day.title,
      description: day.description,
      stay: day.stay,
      meals: day.meals,
      // A hotel switched off in the catalogue is not shown, as with every catalogue entry on the public site.
      hotel: day.hotel?.isActive ? { name: day.hotel.name, starCategory: day.hotel.starCategory, location: day.hotel.location } : null,
      image: image(day.imageId),
      activities: day.activities.map((activity) => ({
        time: shortTime(activity.time),
        title: activity.title,
        description: activity.description,
        location: activity.location,
        type: activity.type,
        // The catalogue activity the step is linked to, while it is switched on (as everywhere on the public site).
        activity: activity.activity?.isActive
          ? {
              slug: activity.activity.slug,
              name: activity.activity.name,
              description: activity.activity.description,
              location: activity.activity.location,
              image: image(activity.activity.imageId),
            }
          : null,
      })),
    })),
    inclusions: graph.inclusions.map(({ title, description }) => ({ title, description })),
    exclusions: graph.exclusions.map(({ title, description }) => ({ title, description })),
    // Only rows with a hotel that is switched on are published: anything else has nothing valid to show.
    hotels: graph.hotels.flatMap(({ hotel, ...row }) => (hotel?.isActive ? [{ ...row, hotel }] : [])).map((row) => ({
      name: row.hotel.name,
      starCategory: row.hotel.starCategory,
      rating: row.hotel.rating,
      location: row.hotel.location,
      nights: row.nights,
      roomType: row.roomType,
      mealPlan: row.mealPlan,
      isDefault: row.isDefault,
      image: image(row.hotel.primaryImageId),
    })),
    // The experiences included in the package (its Activities tab), in the admin's order; switched-off ones are left out.
    activities: graph.activities
      .filter((row) => row.activity.isActive)
      .map((row) => ({
        slug: row.activity.slug,
        name: row.activity.name,
        description: row.activity.description,
        location: row.activity.location,
        image: image(row.activity.imageId),
      })),
    /** Per traveller type and currency. */
    prices,
    ...packageInfo(graph, defaults),
    terms: defaults.terms,
    // The travel facts are part of goodToKnow above; sent empty here so no page shows them twice.
    destination: { ...destinationDto(graph.destination, image), facts: [] },
    branch: branchDto(graph.branch, image),
    reviews: reviews.get(graph.id) ?? [],
    pdf: await pdfLink(graph, "with-logo"),
    pdfWithoutLogo: await pdfLink(graph, "without-logo"),
    seo: seoDto(graph, image),
    publishedAt: graph.publishedAt,
    updatedAt: graph.updatedAt,
  };
}

export type PackageDetailDto = Awaited<ReturnType<typeof packageDetail>>;

export async function getPublicPackage(slug: string) {
  const graph = await loadPackageGraph({ slug, status: "PUBLISHED", deletedAt: null });
  if (!graph || !graph.branch.isActive || !graph.destination.isActive) return null;
  return graph;
}

// ---------------------------------------------------------------------------------------------
// Recommendations

/**
 * Packages to suggest after this one: other destinations only, one per destination, same branch first
 * (same departure city), then GETSET's recommended picks. The list is rotated by the current package's
 * position, so different pages suggest different trips.
 */
export async function recommendations(slug: string, limit: number) {
  const current = await Package.findOne({ slug }, { branchId: 1, destinationId: 1 }).lean<Pick<PackageDoc, "_id" | "branchId" | "destinationId">>();
  if (!current) return null;

  const { branches, destinations, categories } = await catalogLookups();
  const docs = await Package.find({
    status: "PUBLISHED",
    deletedAt: null,
    _id: { $ne: current._id },
    branchId: { $in: [...branches.keys()] },
    destinationId: { $in: [...destinations.keys()], $ne: current.destinationId },
  })
    .sort({ isRecommended: -1, displayOrder: 1, title: 1 })
    .limit(200)
    .lean<PackageDoc[]>();
  const rows = docs.map((doc) => ({
    pkg: withId(doc),
    branch: branches.get(doc.branchId)!,
    destination: destinations.get(doc.destinationId)!,
    category: doc.categoryId ? (categories.get(doc.categoryId) ?? null) : null,
  }));

  const ordered = await Package.find({ status: "PUBLISHED", deletedAt: null }, { _id: 1 }).sort({ displayOrder: 1, title: 1 }).lean<{ _id: string }[]>();
  const offset = Math.max(0, ordered.findIndex((row) => row._id === current._id));
  const rotate = <T>(list: T[]) => (list.length ? [...list.slice(offset % list.length), ...list.slice(0, offset % list.length)] : list);

  const sameBranch = rotate(rows.filter((row) => row.pkg.branchId === current.branchId));
  const others = rotate(rows.filter((row) => row.pkg.branchId !== current.branchId));
  const seen = new Set<string>();
  const picks = [...sameBranch, ...others].filter((row) => {
    if (seen.has(row.pkg.destinationId)) return false;
    seen.add(row.pkg.destinationId);
    return true;
  });
  return summaries(picks.slice(0, limit));
}
