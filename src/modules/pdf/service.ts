import { readFileSync } from "node:fs";
import { env } from "../../config/env.ts";
import { transaction } from "../../db/client.ts";
import { ItineraryPdf, Media, type CloudinaryAsset, type ItineraryPdfDoc, type MediaDoc } from "../../db/models.ts";
import { sha256 } from "../../lib/crypto.ts";
import { notFound } from "../../lib/errors.ts";
import type { AdminContext } from "../../lib/http.ts";
import { log } from "../../lib/logger.ts";
import { audit } from "../audit.ts";
import { activeCurrencies } from "../currencies.ts";
import { loadPackageGraph, packageDetail } from "../packages/read.ts";
import { readDocument, readImage, storeDocument, type StoredImage } from "../media/store.ts";
import { renderPdf } from "./render.ts";
import { TEMPLATE_VERSION, footerTemplate, itineraryHtml, type Branding } from "./template.ts";

/*
 * Itinerary PDFs are generated from package data, never uploaded by hand. Each version stores both prints
 * (with and without the logo) and the hash of everything it printed. When the package, its branch, its
 * destination or the shared notes change, the hash changes, so the next request builds a new version:
 * the site can never hand out a PDF that disagrees with the page.
 * Prints are stored like other files (media/store.ts): on Cloudinary as private assets, read back by the API with a
 * signed link and streamed to the visitor, or on local disk. No PDF is ever publicly reachable on Cloudinary.
 */

const LOGO = `data:image/png;base64,${readFileSync(new URL("../../assets/getset-logo.png", import.meta.url)).toString("base64")}`;
const BRANDINGS: Branding[] = ["with-logo", "without-logo"];

export interface PdfFileInfo {
  mediaId: string;
  storageKey: string;
  fileName: string;
  sizeBytes: number;
  /** Set when the print lives on Cloudinary (private). Internal: never part of an API response. */
  cloudinary: CloudinaryAsset | null;
}

export interface PdfVersion {
  id: string;
  version: number;
  contentHash: string;
  generatedAt: Date;
  withLogo: PdfFileInfo;
  withoutLogo: PdfFileInfo;
}

/** A version as the admin API shows it: the same fields as before the move to Cloudinary, no storage internals. */
export const versionDto = ({ withLogo, withoutLogo, ...version }: PdfVersion) => {
  const file = ({ cloudinary: _c, ...info }: PdfFileInfo) => info;
  return { ...version, withLogo: file(withLogo), withoutLogo: file(withoutLogo) };
};

async function toVersions(rows: ItineraryPdfDoc[]): Promise<PdfVersion[]> {
  const ids = rows.flatMap((row) => [row.withLogoMediaId, row.withoutLogoMediaId]);
  const files = ids.length ? await Media.find({ _id: { $in: ids } }).lean<MediaDoc[]>() : [];
  const file = (id: string): PdfFileInfo => {
    const row = files.find((f) => f._id === id)!;
    return { mediaId: row._id, storageKey: row.storageKey, fileName: row.fileName, sizeBytes: row.sizeBytes, cloudinary: row.cloudinary ?? null };
  };
  return rows.map((row) => ({
    id: row._id,
    version: row.version,
    contentHash: row.contentHash,
    generatedAt: row.generatedAt,
    withLogo: file(row.withLogoMediaId),
    withoutLogo: file(row.withoutLogoMediaId),
  }));
}

/** The package as printed, plus the hash identifying exactly that content. */
async function printModel(packageId: string) {
  const graph = await loadPackageGraph({ _id: packageId, deletedAt: null });
  if (!graph) throw notFound("Package");
  const [detail, currencies] = await Promise.all([packageDetail(graph), activeCurrencies()]);
  const photoIds = [graph.heroImageId, ...graph.gallery.slice(0, 2)];
  // Only what appears on paper counts: SEO, reviews, flags and timestamps do not. Neither do image URLs: photos are
  // embedded from their bytes and identified by media id (photoIds), so moving files to another host is not a change.
  const { updatedAt: _u, publishedAt: _p, pdf: _pdf, seo: _s, reviews: _r, isFeatured: _f, isRecommended: _rc, keywords: _k, ...printed } = detail;
  const hash = sha256(
    JSON.stringify(
      {
        template: TEMPLATE_VERSION,
        printed,
        photoIds,
        currencies: currencies.map((c) => [c.code, c.symbol, c.locale]),
        site: env.FRONTEND_URL,
      },
      (key, value) => (key === "url" ? undefined : value),
    ),
  );
  return { graph, detail, currencies, photoIds, hash };
}

async function embedImage(id: string | null | undefined) {
  if (!id) return null;
  const row = await Media.findById(id).lean<MediaDoc>();
  const data = row ? await readImage(row) : null;
  return row && data ? `data:${row.mimeType};base64,${data.toString("base64")}` : null;
}

