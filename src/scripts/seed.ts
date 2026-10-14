/**
 * Loads the demo catalogue (seed/demo-catalog.json + seed/images) into an empty database.
 *   npm run db:seed                                              refuses if packages already exist
 *   npm run db:seed -- --reset --confirm-database <name>         wipes content and uploaded files first (never in production)
 *   npm run db:seed -- --pdfs                                    also generates every itinerary PDF
 * Optional: SEED_ADMIN_EMAIL + SEED_ADMIN_PASSWORD create a super admin for local use.
 * The content is DEMO data; see the note at the top of the JSON file.
 */
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import type { Model } from "mongoose";
import { env, isProduction } from "../config/env.ts";
import { connectDb, disconnectDb } from "../db/client.ts";
import { ensureIndexes } from "../db/indexes.ts";
import {
  Activity,
  AdminUser,
  Branch,
  Category,
  Currency,
  Destination,
  Enquiry,
  HeroSlide,
  Hotel,
  ItineraryPdf,
  Media,
  Package,
  SiteContent,
  Testimonial,
  type BranchDoc,
  type ItineraryActivityType,
  type Meal,
  type PriceType,
  type TestimonialDoc,
} from "../db/models.ts";
import { hashPassword } from "../lib/crypto.ts";
import { safeMessage } from "../lib/logger.ts";
import { slugify } from "../lib/text.ts";
import { CONTENT_DEFAULTS } from "../modules/content.ts";
import { refreshSearchText } from "../modules/packages/search-text.ts";
import { ensureCurrentPdf } from "../modules/pdf/service.ts";
import { storeImage } from "../modules/media/store.ts";
import { sniffImage } from "../modules/storage.ts";

type SeedImage = { file: string; alt: string; focalPoint: string | null };
type Prices = Record<string, number>;

interface SeedData {
  currencies: { code: string; symbol: string; name: string; locale: string; displayOrder: number }[];
  categories: string[];
  branches: (Partial<Omit<BranchDoc, "_id" | "bannerImageId" | "thumbnailImageId">> & { slug: string; banner: SeedImage; thumbnail: SeedImage })[];
  destinations: {
    slug: string;
    name: string;
    kind: "COUNTRY" | "PLACE";
    countryCode: string;
    countryName: string;
    shortDescription: string;
    hero: SeedImage;
    facts: { label: string; value: string }[];
    displayOrder: number;
    experiences: { name: string; prices: Prices }[];
  }[];
  packages: {
    slug: string;
    branch: string;
    destination: string;
    category: string;
    title: string;
    shortDescription: string;
    description: string;
    durationDays: number;
    durationNights: number;
    bestTime: string;
    arrivalAirportCode: string;
    arrivalCity: string;
    hero: SeedImage;
    gallery: SeedImage[];
    keywords: string[];
    highlights: string[];
    itinerary: { title: string; description: string; stay: string | null; meals: Meal[]; activities: { time: string | null; title: string; type: string; location?: string }[] }[];
    inclusions: string[];
    exclusions: string[];
    prices: Record<"ADULT" | "CHILD" | "INFANT", Prices>;
    isFeatured: boolean;
    displayOrder: number;
  }[];
  testimonials: Omit<TestimonialDoc, "_id" | "isPublished" | "createdAt" | "updatedAt">[];
  heroSlides: { title: string; label: string; image: SeedImage; buttonText: string; buttonLink: string; displayOrder: number }[];
}

const SEED_DIR = new URL("../../seed/", import.meta.url);
const data: SeedData = JSON.parse(readFileSync(new URL("demo-catalog.json", SEED_DIR), "utf8"));
const { values: args } = parseArgs({
  options: { reset: { type: "boolean", default: false }, "confirm-database": { type: "string" }, pdfs: { type: "boolean", default: false } },
});

/** Everything the demo seed writes. Admin accounts, sessions and the audit log are left alone. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const CONTENT_MODELS: Model<any>[] = [Enquiry, Testimonial, HeroSlide, SiteContent, ItineraryPdf, Package, Activity, Hotel, Category, Destination, Branch, Currency, Media];

async function reset() {
  if (isProduction) throw new Error("--reset is disabled in production.");
  // The development database may hold real (migrated) content: wiping it must name it explicitly.
  if (args["confirm-database"] !== env.MONGODB_DB_NAME) {
    throw new Error(`--reset wipes all content in database "${env.MONGODB_DB_NAME}". Repeat its name to confirm: --confirm-database ${env.MONGODB_DB_NAME}`);
  }
  console.log(`Wiping content in "${env.MONGODB_DB_NAME}" and local uploads ...`);
  for (const model of CONTENT_MODELS) await model.deleteMany({});
  if (env.STORAGE_PROVIDER === "local") {
    for (const folder of ["images", "documents"]) await rm(resolve(env.STORAGE_LOCAL_DIR, folder), { recursive: true, force: true });
  }
}

/** Uploads each seed image once and returns its media id. */
function imageUploader() {
  const uploaded = new Map<string, string>();
  return async (image: SeedImage) => {
    const cached = uploaded.get(image.file);
    if (cached) return cached;
    const bytes = readFileSync(new URL(`images/${image.file}`, SEED_DIR));
    const type = sniffImage(bytes);
    if (!type) throw new Error(`Not an image: ${image.file}`);
    const id = randomUUID();
    const stored = await storeImage(id, bytes, type);
    const row = await Media.create({
      _id: id,
      kind: "IMAGE",
      storageKey: stored.storageKey,
      cloudinary: stored.cloudinary,
      fileName: image.file.split("/").pop()!,
      mimeType: type.mime,
      sizeBytes: bytes.length,
      altText: image.alt,
      focalPoint: image.focalPoint,
    });
    uploaded.set(image.file, row._id);
    return row._id as string;
  };
}

