/**
 * Copies the PostgreSQL data into MongoDB. PostgreSQL is only ever read (one READ ONLY, REPEATABLE READ transaction).
 *   npm run migrate:pg-to-mongo                     dry run: what would be inserted, what is already there, conflicts
 *   npm run migrate:pg-to-mongo -- --apply          inserts the documents MongoDB does not have yet
 *   npm run migrate:pg-to-mongo -- --verify         compares MongoDB with PostgreSQL document by document
 *   npm run migrate:pg-to-mongo -- --export <dir>   writes every PostgreSQL table as JSON, with counts and checksums
 * Re-running is safe: documents are matched by id; identical ones are skipped and existing ones are never
 * overwritten (a difference is reported as a conflict, exit code 1). Ids are kept, so every reference survives.
 * Sources: DATABASE_URL (PostgreSQL) and MONGODB_URI + MONGODB_DB_NAME (MongoDB). Temporary: removed after sign-off.
 */
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import type { Model } from "mongoose";
import pg from "pg";
import { env } from "../config/env.ts";
import { connectDb, disconnectDb } from "../db/client.ts";
import { danglingReferences, ensureIndexes, indexStatus } from "../db/indexes.ts";
import {
  Activity,
  AdminSession,
  AdminUser,
  AuditLog,
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
} from "../db/models.ts";
import { safeMessage } from "../lib/logger.ts";

/* eslint-disable @typescript-eslint/no-explicit-any */
type Row = Record<string, any>;
type Doc = Record<string, any> & { _id: string };

const { values: args } = parseArgs({
  options: { apply: { type: "boolean", default: false }, verify: { type: "boolean", default: false }, export: { type: "string" } },
});

// Numbers as numbers (numeric(12,2) fits a double); calendar dates as "YYYY-MM-DD" text, never shifted by a time zone.
pg.types.setTypeParser(pg.types.builtins.NUMERIC, (value) => Number(value));
pg.types.setTypeParser(pg.types.builtins.DATE, (value) => value);

const camel = (key: string) => key.replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase());
const camelRow = (row: Row) => Object.fromEntries(Object.entries(row).map(([key, value]) => [camel(key), value]));
const groupBy = (rows: Row[], key: string) => {
  const groups = new Map<string, Row[]>();
  for (const row of rows) groups.set(row[key], [...(groups.get(row[key]) ?? []), row]);
  return groups;
};
const without = (row: Row, ...keys: string[]) => Object.fromEntries(Object.entries(row).filter(([key]) => !keys.includes(key)));

const TABLES = [
  "admin_users",
  "admin_sessions",
  "audit_logs",
  "media",
  "currencies",
  "branches",
  "destinations",
  "package_categories",
  "hotels",
  "activities",
  "activity_prices",
  "packages",
  "package_images",
  "package_inclusions",
  "package_exclusions",
  "package_highlights",
  "package_prices",
  "package_hotels",
  "package_activities",
  "itinerary_days",
  "itinerary_activities",
  "itinerary_pdfs",
  "testimonials",
  "hero_slides",
  "site_content",
  "enquiries",
  "enquiry_notes",
] as const;

/** Every table, read in one consistent, read-only snapshot. Child rows come in their display order. */
async function readPostgres() {
  if (!/^postgres(ql)?:\/\//.test(process.env.DATABASE_URL ?? "")) throw new Error("DATABASE_URL must point at the PostgreSQL source");
  const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    await client.query("begin isolation level repeatable read read only");
    const order: Partial<Record<(typeof TABLES)[number], string>> = {
      package_images: "display_order",
      package_inclusions: "display_order",
      package_exclusions: "display_order",
      package_highlights: "display_order",
      package_hotels: "display_order",
      package_activities: "display_order",
      itinerary_days: "day_number",
      itinerary_activities: "display_order",
      enquiry_notes: "created_at",
    };
    const tables = {} as Record<(typeof TABLES)[number], Row[]>;
    for (const table of TABLES) {
      // meal[] is an enum array the driver cannot parse; as text[] it arrives as a normal array.
      const columns = table === "itinerary_days" ? "*, meals::text[] as meals" : "*";
      // Insertion order (ctid) where the old schema had no display order (prices), so lists keep their order.
      const sort = order[table] ? `${order[table]}, ctid` : "ctid";
      tables[table] = (await client.query(`select ${columns} from "${table}" order by ${sort}`)).rows.map(camelRow);
    }
    await client.query("rollback");
    return tables;
  } finally {
    await client.end();
  }
}

type Tables = Awaited<ReturnType<typeof readPostgres>>;

