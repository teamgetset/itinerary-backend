import { readFileSync } from "node:fs";
import { and, desc, eq, inArray, isNull, max } from "drizzle-orm";
import { env } from "../../config/env.ts";
import { db } from "../../db/client.ts";
import { itineraryPdfs, media, packages } from "../../db/schema.ts";
import { sha256 } from "../../lib/crypto.ts";
import { notFound } from "../../lib/errors.ts";
import type { AdminContext } from "../../lib/http.ts";
import { log } from "../../lib/logger.ts";
import { audit } from "../audit.ts";
import { activeCurrencies } from "../currencies.ts";
import { loadPackageGraph, packageDetail } from "../packages/read.ts";
import { storage } from "../storage.ts";
import { renderPdf } from "./render.ts";
import { TEMPLATE_VERSION, footerTemplate, itineraryHtml, type Branding } from "./template.ts";

/*
 * Itinerary PDFs are generated from package data, never uploaded by hand. Each version stores both prints
 * (with and without the logo) and the hash of everything it printed. When the package, its branch, its
 * destination or the shared notes change, the hash changes, so the next request builds a new version:
 * the site can never hand out a PDF that disagrees with the page.
 */

const LOGO = `data:image/png;base64,${readFileSync(new URL("../../assets/getset-logo.png", import.meta.url)).toString("base64")}`;
const BRANDINGS: Branding[] = ["with-logo", "without-logo"];

export interface PdfFileInfo {
  mediaId: string;
  storageKey: string;
  fileName: string;
  sizeBytes: number;
}

export interface PdfVersion {
  id: string;
  version: number;
  contentHash: string;
  generatedAt: Date;
  withLogo: PdfFileInfo;
  withoutLogo: PdfFileInfo;
}

async function toVersions(rows: (typeof itineraryPdfs.$inferSelect)[]): Promise<PdfVersion[]> {
  const ids = rows.flatMap((row) => [row.withLogoMediaId, row.withoutLogoMediaId]);
  const files = ids.length ? await db.select().from(media).where(inArray(media.id, ids)) : [];
  const file = (id: string): PdfFileInfo => {
    const row = files.find((f) => f.id === id)!;
    return { mediaId: row.id, storageKey: row.storageKey, fileName: row.fileName, sizeBytes: row.sizeBytes };
  };
  return rows.map((row) => ({
    id: row.id,
    version: row.version,
    contentHash: row.contentHash,
    generatedAt: row.generatedAt,
    withLogo: file(row.withLogoMediaId),
    withoutLogo: file(row.withoutLogoMediaId),
  }));
}

/** The package as printed, plus the hash identifying exactly that content. */
async function printModel(packageId: string) {
  const graph = await loadPackageGraph(and(eq(packages.id, packageId), isNull(packages.deletedAt))!);
  if (!graph) throw notFound("Package");
  const [detail, currencies] = await Promise.all([packageDetail(graph), activeCurrencies()]);
  const photoIds = [graph.heroImageId, ...graph.images.slice(0, 2).map((image) => image.mediaId)];
  // Only what appears on paper counts: SEO, reviews, flags and timestamps do not.
  const { updatedAt: _u, publishedAt: _p, pdf: _pdf, seo: _s, reviews: _r, isFeatured: _f, isRecommended: _rc, keywords: _k, ...printed } = detail;
  const hash = sha256(
    JSON.stringify({
      template: TEMPLATE_VERSION,
      printed,
      photoIds,
      currencies: currencies.map((c) => [c.code, c.symbol, c.locale]),
      site: env.FRONTEND_URL,
    }),
  );
  return { graph, detail, currencies, photoIds, hash };
}

async function embedImage(id: string | null | undefined) {
  if (!id) return null;
  const [row] = await db.select().from(media).where(eq(media.id, id)).limit(1);
  const data = row ? await storage.get(row.storageKey) : null;
  return row && data ? `data:${row.mimeType};base64,${data.toString("base64")}` : null;
}

async function generate(model: Awaited<ReturnType<typeof printModel>>, admin: AdminContext | null): Promise<PdfVersion> {
  const { graph, detail, currencies } = model;
  const [{ latest }] = await db.select({ latest: max(itineraryPdfs.version) }).from(itineraryPdfs).where(eq(itineraryPdfs.packageId, graph.id));
  const version = (latest ?? 0) + 1;
  const meta = { version, updatedAt: new Date(), currencies, siteUrl: env.FRONTEND_URL };
  const [hero, ...gallery] = await Promise.all(model.photoIds.map(embedImage));
  const images = { logo: LOGO, hero: hero ?? null, gallery: gallery.filter((src): src is string => !!src) };

  const files = {} as Record<Branding, { key: string; size: number; fileName: string }>;
  for (const branding of BRANDINGS) {
    const pdf = await renderPdf(itineraryHtml(detail, branding, images, meta), footerTemplate(detail, meta));
    const key = `documents/itineraries/${graph.id}/v${version}-${branding}.pdf`;
    await storage.put(key, pdf, "application/pdf");
    files[branding] = {
      key,
      size: pdf.length,
      fileName: `getset-${graph.slug}-itinerary${branding === "without-logo" ? "-no-logo" : ""}.pdf`,
    };
  }

  const row = await db.transaction(async (tx) => {
    const [withLogo, withoutLogo] = await tx
      .insert(media)
      .values(
        BRANDINGS.map((branding) => ({
          kind: "DOCUMENT" as const,
          storageKey: files[branding].key,
          fileName: files[branding].fileName,
          mimeType: "application/pdf",
          sizeBytes: files[branding].size,
          altText: `${graph.title} itinerary${branding === "without-logo" ? " (without logo)" : ""}`,
          uploadedById: admin?.id ?? null,
        })),
      )
      .returning({ id: media.id });
    const [created] = await tx
      .insert(itineraryPdfs)
      .values({
        packageId: graph.id,
        version,
        contentHash: model.hash,
        withLogoMediaId: withLogo!.id,
        withoutLogoMediaId: withoutLogo!.id,
        generatedById: admin?.id ?? null,
      })
      .returning();
    await audit(tx, admin, "PDF_GENERATED", "package", graph.id, { version });
    return created!;
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
    const [match] = await db
      .select()
      .from(itineraryPdfs)
      .where(and(eq(itineraryPdfs.packageId, packageId), eq(itineraryPdfs.contentHash, model.hash)))
      .orderBy(desc(itineraryPdfs.version))
      .limit(1);
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
    db.select().from(itineraryPdfs).where(eq(itineraryPdfs.packageId, packageId)).orderBy(desc(itineraryPdfs.version)),
  ]);
  const versions = await toVersions(rows);
  const current = versions.find((v) => v.contentHash === model.hash) ?? null;
  return { current, upToDate: !!current && current.version === versions[0]?.version, versions };
}

export async function findPdfVersion(packageId: string, version: number) {
  const [row] = await db
    .select()
    .from(itineraryPdfs)
    .where(and(eq(itineraryPdfs.packageId, packageId), eq(itineraryPdfs.version, version)))
    .limit(1);
  if (!row) throw notFound("PDF version");
  return (await toVersions([row]))[0]!;
}

export async function readPdf(file: PdfFileInfo) {
  const data = await storage.get(file.storageKey);
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