/** Inserts without overwriting: existing documents with the same id are left as they are. */
const insertMissing = (model: typeof Currency | typeof SiteContent, docs: { _id: string }[]) =>
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (model as any).bulkWrite(docs.map((doc) => ({ updateOne: { filter: { _id: doc._id }, update: { $setOnInsert: doc }, upsert: true } })));

async function seed() {
  await ensureIndexes();
  if (args.reset) await reset();
  if (await Package.countDocuments()) {
    console.error("The database already has packages. Nothing was changed. (Development only: npm run db:seed -- --reset --confirm-database <name>)");
    process.exitCode = 1;
    return;
  }

  // Not one transaction: a seed over the network can outlast MongoDB's 60-second transaction limit.
  // It only runs on an empty database; if it stops halfway, run it again with --reset.
  const upload = imageUploader();
  await insertMissing(Currency, data.currencies.map(({ code, ...currency }) => ({ _id: code, ...currency })));
  await insertMissing(SiteContent, Object.entries(CONTENT_DEFAULTS).map(([key, value]) => ({ _id: key, value })));

  const categoryIds = new Map<string, string>();
  for (const [index, name] of data.categories.entries()) {
    const row = await Category.create({ name, slug: slugify(name), displayOrder: index });
    categoryIds.set(name, row._id);
  }

  const branchIds = new Map<string, string>();
  for (const { banner, thumbnail, ...branch } of data.branches) {
    const row = await Branch.create({ ...branch, bannerImageId: await upload(banner), thumbnailImageId: await upload(thumbnail) });
    branchIds.set(branch.slug, row._id);
  }

  const destinationIds = new Map<string, string>();
  for (const { hero, experiences, ...destination } of data.destinations) {
    const row = await Destination.create({ ...destination, heroImageId: await upload(hero) });
    destinationIds.set(destination.slug, row._id);
    for (const [order, experience] of experiences.entries()) {
      await Activity.create({
        name: experience.name,
        slug: slugify(`${destination.slug} ${experience.name}`),
        destinationId: row._id,
        displayOrder: order,
        prices: Object.entries(experience.prices).map(([currencyCode, amount]) => ({ currencyCode, amount })),
      });
    }
  }

  let packages = 0;
  for (const pkg of data.packages) {
    const gallery: string[] = [];
    for (const image of pkg.gallery) gallery.push(await upload(image));
    const list = (items: string[]) => items.map((title) => ({ title, description: null }));
    await Package.create({
      branchId: branchIds.get(pkg.branch)!,
      destinationId: destinationIds.get(pkg.destination)!,
      categoryId: categoryIds.get(pkg.category)!,
      title: pkg.title,
      slug: pkg.slug,
      shortDescription: pkg.shortDescription,
      description: pkg.description,
      durationDays: pkg.durationDays,
      durationNights: pkg.durationNights,
      bestTime: pkg.bestTime,
      arrivalAirportCode: pkg.arrivalAirportCode,
      arrivalCity: pkg.arrivalCity,
      heroImageId: await upload(pkg.hero),
      keywords: pkg.keywords,
      status: "PUBLISHED",
      publishedAt: new Date(),
      isFeatured: pkg.isFeatured,
      displayOrder: pkg.displayOrder,
      gallery,
      highlights: pkg.highlights.map((title) => ({ title, description: null, icon: null })),
      inclusions: list(pkg.inclusions),
      exclusions: list(pkg.exclusions),
      prices: Object.entries(pkg.prices).flatMap(([priceType, byCurrency]) =>
        Object.entries(byCurrency).map(([currencyCode, amount]) => ({ currencyCode, priceType: priceType as PriceType, amount })),
      ),
      itinerary: pkg.itinerary.map((day, index) => ({
        dayNumber: index + 1,
        title: day.title,
        description: day.description,
        stay: day.stay,
        meals: day.meals,
        activities: day.activities.map((activity) => ({
          time: activity.time,
          title: activity.title,
          location: activity.location ?? null,
          type: activity.type as ItineraryActivityType,
        })),
      })),
    });
    packages++;
  }
  await refreshSearchText({});

  await Testimonial.insertMany(data.testimonials.map((t) => ({ ...t, isPublished: true })));
  for (const { image, ...slide } of data.heroSlides) {
    await HeroSlide.create({ ...slide, imageId: await upload(image), isPublished: true });
  }

  console.log(
    `Seeded ${data.branches.length} branches, ${data.destinations.length} destinations, ${packages} packages, ` +
      `${data.testimonials.length} testimonials, ${data.heroSlides.length} hero slides, ${await Media.countDocuments()} images.`,
  );

  const { SEED_ADMIN_EMAIL: email, SEED_ADMIN_PASSWORD: password } = process.env;
  if (email && password && !isProduction) {
    if (!(await AdminUser.exists({ email: email.toLowerCase() }))) {
      await AdminUser.create({ name: "Local admin", email: email.toLowerCase(), role: "SUPER_ADMIN", passwordHash: await hashPassword(password) });
      console.log(`Created super admin ${email} (from SEED_ADMIN_EMAIL).`);
    }
  }

  if (args.pdfs) {
    for (const pkg of await Package.find({}, { slug: 1 }).lean<{ _id: string; slug: string }[]>()) {
      const pdf = await ensureCurrentPdf(pkg._id, null);
      console.log(`PDF v${pdf.version} ${pkg.slug}`);
    }
  }
}

try {
  await connectDb();
  await seed();
} catch (error) {
  console.error("Seed failed:", safeMessage(error));
  process.exitCode = 1;
} finally {
  await disconnectDb();
  // The PDF browser closes itself after a minute; do not wait for it.
  setTimeout(() => process.exit(process.exitCode ?? 0), 100).unref();
}
