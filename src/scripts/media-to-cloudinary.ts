/**
 * Moves files in local storage to Cloudinary. Local files are only read, never changed or deleted.
 *   npm run media:to-cloudinary [-- --documents]                dry run: matches records to files, plans the uploads
 *   npm run media:to-cloudinary -- [--documents] --apply        uploads, verifies each asset, then records it
 *   npm run media:to-cloudinary -- [--documents] --verify       checks every record against Cloudinary and its original
 * Images (default): public assets at <CLOUDINARY_FOLDER>/images/<media id> (Stage D).
 * Documents (--documents, the itinerary PDFs): PRIVATE assets (raw, authenticated) at <CLOUDINARY_FOLDER>/<storage key>,
 * keeping their original path and file name; verified to be unreachable without a signature (Stage E).
 * Safe to re-run: public ids are fixed, so a file already on Cloudinary is adopted, not uploaded twice; a record is only
 * updated after its asset is verified, and never when it already points at a different asset. Records created
 * directly on Cloudinary (no local original) are verified by download only.
 * Temporary: removed after the migration is signed off.
 */
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { parseArgs } from "node:util";
import { env } from "../config/env.ts";
import { connectDb, disconnectDb } from "../db/client.ts";
import { ensureIndexes } from "../db/indexes.ts";
import { Media, type CloudinaryAsset, type MediaDoc } from "../db/models.ts";
import { safeMessage } from "../lib/logger.ts";
import {
  documentPublicId,
  documentsFolder,
  downloadDocument,
  imagePublicId,
  imagesFolder,
  listDocumentIds,
  listImageIds,
  uploadDocument,
  uploadImage,
} from "../modules/cloudinary.ts";
import { sniffImage } from "../modules/storage.ts";

const { values: args } = parseArgs({
  options: { apply: { type: "boolean", default: false }, verify: { type: "boolean", default: false }, documents: { type: "boolean", default: false } },
});
const root = resolve(env.STORAGE_LOCAL_DIR);
const hash = (algorithm: "sha256" | "md5", data: Buffer) => createHash(algorithm).update(data).digest("hex");

type Fetched = { data: Buffer } | { problem: string };

/** What differs between images and documents. */
interface Profile {
  kind: MediaDoc["kind"];
  noun: string;
  dir: string;
  folder: () => string;
  publicId: (doc: MediaDoc) => string;
  upload: (doc: MediaDoc, data: Buffer) => Promise<{ asset: CloudinaryAsset; existing: boolean; etag?: string }>;
  isType: (doc: MediaDoc, data: Buffer) => boolean;
  stored: { resourceType: string; type: string };
  /** The file as Cloudinary delivers it to the API. */
  fetch: (asset: CloudinaryAsset) => Promise<Fetched>;
  /** Extra condition on the stored asset (documents: must not be publicly reachable). */
  extraCheck: (asset: CloudinaryAsset) => Promise<string | null>;
  list: (prefix: string) => Promise<string[]>;
}

const fetchPublic = async (asset: CloudinaryAsset): Promise<Fetched> => {
  const response = await fetch(asset.secureUrl, { signal: AbortSignal.timeout(30_000) });
  if (!response.ok) return { problem: `delivery answered ${response.status}` };
  if (!response.headers.get("content-type")?.startsWith("image/")) return { problem: `delivery type ${response.headers.get("content-type")}` };
  return { data: Buffer.from(await response.arrayBuffer()) };
};

const PROFILES: Record<"images" | "documents", Profile> = {
  images: {
    kind: "IMAGE",
    noun: "image",
    dir: "images",
    folder: imagesFolder,
    publicId: (doc) => imagePublicId(doc._id),
    upload: (doc, data) => uploadImage(doc._id, data),
    isType: (doc, data) => sniffImage(data)?.mime === doc.mimeType,
    stored: { resourceType: "image", type: "upload" },
    fetch: fetchPublic,
    extraCheck: async () => null,
    list: listImageIds,
  },
  documents: {
    kind: "DOCUMENT",
    noun: "PDF",
    dir: "documents",
    folder: documentsFolder,
    publicId: (doc) => documentPublicId(doc.storageKey),
    upload: (doc, data) => uploadDocument(documentPublicId(doc.storageKey), data),
    isType: (doc, data) => doc.mimeType === "application/pdf" && data.subarray(0, 5).toString("ascii") === "%PDF-",
    stored: { resourceType: "raw", type: "authenticated" },
    fetch: async (asset) => {
      try {
        return { data: await downloadDocument(asset.publicId) };
      } catch (error) {
        return { problem: safeMessage(error) };
      }
    },
    extraCheck: async (asset) => {
      // Private means private: the plain URL, without a signature, must be refused.
      const response = await fetch(asset.secureUrl, { signal: AbortSignal.timeout(30_000) });
      await response.arrayBuffer().catch(() => null);
      return response.status === 401 || response.status === 404 ? null : `publicly reachable without a signature (HTTP ${response.status})`;
    },
    list: listDocumentIds,
  },
};

