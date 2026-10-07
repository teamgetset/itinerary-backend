import { and, asc, count, desc, eq, exists, gte, inArray, isNull, lte, ne, sql, type SQL } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { env } from "../../config/env.ts";
import { db, type Db, type Tx } from "../../db/client.ts";
import {
  branches,
  destinations,
  itineraryActivities,
  itineraryDays,
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
import { pageMeta } from "../../lib/http.ts";
import { escapeLike, normalizeText } from "../../lib/text.ts";
import { branchDto } from "../branches.ts";
import { getContentBlock } from "../content.ts";
import { activeCurrencies } from "../currencies.ts";
import { destinationDto } from "../destinations.ts";
import { loadImages, type ImageDto } from "../media/dto.ts";
import { seoDto } from "../shared.ts";
import { testimonialsForPackages } from "../testimonials.ts";

export const PRICE_TYPES = ["ADULT", "CHILD", "INFANT"] as const;
export type PriceType = (typeof PRICE_TYPES)[number];
/** { ADULT: { INR: 26900, AED: 1185 }, CHILD: {...}, INFANT: {...} } - official amounts, no conversion. */
export type PriceTable = Record<PriceType, Record<string, number>>;

type PackageRow = typeof packages.$inferSelect;
type PriceRow = Pick<typeof packagePrices.$inferSelect, "packageId" | "priceType" | "currencyCode" | "amount">;

export function priceTable(rows: PriceRow[], currencyCodes: Set<string>): PriceTable {
  const table: PriceTable = { ADULT: {}, CHILD: {}, INFANT: {} };
  for (const row of rows) if (currencyCodes.has(row.currencyCode)) table[row.priceType][row.currencyCode] = row.amount;
  return table;
}

/** Published, not deleted, and sold by an active branch to an active destination. */
const publicPackage = and(
  eq(packages.status, "PUBLISHED"),
  isNull(packages.deletedAt),
  eq(branches.isActive, true),
  eq(destinations.isActive, true),
);

const pdfLinks = (slug: string) => ({
  withLogoUrl: `${env.API_URL}/api/public/packages/${slug}/pdf?branding=with-logo`,
  withoutLogoUrl: `${env.API_URL}/api/public/packages/${slug}/pdf?branding=without-logo`,
});

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

/** Search words, normalised like packages.search_text. */
export const searchTerms = (q: string) => normalizeText(q).split(" ").filter(Boolean).slice(0, 8);

export async function listPublicPackages(filters: PackageFilters) {
  const currency = filters.currency ?? env.DEFAULT_CURRENCY;
  const adult = alias(packagePrices, "adult_price");

  const priceRange =
    filters.minPrice !== undefined || filters.maxPrice !== undefined
      ? exists(
          db
            .select({ one: sql`1` })
            .from(packagePrices)
            .where(
              and(
                eq(packagePrices.packageId, packages.id),
                eq(packagePrices.priceType, "ADULT"),
                eq(packagePrices.currencyCode, currency),
                filters.minPrice !== undefined ? gte(packagePrices.amount, filters.minPrice) : undefined,
                filters.maxPrice !== undefined ? lte(packagePrices.amount, filters.maxPrice) : undefined,
              ),
            ),
        )
      : undefined;

  const where = and(
    publicPackage,
    filters.branch ? eq(branches.slug, filters.branch) : undefined,
    filters.destination ? eq(destinations.slug, filters.destination) : undefined,
    filters.category ? eq(packageCategories.slug, filters.category) : undefined,
    filters.country ? eq(destinations.countryCode, filters.country.toUpperCase()) : undefined,
    filters.minDays !== undefined ? gte(packages.durationDays, filters.minDays) : undefined,
    filters.maxDays !== undefined ? lte(packages.durationDays, filters.maxDays) : undefined,
    filters.featured !== undefined ? eq(packages.isFeatured, filters.featured) : undefined,
    filters.recommended !== undefined ? eq(packages.isRecommended, filters.recommended) : undefined,
    filters.slugs?.length ? inArray(packages.slug, filters.slugs) : undefined,
    ...(filters.q ? searchTerms(filters.q).map((term) => sql`${packages.searchText} like ${`%${escapeLike(term)}%`}`) : []),
    priceRange,
  );

  const order: SQL[] = {
    recommended: [desc(packages.isFeatured), asc(packages.displayOrder), asc(packages.title)],
    "price-asc": [sql`${adult.amount} asc nulls last`, asc(packages.title)],
    "price-desc": [sql`${adult.amount} desc nulls last`, asc(packages.title)],
    "duration-asc": [asc(packages.durationDays), asc(packages.title)],
    "duration-desc": [desc(packages.durationDays), asc(packages.title)],
    newest: [desc(packages.publishedAt), asc(packages.title)],
  }[filters.sort ?? "recommended"];

  const base = () =>
    db
      .select({ pkg: packages, branch: branches, destination: destinations, category: packageCategories })
      .from(packages)
      .innerJoin(branches, eq(branches.id, packages.branchId))
      .innerJoin(destinations, eq(destinations.id, packages.destinationId))
      .leftJoin(packageCategories, eq(packageCategories.id, packages.categoryId))
      .leftJoin(
        adult,
        and(eq(adult.packageId, packages.id), eq(adult.priceType, "ADULT"), eq(adult.currencyCode, currency)),
      );

  const [rows, [{ total }]] = await Promise.all([
    base()
      .where(where)
      .orderBy(...order)
      .limit(filters.pageSize)
      .offset((filters.page - 1) * filters.pageSize),
    db
      .select({ total: count() })
      .from(packages)
      .innerJoin(branches, eq(branches.id, packages.branchId))
      .innerJoin(destinations, eq(destinations.id, packages.destinationId))
      .leftJoin(packageCategories, eq(packageCategories.id, packages.categoryId))
      .where(where),
  ]);

  return { items: await summaries(rows), meta: pageMeta(filters.page, filters.pageSize, total) };
}

type SummaryRow = {
  pkg: PackageRow;
  branch: typeof branches.$inferSelect;
  destination: typeof destinations.$inferSelect;
  category: typeof packageCategories.$inferSelect | null;
};

/** Card-sized package objects, with prices and images loaded for the whole page at once. */
export async function summaries(rows: SummaryRow[]) {
  const ids = rows.map((row) => row.pkg.id);
  const [image, prices, currencies] = await Promise.all([
    loadImages(db, rows.map((row) => row.pkg.heroImageId)),
    ids.length ? db.select().from(packagePrices).where(inArray(packagePrices.packageId, ids)) : [],
    activeCurrencies(),
  ]);
  const codes = new Set(currencies.map((currency) => currency.code));
  return rows.map((row) => summaryDto(row, image, priceTable(prices.filter((p) => p.packageId === row.pkg.id), codes)));
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

export async function loadPackageGraph(where: SQL, from: Db | Tx = db) {
  return from.query.packages.findFirst({
    where,
    with: {
      branch: true,
      destination: true,
      category: true,
      images: { orderBy: [asc(packageImages.displayOrder)] },
      highlights: { orderBy: [asc(packageHighlights.displayOrder)] },
      inclusions: { orderBy: [asc(packageInclusions.displayOrder)] },
      exclusions: { orderBy: [asc(packageExclusions.displayOrder)] },
      prices: true,
      hotels: { orderBy: [asc(packageHotels.displayOrder)], with: { hotel: true } },
      activities: { orderBy: [asc(packageActivities.displayOrder)], with: { activity: true } },
      itineraryDays: {
        orderBy: [asc(itineraryDays.dayNumber)],
        with: { hotel: true, activities: { orderBy: [asc(itineraryActivities.displayOrder)] } },
      },
    },
  });
}

export type PackageGraph = NonNullable<Awaited<ReturnType<typeof loadPackageGraph>>>;

/** "10:30:00" -> "10:30". */
const shortTime = (time: string | null) => (time ? time.slice(0, 5) : null);

const paragraphs = (text: string) =>
  text
    .split(/\n\s*\n/)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean);

/** The customer-facing package: everything the package page, preview and PDF show. */
export async function packageDetail(graph: PackageGraph) {
  const imageIds = [
    graph.heroImageId,
    graph.ogImageId,
    ...graph.images.map((image) => image.mediaId),
    graph.branch.bannerImageId,
    graph.branch.thumbnailImageId,
    graph.branch.ogImageId,
    graph.destination.heroImageId,
    graph.destination.thumbnailImageId,
    graph.destination.ogImageId,
    ...graph.hotels.map((row) => row.hotel.primaryImageId),
    ...graph.activities.map((row) => row.activity.imageId),
    ...graph.itineraryDays.map((day) => day.imageId),
  ];
  const [image, currencies, defaults, reviews] = await Promise.all([
    loadImages(db, imageIds),
    activeCurrencies(),
    getContentBlock("package.defaults"),
    testimonialsForPackages([graph.id]),
  ]);
  const prices = priceTable(graph.prices, new Set(currencies.map((currency) => currency.code)));

  return {
    ...summaryDto({ pkg: graph, branch: graph.branch, destination: graph.destination, category: graph.category }, image, prices),
    overview: paragraphs(graph.description),
    bestTime: graph.bestTime,
    gallery: graph.images.map((row) => image(row.mediaId)).filter((photo): photo is ImageDto => !!photo),
    highlights: graph.highlights.map(({ title, description }) => ({ title, description })),
    itinerary: graph.itineraryDays.map((day) => ({
      dayNumber: day.dayNumber,
      title: day.title,
      description: day.description,
      stay: day.stay,
      meals: day.meals,
      hotel: day.hotel ? { name: day.hotel.name, starCategory: day.hotel.starCategory, location: day.hotel.location } : null,
      image: image(day.imageId),
      activities: day.activities.map((activity) => ({
        time: shortTime(activity.time),
        title: activity.title,
        description: activity.description,
        location: activity.location,
        type: activity.activityType,
      })),
    })),
    inclusions: graph.inclusions.map(({ title, description }) => ({ title, description })),
    exclusions: graph.exclusions.map(({ title, description }) => ({ title, description })),
    hotels: graph.hotels.map((row) => ({
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
    activities: graph.activities.map((row) => ({
      slug: row.activity.slug,
      name: row.activity.name,
      description: row.activity.description,
      image: image(row.activity.imageId),
    })),
    /** Per traveller type and currency. */
    prices,
    importantInfo: [...defaults.importantInfo, ...graph.importantInfo],
    terms: defaults.terms,
    destination: destinationDto(graph.destination, image),
    branch: branchDto(graph.branch, image),
    reviews: reviews.get(graph.id) ?? [],
    pdf: pdfLinks(graph.slug),
    seo: seoDto(graph, image),
    publishedAt: graph.publishedAt,
    updatedAt: graph.updatedAt,
  };
}

export type PackageDetailDto = Awaited<ReturnType<typeof packageDetail>>;

export async function getPublicPackage(slug: string) {
  const graph = await loadPackageGraph(and(eq(packages.slug, slug), eq(packages.status, "PUBLISHED"), isNull(packages.deletedAt))!);
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
  const [current] = await db
    .select({ id: packages.id, branchId: packages.branchId, destinationId: packages.destinationId })
    .from(packages)
    .where(eq(packages.slug, slug))
    .limit(1);
  if (!current) return null;

  const rows = await db
    .select({ pkg: packages, branch: branches, destination: destinations, category: packageCategories })
    .from(packages)
    .innerJoin(branches, eq(branches.id, packages.branchId))
    .innerJoin(destinations, eq(destinations.id, packages.destinationId))
    .leftJoin(packageCategories, eq(packageCategories.id, packages.categoryId))
    .where(and(publicPackage, ne(packages.id, current.id), ne(packages.destinationId, current.destinationId)))
    .orderBy(desc(packages.isRecommended), asc(packages.displayOrder), asc(packages.title))
    .limit(200);

  const ordered = await db
    .select({ id: packages.id })
    .from(packages)
    .where(and(eq(packages.status, "PUBLISHED"), isNull(packages.deletedAt)))
    .orderBy(asc(packages.displayOrder), asc(packages.title));
  const offset = Math.max(0, ordered.findIndex((row) => row.id === current.id));
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
