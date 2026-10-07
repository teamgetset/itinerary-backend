/**
 * Loads the demo catalogue (seed/demo-catalog.json + seed/images) into an empty database.
 *   npm run db:seed              refuses if packages already exist
 *   npm run db:seed -- --reset   wipes content and uploaded files first (never in production)
 *   npm run db:seed -- --pdfs    also generates every itinerary PDF
 * Optional: SEED_ADMIN_EMAIL + SEED_ADMIN_PASSWORD create a super admin for local use.
 * The content is DEMO data; see the note at the top of the JSON file.
 */
import { readFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { resolve } from "node:path";
import { count, eq, sql } from "drizzle-orm";
import { env, isProduction } from "../config/env.ts";
import { db, pool, type Tx } from "../db/client.ts";
import {
  activities,
  activityPrices,
  adminUsers,
  branches,
  currencies,
  destinations,
  heroSlides,
  itineraryActivities,
  itineraryDays,
  media,
  packageCategories,
  packageExclusions,
  packageHighlights,
  packageImages,
  packageInclusions,
  packagePrices,
  packages,
  siteContent,
  testimonials,
} from "../db/schema.ts";
import { hashPassword } from "../lib/crypto.ts";
import { slugify } from "../lib/text.ts";
import { CONTENT_DEFAULTS } from "../modules/content.ts";
import { refreshSearchText } from "../modules/packages/search-text.ts";
import { ensureCurrentPdf } from "../modules/pdf/service.ts";
import { newKey, sniffImage, storage } from "../modules/storage.ts";

type SeedImage = { file: string; alt: string; focalPoint: string | null };
type Prices = Record<string, number>;
type ActivityType = (typeof itineraryActivities.$inferInsert)["activityType"];
type Meal = "BREAKFAST" | "LUNCH" | "DINNER";

interface SeedData {
  currencies: { code: string; symbol: string; name: string; locale: string; displayOrder: number }[];
  categories: string[];
  branches: (Omit<typeof branches.$inferInsert, "bannerImageId" | "thumbnailImageId"> & { banner: SeedImage; thumbnail: SeedImage })[];
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
  testimonials: (Omit<typeof testimonials.$inferInsert, "isPublished">)[];
  heroSlides: { title: string; label: string; image: SeedImage; buttonText: string; buttonLink: string; displayOrder: number }[];
}

const SEED_DIR = new URL("../../seed/", import.meta.url);
const data: SeedData = JSON.parse(readFileSync(new URL("demo-catalog.json", SEED_DIR), "utf8"));
const args = new Set(process.argv.slice(2));

async function reset() {
  if (isProduction) throw new Error("--reset is disabled in production.");
  console.log("Wiping content tables and local uploads ...");
  await db.execute(sql`truncate table
    enquiry_notes, enquiries, testimonials, hero_slides, site_content, itinerary_pdfs, itinerary_activities, itinerary_days,
    package_activities, package_hotels, package_prices, package_exclusions, package_inclusions, package_highlights,
    package_images, packages, activity_prices, activities, hotels, package_categories, destinations, branches,
    currencies, media restart identity cascade`);
  if (env.STORAGE_PROVIDER === "local") {
    for (const folder of ["images", "documents"]) await rm(resolve(env.STORAGE_LOCAL_DIR, folder), { recursive: true, force: true });
  }
}

/** Uploads each seed image once and returns its media id. */
function imageUploader(tx: Tx) {
  const uploaded = new Map<string, string>();
  return async (image: SeedImage) => {
    const cached = uploaded.get(image.file);
    if (cached) return cached;
    const bytes = readFileSync(new URL(`images/${image.file}`, SEED_DIR));
    const type = sniffImage(bytes);
    if (!type) throw new Error(`Not an image: ${image.file}`);
    const key = newKey("images", type.ext);
    await storage.put(key, bytes, type.mime);
    const [row] = await tx
      .insert(media)
      .values({
        kind: "IMAGE",
        storageKey: key,
        fileName: image.file.split("/").pop()!,
        mimeType: type.mime,
        sizeBytes: bytes.length,
        altText: image.alt,
        focalPoint: image.focalPoint,
      })
      .returning({ id: media.id });
    uploaded.set(image.file, row!.id);
    return row!.id;
  };
}

async function seed() {
  if (args.has("--reset")) await reset();
  const [{ existing }] = await db.select({ existing: count() }).from(packages);
  if (existing > 0) {
    console.error("The database already has packages. Nothing was changed. (Development only: npm run db:seed -- --reset)");
    process.exitCode = 1;
    return;
  }

  const summary = await db.transaction(async (tx) => {
    const upload = imageUploader(tx);

    await tx.insert(currencies).values(data.currencies).onConflictDoNothing();
    await tx
      .insert(siteContent)
      .values(Object.entries(CONTENT_DEFAULTS).map(([key, value]) => ({ key, value })))
      .onConflictDoNothing();

    const categoryIds = new Map<string, string>();
    for (const [index, name] of data.categories.entries()) {
      const [row] = await tx.insert(packageCategories).values({ name, slug: slugify(name), displayOrder: index }).returning({ id: packageCategories.id });
      categoryIds.set(name, row!.id);
    }

    const branchIds = new Map<string, string>();
    for (const { banner, thumbnail, ...branch } of data.branches) {
      const [row] = await tx
        .insert(branches)
        .values({ ...branch, bannerImageId: await upload(banner), thumbnailImageId: await upload(thumbnail) })
        .returning({ id: branches.id });
      branchIds.set(branch.slug, row!.id);
    }

    const destinationIds = new Map<string, string>();
    for (const { hero, experiences, ...destination } of data.destinations) {
      const [row] = await tx
        .insert(destinations)
        .values({ ...destination, heroImageId: await upload(hero) })
        .returning({ id: destinations.id });
      destinationIds.set(destination.slug, row!.id);
      for (const [order, experience] of experiences.entries()) {
        const [activity] = await tx
          .insert(activities)
          .values({ name: experience.name, slug: slugify(`${destination.slug} ${experience.name}`), destinationId: row!.id, displayOrder: order })
          .returning({ id: activities.id });
        await tx.insert(activityPrices).values(
          Object.entries(experience.prices).map(([currencyCode, amount]) => ({ activityId: activity!.id, currencyCode, amount })),
        );
      }
    }

    const packageIds = new Map<string, string>();
    for (const pkg of data.packages) {
      const [row] = await tx
        .insert(packages)
        .values({
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
        })
        .returning({ id: packages.id });
      const packageId = row!.id;
      packageIds.set(pkg.slug, packageId);

      for (const [order, image] of pkg.gallery.entries()) {
        await tx.insert(packageImages).values({ packageId, mediaId: await upload(image), displayOrder: order });
      }
      const list = (items: string[]) => items.map((title, order) => ({ packageId, title, displayOrder: order }));
      if (pkg.highlights.length) await tx.insert(packageHighlights).values(list(pkg.highlights));
      if (pkg.inclusions.length) await tx.insert(packageInclusions).values(list(pkg.inclusions));
      if (pkg.exclusions.length) await tx.insert(packageExclusions).values(list(pkg.exclusions));
      await tx.insert(packagePrices).values(
        Object.entries(pkg.prices).flatMap(([priceType, byCurrency]) =>
          Object.entries(byCurrency).map(([currencyCode, amount]) => ({
            packageId,
            currencyCode,
            priceType: priceType as "ADULT" | "CHILD" | "INFANT",
            amount,
          })),
        ),
      );
      for (const [index, day] of pkg.itinerary.entries()) {
        const [created] = await tx
          .insert(itineraryDays)
          .values({ packageId, dayNumber: index + 1, title: day.title, description: day.description, stay: day.stay, meals: day.meals })
          .returning({ id: itineraryDays.id });
        if (day.activities.length) {
          await tx.insert(itineraryActivities).values(
            day.activities.map((activity, order) => ({
              itineraryDayId: created!.id,
              time: activity.time,
              title: activity.title,
              location: activity.location ?? null,
              activityType: activity.type as ActivityType,
              displayOrder: order,
            })),
          );
        }
      }
    }
    await refreshSearchText(tx, sql`true`);

    await tx.insert(testimonials).values(data.testimonials.map((t) => ({ ...t, isPublished: true })));
    for (const { image, ...slide } of data.heroSlides) {
      await tx.insert(heroSlides).values({ ...slide, imageId: await upload(image), isPublished: true });
    }

    return { packageIds, images: (await tx.select({ total: count() }).from(media))[0]!.total };
  });

  console.log(
    `Seeded ${data.branches.length} branches, ${data.destinations.length} destinations, ${summary.packageIds.size} packages, ` +
      `${data.testimonials.length} testimonials, ${data.heroSlides.length} hero slides, ${summary.images} images.`,
  );

  const { SEED_ADMIN_EMAIL: email, SEED_ADMIN_PASSWORD: password } = process.env;
  if (email && password && !isProduction) {
    const [found] = await db.select({ id: adminUsers.id }).from(adminUsers).where(eq(sql`lower(${adminUsers.email})`, email.toLowerCase()));
    if (!found) {
      await db.insert(adminUsers).values({ name: "Local admin", email: email.toLowerCase(), role: "SUPER_ADMIN", passwordHash: await hashPassword(password) });
      console.log(`Created super admin ${email} (from SEED_ADMIN_EMAIL).`);
    }
  }

  if (args.has("--pdfs")) {
    for (const [slug, id] of summary.packageIds) {
      const pdf = await ensureCurrentPdf(id, null);
      console.log(`PDF v${pdf.version} ${slug}`);
    }
  }
}

try {
  await seed();
} catch (error) {
  console.error("Seed failed:", error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally {
  await pool.end();
  // The PDF browser closes itself after a minute; do not wait for it.
  setTimeout(() => process.exit(process.exitCode ?? 0), 100).unref();
}