const profile = PROFILES[args.documents ? "documents" : "images"];

interface Item {
  doc: MediaDoc;
  data: Buffer | null;
  /** Created directly on Cloudinary: there is no local original to compare with. */
  bornOnCloudinary: boolean;
  problem: string | null;
}

/** Every record matched to its local file: present, same size, really the type recorded. */
function inventory(docs: MediaDoc[]): Item[] {
  return docs.map((doc) => {
    if (doc.cloudinary && doc.storageKey === doc.cloudinary.publicId) return { doc, data: null, bornOnCloudinary: true, problem: null };
    const path = join(root, doc.storageKey);
    if (!doc.storageKey.startsWith(`${profile.dir}/`) || !existsSync(path)) return { doc, data: null, bornOnCloudinary: false, problem: "local file missing" };
    const data = readFileSync(path);
    if (data.length !== doc.sizeBytes) return { doc, data, bornOnCloudinary: false, problem: `size ${data.length} differs from the record (${doc.sizeBytes})` };
    if (!profile.isType(doc, data)) return { doc, data, bornOnCloudinary: false, problem: `content is not ${doc.mimeType}` };
    return { doc, data, bornOnCloudinary: false, problem: null };
  });
}

/** Everything that must hold before a record may point at an asset (and keep pointing at it). */
async function verifyAsset(item: Item, asset: CloudinaryAsset, etag?: string) {
  const expected = item.bornOnCloudinary ? item.doc.storageKey : profile.publicId(item.doc);
  if (asset.publicId !== expected) return `public id ${asset.publicId}, expected ${expected}`;
  if (asset.resourceType !== profile.stored.resourceType || asset.type !== profile.stored.type) return `stored as ${asset.resourceType}/${asset.type}`;
  if (asset.bytes !== item.doc.sizeBytes) return `Cloudinary has ${asset.bytes} bytes, the record ${item.doc.sizeBytes}`;
  if (etag && item.data && etag !== hash("md5", item.data)) return "Cloudinary checksum (etag) differs from the local file";
  const extra = await profile.extraCheck(asset);
  if (extra) return extra;
  const fetched = await profile.fetch(asset);
  if ("problem" in fetched) return fetched.problem;
  if (item.data) return hash("sha256", fetched.data) === hash("sha256", item.data) ? null : "delivered bytes differ from the local original";
  return fetched.data.length === item.doc.sizeBytes && profile.isType(item.doc, fetched.data) ? null : "delivered file does not match the record";
}

const sameAsset = (a: CloudinaryAsset, b: CloudinaryAsset) => a.publicId === b.publicId && a.secureUrl === b.secureUrl && a.bytes === b.bytes;