/** The MongoDB documents the PostgreSQL rows become (see src/db/models.ts). */
function transform(t: Tables) {
  const pricesByActivity = groupBy(t.activity_prices, "activityId");
  const byPackage = (rows: Row[]) => groupBy(rows, "packageId");
  const [images, inclusions, exclusions, highlights, prices, hotels, activities, days] = [
    t.package_images,
    t.package_inclusions,
    t.package_exclusions,
    t.package_highlights,
    t.package_prices,
    t.package_hotels,
    t.package_activities,
    t.itinerary_days,
  ].map(byPackage);
  const entriesByDay = groupBy(t.itinerary_activities, "itineraryDayId");
  const notesByEnquiry = groupBy(t.enquiry_notes, "enquiryId");
  const withMongoId = ({ id, ...rest }: Row): Doc => ({ _id: id, ...rest });

  return new Map<Model<any>, Doc[]>([
    [AdminUser, t.admin_users.map((row) => withMongoId({ ...row, email: row.email.toLowerCase() }))],
    [AdminSession, t.admin_sessions.map(withMongoId)],
    [AuditLog, t.audit_logs.map(withMongoId)],
    [Media, t.media.map(withMongoId)],
    [Currency, t.currencies.map(({ code, ...row }) => ({ _id: code, ...row }))],
    [Branch, t.branches.map(withMongoId)],
    [Destination, t.destinations.map(withMongoId)],
    [Category, t.package_categories.map(withMongoId)],
    [Hotel, t.hotels.map(withMongoId)],
    [
      Activity,
      t.activities.map((row) =>
        withMongoId({ ...row, prices: (pricesByActivity.get(row.id) ?? []).map(({ currencyCode, amount }) => ({ currencyCode, amount })) }),
      ),
    ],
    [
      Package,
      t.packages.map((row) =>
        withMongoId({
          ...row,
          gallery: (images.get(row.id) ?? []).map((image) => image.mediaId),
          highlights: (highlights.get(row.id) ?? []).map(({ title, description, icon }) => ({ title, description, icon })),
          inclusions: (inclusions.get(row.id) ?? []).map(({ title, description }) => ({ title, description })),
          exclusions: (exclusions.get(row.id) ?? []).map(({ title, description }) => ({ title, description })),
          prices: (prices.get(row.id) ?? []).map(({ currencyCode, priceType, amount }) => ({ currencyCode, priceType, amount })),
          hotels: (hotels.get(row.id) ?? []).map(({ hotelId, nights, roomType, mealPlan, isDefault }) => ({ hotelId, nights, roomType, mealPlan, isDefault })),
          activityIds: (activities.get(row.id) ?? []).map((activity) => activity.activityId),
          itinerary: (days.get(row.id) ?? []).map((day) => ({
            dayNumber: day.dayNumber,
            title: day.title,
            description: day.description,
            stay: day.stay,
            hotelId: day.hotelId,
            meals: day.meals,
            imageId: day.imageId,
            // Day ids and timestamps are not kept: no API response ever showed them.
            activities: (entriesByDay.get(day.id) ?? []).map((entry) => ({
              time: entry.time ? entry.time.slice(0, 5) : null,
              title: entry.title,
              description: entry.description,
              location: entry.location,
              type: entry.activityType,
              activityId: entry.activityId,
            })),
          })),
        }),
      ),
    ],
    [ItineraryPdf, t.itinerary_pdfs.map(withMongoId)],
    [Testimonial, t.testimonials.map(withMongoId)],
    [HeroSlide, t.hero_slides.map(withMongoId)],
    [SiteContent, t.site_content.map(({ key, ...row }) => ({ _id: key, ...row }))],
    [
      Enquiry,
      t.enquiries.map((row) =>
        withMongoId({ ...row, notes: (notesByEnquiry.get(row.id) ?? []).map((note) => ({ _id: note.id, ...without(note, "id", "enquiryId") })) }),
      ),
    ],
  ]);
}

/** Runs the model's casting, defaults and validation, keeping the source's own timestamps. */
async function prepare(model: Model<any>, raw: Doc): Promise<Doc> {
  const doc = new model(raw);
  await doc.validate().catch((error: Error) => {
    throw new Error(`${model.collection.collectionName} ${raw._id}: ${error.message}`);
  });
  return doc.toObject({ virtuals: false, getters: false, versionKey: false }) as Doc;
}