async function generate(model: Awaited<ReturnType<typeof printModel>>, admin: AdminContext | null): Promise<PdfVersion> {
  const { graph, detail, currencies } = model;
  const latest = await ItineraryPdf.findOne({ packageId: graph.id }, { version: 1 }).sort({ version: -1 }).lean<Pick<ItineraryPdfDoc, "version">>();
  const version = (latest?.version ?? 0) + 1;
  const meta = { version, updatedAt: new Date(), currencies, siteUrl: env.FRONTEND_URL };
  const [hero, ...gallery] = await Promise.all(model.photoIds.map(embedImage));
  const images = { logo: LOGO, hero: hero ?? null, gallery: gallery.filter((src): src is string => !!src) };

  const files = {} as Record<Branding, { stored: StoredImage; size: number; fileName: string }>;
  for (const branding of BRANDINGS) {
    const pdf = await renderPdf(itineraryHtml(detail, branding, images, meta), footerTemplate(detail, meta));
    // The content hash in the name means a file left behind by an interrupted run is only ever reused for the
    // same content. ponytail: such leftovers are not cleaned up (harmless); a sweep can come later if they pile up.
    const key = `documents/itineraries/${graph.id}/v${version}-${branding}-${model.hash.slice(0, 12)}.pdf`;
    files[branding] = {
      stored: await storeDocument(key, pdf),
      size: pdf.length,
      fileName: `getset-${graph.slug}-itinerary${branding === "without-logo" ? "-no-logo" : ""}.pdf`,
    };
  }

  const row = await transaction(async () => {
    const [withLogo, withoutLogo] = await Media.create(
      BRANDINGS.map((branding) => ({
        kind: "DOCUMENT" as const,
        storageKey: files[branding].stored.storageKey,
        cloudinary: files[branding].stored.cloudinary,
        fileName: files[branding].fileName,
        mimeType: "application/pdf",
        sizeBytes: files[branding].size,
        altText: `${graph.title} itinerary${branding === "without-logo" ? " (without logo)" : ""}`,
        uploadedById: admin?.id ?? null,
      })),
      { ordered: true },
    );
    const [created] = await ItineraryPdf.create([
      {
        packageId: graph.id,
        version,
        contentHash: model.hash,
        withLogoMediaId: withLogo!._id,
        withoutLogoMediaId: withoutLogo!._id,
        generatedById: admin?.id ?? null,
      },
    ]);
    await audit(admin, "PDF_GENERATED", "package", graph.id, { version });
    return created!.toObject() as ItineraryPdfDoc;
  });
  log.info("pdf.generated", { packageId: graph.id, version, bytes: files["with-logo"].size + files["without-logo"].size });
  return (await toVersions([row]))[0]!;
}

const running = new Map<string, Promise<PdfVersion>>();

/**
 * The PDF version matching the package's current content, generating one if needed.
 * Concurrent calls for the same package share one generation.
 * ponytail: the lock is per process; across instances the unique (package, version) constraint stops duplicates.
 */
export function ensureCurrentPdf(packageId: string, admin: AdminContext | null): Promise<PdfVersion> {
  const existing = running.get(packageId);
  if (existing) return existing;
  const job = (async () => {
    const model = await printModel(packageId);
    const match = await ItineraryPdf.findOne({ packageId, contentHash: model.hash }).sort({ version: -1 }).lean<ItineraryPdfDoc>();
    return match ? (await toVersions([match]))[0]! : generate(model, admin);
  })().finally(() => running.delete(packageId));
  running.set(packageId, job);
  return job;
}

const refreshTimers = new Map<string, NodeJS.Timeout>();

/** After edits to a live package, rebuild its PDF in the background (debounced, so a burst of saves builds once). */
export function schedulePdfRefresh(packageId: string) {
  clearTimeout(refreshTimers.get(packageId));
  const timer = setTimeout(() => {
    refreshTimers.delete(packageId);
    ensureCurrentPdf(packageId, null).catch((error) => log.error("pdf.refresh_failed", { packageId, error }));
  }, 3000);
  timer.unref();
  refreshTimers.set(packageId, timer);
}

/** For the admin: every version, and whether the newest one still matches the package. */
export async function pdfStatus(packageId: string) {
  const [model, rows] = await Promise.all([
    printModel(packageId),
    ItineraryPdf.find({ packageId }).sort({ version: -1 }).lean<ItineraryPdfDoc[]>(),
  ]);
  const versions = (await toVersions(rows)).map(versionDto);
  const current = versions.find((v) => v.contentHash === model.hash) ?? null;
  return { current, upToDate: !!current && current.version === versions[0]?.version, versions };
}

export async function findPdfVersion(packageId: string, version: number) {
  const row = await ItineraryPdf.findOne({ packageId, version }).lean<ItineraryPdfDoc>();
  if (!row) throw notFound("PDF version");
  return (await toVersions([row]))[0]!;
}

export async function readPdf(file: PdfFileInfo) {
  const data = await readDocument(file);
  if (!data) throw notFound("PDF file");
  return data;
}

export const pdfHeaders = (file: PdfFileInfo, disposition: "attachment" | "inline") => ({
  "Content-Type": "application/pdf",
  "Content-Disposition": `${disposition}; filename="${file.fileName}"`,
  "Content-Length": String(file.sizeBytes),
  "X-Content-Type-Options": "nosniff",
});

export const BRANDING_VALUES = BRANDINGS;