async function main() {
  for (const name of ["CLOUDINARY_CLOUD_NAME", "CLOUDINARY_API_KEY", "CLOUDINARY_API_SECRET", "CLOUDINARY_FOLDER"] as const) {
    if (!env[name]) throw new Error(`${name} is not set`);
  }
  await connectDb();
  const records = await Media.find({ kind: profile.kind }).sort({ createdAt: 1, _id: 1 }).lean<MediaDoc[]>();
  const others = await Media.countDocuments({ kind: { $ne: profile.kind } });
  const items = inventory(records);
  const referenced = new Set(records.map((doc) => doc.storageKey));
  const localDir = join(root, profile.dir);
  const localFiles = existsSync(localDir)
    ? (readdirSync(localDir, { recursive: true }) as string[]).map((file) => relative(root, join(localDir, file))).filter((file) => /\.[a-z0-9]+$/i.test(file))
    : [];
  const unreferenced = localFiles.filter((file) => !referenced.has(file));
  const migrated = items.filter((item) => item.doc.cloudinary);

  console.log(`MongoDB database "${env.MONGODB_DB_NAME}" -> Cloudinary folder "${profile.folder()}" (${profile.noun}s). Mode: ${args.apply ? "APPLY" : args.verify ? "VERIFY" : "dry run"}`);
  console.log(`Inventory: ${records.length} ${profile.noun} records (${records.filter((d) => d.deletedAt).length} archived), ${localFiles.length} files in ${relative(process.cwd(), localDir) || localDir}`);
  console.log(`  records matched to an intact local file: ${items.filter((i) => !i.problem && !i.bornOnCloudinary).length}; created directly on Cloudinary: ${items.filter((i) => i.bornOnCloudinary).length}`);
  for (const item of items.filter((i) => i.problem)) console.log(`  PROBLEM ${item.doc._id} (${item.doc.storageKey}): ${item.problem}`);
  console.log(`  local files no record points at: ${unreferenced.length}${unreferenced.length ? ` (${unreferenced.slice(0, 5).join(", ")})` : ""}`);
  console.log(`  already on Cloudinary: ${migrated.length}; to upload: ${items.length - migrated.length}`);
  console.log(`  other media records (${others}): not touched by this run`);

  if (!args.apply && !args.verify) {
    console.log("\nDry run: nothing was uploaded or changed.");
    process.exitCode = items.some((i) => i.problem) ? 1 : 0;
    return;
  }

  if (args.apply) {
    await ensureIndexes();
    const result = { uploaded: 0, adopted: 0, alreadyDone: 0, failed: [] as string[] };
    for (const item of items) {
      const label = `${item.doc._id} (${item.doc.fileName})`;
      if (item.problem) {
        result.failed.push(`${label}: ${item.problem}; not uploaded`);
        continue;
      }
      if (item.doc.cloudinary) {
        result.alreadyDone++;
        continue;
      }
      try {
        const { asset, existing, etag } = await profile.upload(item.doc, item.data!);
        const problem = await verifyAsset(item, asset, etag);
        if (problem) {
          result.failed.push(`${label}: uploaded but not verified (${problem}); record left unchanged`);
          continue;
        }
        // Only now, and only if no other asset was recorded meanwhile.
        const updated = await Media.updateOne({ _id: item.doc._id, $or: [{ cloudinary: null }, { cloudinary: { $exists: false } }] }, { $set: { cloudinary: asset } });
        if (!updated.modifiedCount) {
          const current = (await Media.findById(item.doc._id).lean<MediaDoc>())?.cloudinary;
          if (!current || !sameAsset(current, asset)) result.failed.push(`${label}: record changed meanwhile; left unchanged`);
          else result.alreadyDone++;
          continue;
        }
        if (existing) result.adopted++;
        else result.uploaded++;
        console.log(`  ok ${label} -> ${asset.publicId}${existing ? " (already on Cloudinary, adopted)" : ""}`);
      } catch (error) {
        result.failed.push(`${label}: ${safeMessage(error)}; record left unchanged`);
      }
    }
    console.log(`\nUploaded and verified: ${result.uploaded}. Already on Cloudinary, verified and recorded: ${result.adopted}. Already recorded before this run: ${result.alreadyDone}. Failed: ${result.failed.length}.`);
    for (const failure of result.failed) console.log(`  FAILED ${failure}`);
    process.exitCode = result.failed.length ? 1 : 0;
    return;
  }

  // --verify: every record on Cloudinary, delivered identical to its untouched local original, no strays.
  const problems: string[] = [];
  let verified = 0;
  for (const item of items) {
    const label = `${item.doc._id} (${item.doc.fileName})`;
    if (item.problem) problems.push(`${label}: local original: ${item.problem}`);
    else if (!item.doc.cloudinary) problems.push(`${label}: not on Cloudinary yet`);
    else {
      const problem = await verifyAsset(item, item.doc.cloudinary);
      if (problem) problems.push(`${label}: ${problem}`);
      else verified++;
    }
  }
  const onCloudinary = await profile.list(`${profile.folder()}/`);
  const expected = new Set(records.map((doc) => doc.cloudinary?.publicId ?? profile.publicId(doc)));
  const strays = onCloudinary.filter((id) => !expected.has(id));
  if (strays.length) problems.push(`${strays.length} asset(s) under ${profile.folder()} belong to no record: ${strays.slice(0, 5).join(", ")}`);
  console.log(`\nCloudinary assets under ${profile.folder()}/: ${onCloudinary.length} (expected ${expected.size}, duplicates or strays: ${strays.length})`);
  console.log(`Records verified (public id, type, size, ${args.documents ? "private, " : ""}delivered bytes = original): ${verified} of ${items.length}`);
  if (problems.length) {
    console.log(`NOT verified. ${problems.length} problem(s):`);
    for (const problem of problems) console.log(`  - ${problem}`);
    process.exitCode = 1;
  } else {
    console.log(`Verified: every ${profile.noun} is on Cloudinary${args.documents ? " (private)" : ""}, delivered identical to its original, with no duplicate assets.`);
  }
}

try {
  await main();
} catch (error) {
  console.error("Media migration failed:", safeMessage(error));
  process.exitCode = 1;
} finally {
  await disconnectDb();
}