/** Order-independent for object keys, order-preserving for arrays: equal data gives equal text. */
function canonical(value: unknown): string {
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical((value as Row)[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}

/** Top-level field names that differ (names only: values may be password hashes or personal data). */
const differingFields = (a: Doc, b: Doc) => [...new Set([...Object.keys(a), ...Object.keys(b)])].filter((key) => canonical(a[key]) !== canonical(b[key]));

/** One checksum per collection: the canonical documents sorted by id. Equal data gives an equal checksum. */
const checksum = (docs: Doc[]) =>
  createHash("sha256")
    .update([...docs].sort((a, b) => (a._id < b._id ? -1 : a._id > b._id ? 1 : 0)).map(canonical).join("\n"))
    .digest("hex")
    .slice(0, 16);

/**
 * Fields later stages add on purpose (not from PostgreSQL), left out when comparing with the source:
 * media.cloudinary is set by `media:to-cloudinary` (Stage D).
 */
const ADDED_LATER: Record<string, string[]> = { media: ["cloudinary"] };

interface Comparison {
  collection: string;
  sourceChecksum: string;
  targetChecksum: string;
  source: number;
  target: number;
  identical: number;
  missing: Doc[];
  conflicts: { id: string; fields: string[] }[];
  extra: string[];
}

async function compare(planned: Map<Model<any>, Doc[]>) {
  const results: Comparison[] = [];
  for (const [model, raws] of planned) {
    const docs: Doc[] = [];
    const ignored = ADDED_LATER[model.collection.collectionName] ?? [];
    const strip = (doc: Doc) => (ignored.length ? (without(doc, ...ignored) as Doc) : doc);
    for (const raw of raws) docs.push(strip(await prepare(model, raw)));
    const targetDocs = ((await model.collection.find({}).toArray()) as unknown as Doc[]).map(strip);
    const existing = new Map(targetDocs.map((doc) => [doc._id, doc]));
    const result: Comparison = {
      collection: model.collection.collectionName,
      sourceChecksum: checksum(docs),
      targetChecksum: checksum(targetDocs),
      source: docs.length,
      target: existing.size,
      identical: 0,
      missing: [],
      conflicts: [],
      extra: [],
    };
    for (const doc of docs) {
      const current = existing.get(doc._id);
      if (!current) result.missing.push(doc);
      else if (canonical(current) === canonical(doc)) result.identical++;
      else result.conflicts.push({ id: doc._id, fields: differingFields(current, doc) });
      existing.delete(doc._id);
    }
    result.extra = [...existing.keys()];
    results.push(result);
  }
  return results;
}

function printComparison(results: Comparison[]) {
  console.log("\nCollection            PostgreSQL  MongoDB  Identical  Missing  Conflicts  Only in MongoDB");
  for (const r of results) {
    console.log(
      `${r.collection.padEnd(22)}${String(r.source).padEnd(12)}${String(r.target).padEnd(9)}${String(r.identical).padEnd(11)}${String(r.missing.length).padEnd(9)}${String(r.conflicts.length).padEnd(11)}${r.extra.length}`,
    );
  }
  for (const r of results) for (const c of r.conflicts) console.log(`  conflict ${r.collection} ${c.id}: differs in ${c.fields.join(", ")}`);
}

/** Embedded lists counted on both sides: every child row of PostgreSQL must be inside a MongoDB document. */
async function embeddedCounts(t: Tables) {
  const sum = async (model: Model<any>, path: string) =>
    ((await model.aggregate([{ $project: { n: { $size: { $ifNull: [`$${path}`, []] } } } }, { $group: { _id: null, n: { $sum: "$n" } } }]))[0]?.n as number) ?? 0;
  const timeline = ((await Package.aggregate([{ $unwind: "$itinerary" }, { $project: { n: { $size: "$itinerary.activities" } } }, { $group: { _id: null, n: { $sum: "$n" } } }]))[0]?.n as number) ?? 0;
  return [
    ["package_images -> packages.gallery", t.package_images.length, await sum(Package, "gallery")],
    ["package_highlights -> packages.highlights", t.package_highlights.length, await sum(Package, "highlights")],
    ["package_inclusions -> packages.inclusions", t.package_inclusions.length, await sum(Package, "inclusions")],
    ["package_exclusions -> packages.exclusions", t.package_exclusions.length, await sum(Package, "exclusions")],
    ["package_prices -> packages.prices", t.package_prices.length, await sum(Package, "prices")],
    ["package_hotels -> packages.hotels", t.package_hotels.length, await sum(Package, "hotels")],
    ["package_activities -> packages.activityIds", t.package_activities.length, await sum(Package, "activityIds")],
    ["itinerary_days -> packages.itinerary", t.itinerary_days.length, await sum(Package, "itinerary")],
    ["itinerary_activities -> itinerary[].activities", t.itinerary_activities.length, timeline],
    ["activity_prices -> activities.prices", t.activity_prices.length, await sum(Activity, "prices")],
    ["enquiry_notes -> enquiries.notes", t.enquiry_notes.length, await sum(Enquiry, "notes")],
  ] as const;
}

async function exportTables(dir: string) {
  const tables = await readPostgres();
  const target = resolve(dir);
  mkdirSync(target, { recursive: true });
  const manifest: Record<string, { rows: number; sha256: string }> = {};
  for (const [table, rows] of Object.entries(tables)) {
    const text = JSON.stringify(rows, null, 1);
    writeFileSync(join(target, `${table}.json`), text, { mode: 0o600 });
    manifest[table] = { rows: rows.length, sha256: createHash("sha256").update(text).digest("hex") };
  }
  writeFileSync(join(target, "manifest.json"), JSON.stringify({ exportedAt: new Date().toISOString(), tables: manifest }, null, 1), { mode: 0o600 });
  console.log(`Exported ${Object.keys(manifest).length} tables (${Object.values(manifest).reduce((n, m) => n + m.rows, 0)} rows) to ${target}`);
}

async function main() {
  if (args.export) return exportTables(args.export);
  const tables = await readPostgres();
  const planned = transform(tables);
  await connectDb();
  console.log(`PostgreSQL (read-only snapshot) -> MongoDB database "${env.MONGODB_DB_NAME}". Mode: ${args.apply ? "APPLY" : args.verify ? "VERIFY" : "dry run"}`);

  if (args.apply) {
    await ensureIndexes();
    const before = await compare(planned);
    for (const r of before) {
      if (!r.missing.length) continue;
      const model = [...planned.keys()].find((m) => m.collection.collectionName === r.collection)!;
      // Raw inserts keep the source's createdAt/updatedAt; documents were cast and validated by prepare().
      await model.collection.insertMany(r.missing as any[], { ordered: true });
    }
    const after = await compare(planned);
    printComparison(after);
    const inserted = before.reduce((n, r) => n + r.missing.length, 0);
    const conflicts = after.reduce((n, r) => n + r.conflicts.length, 0);
    console.log(`\nInserted ${inserted} document(s). ${conflicts ? `${conflicts} conflict(s) left untouched: review them.` : "No conflicts."}`);
    process.exitCode = conflicts ? 1 : 0;
    return;
  }

  const results = await compare(planned);
  printComparison(results);
  if (!args.verify) {
    console.log(`\nDry run: ${results.reduce((n, r) => n + r.missing.length, 0)} document(s) would be inserted. Nothing was written.`);
    process.exitCode = results.some((r) => r.conflicts.length) ? 1 : 0;
    return;
  }

  // Verification: every document identical, nothing missing or extra, embedded lists complete, references and indexes sound.
  const problems: string[] = [];
  for (const r of results) {
    if (r.source !== r.target) problems.push(`${r.collection}: ${r.source} in PostgreSQL, ${r.target} in MongoDB`);
    if (r.missing.length) problems.push(`${r.collection}: ${r.missing.length} document(s) missing`);
    if (r.conflicts.length) problems.push(`${r.collection}: ${r.conflicts.length} document(s) differ`);
    if (r.extra.length) problems.push(`${r.collection}: ${r.extra.length} document(s) only in MongoDB`);
  }
  console.log("\nCollection checksums (sha256 of canonical documents)  PostgreSQL        MongoDB           Match");
  for (const r of results) {
    console.log(`${r.collection.padEnd(54)}${r.sourceChecksum.padEnd(18)}${r.targetChecksum.padEnd(18)}${r.sourceChecksum === r.targetChecksum ? "yes" : "NO"}`);
    if (r.sourceChecksum !== r.targetChecksum) problems.push(`${r.collection}: checksum differs`);
  }
  console.log("\nEmbedded rows                                   PostgreSQL  MongoDB");
  for (const [label, source, target] of await embeddedCounts(tables)) {
    console.log(`${label.padEnd(48)}${String(source).padEnd(12)}${target}`);
    if (source !== target) problems.push(`${label}: ${source} rows, ${target} embedded`);
  }
  for (const d of await danglingReferences()) problems.push(`${d.from}.${d.path}: ${d.missing.length} reference(s) to missing ${d.to}`);
  for (const s of await indexStatus()) if (!s.exists || s.missing.length) problems.push(`${s.collection}: indexes not applied`);

  if (problems.length) {
    console.log(`\nNOT verified. ${problems.length} problem(s):`);
    for (const problem of problems) console.log(`  - ${problem}`);
    process.exitCode = 1;
  } else {
    console.log("\nVerified: every PostgreSQL row is in MongoDB, field for field, with the same ids; every reference resolves; indexes applied.");
  }
}

try {
  await main();
} catch (error) {
  console.error("Migration failed:", safeMessage(error));
  process.exitCode = 1;
} finally {
  await disconnectDb();
}
