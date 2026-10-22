import { randomUUID } from "node:crypto";
import { z } from "zod";
import { env } from "../config/env.ts";
import { GoogleReview, Package, type GoogleReviewDoc } from "../db/models.ts";
import { log } from "../lib/logger.ts";
import { crudRoutes, optionalId } from "./crud.ts";
import { packageTitles } from "./shared.ts";

/*
 * Reviews of GETSET's own Google Business Profiles, read with the Business Profile API on the owner's behalf
 * (OAuth refresh token, scope business.manage). Every review of every profile in GOOGLE_BUSINESS_LOCATIONS is read,
 * 50 per page, following nextPageToken; rate limits and Google's own errors are retried with a pause.
 *
 * Each review is kept as one document (keyed by Google's review id, so a review is never stored twice), for the admin
 * to say which package it is about; a review not linked to a package stays a general one. Google's API policy allows
 * keeping the content for at most 30 days, securely and unchanged: every sync (every 6 hours) rewrites it as Google
 * gives it and deletes the reviews Google no longer has, and a review not read again within 30 days (Google out of
 * reach) is deleted, its package link with it. Without the GOOGLE_* settings this is switched off and the site shows
 * no Google reviews.
 */

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const REVIEWS_API = "https://mybusiness.googleapis.com/v4";
const INFO_API = "https://mybusinessbusinessinformation.googleapis.com/v1";
const HOUR = 60 * 60 * 1000;
const REFRESH_AFTER = 6 * HOUR;
/** After a failed refresh, wait this long before asking Google again. */
const RETRY_AFTER = 0.25 * HOUR;
/** Google's limit for keeping Business Profile content. */
const MAX_AGE = 30 * 24 * HOUR;
/** A safety stop (2,500 reviews a profile), not a limit in practice. */
const MAX_PAGES = 50;
const STARS: Record<string, number> = { ONE: 1, TWO: 2, THREE: 3, FOUR: 4, FIVE: 5 };

interface ApiReview {
  reviewId: string;
  reviewer?: { displayName?: string; profilePhotoUrl?: string; isAnonymous?: boolean };
  starRating?: string;
  comment?: string;
  createTime: string;
  updateTime?: string;
}

interface FetchedReview {
  id: string;
  /** Null for an anonymous reviewer. */
  author: string | null;
  photoUrl: string | null;
  rating: number;
  /** As written on Google ("" for a rating without words). */
  text: string;
  createTime: string;
  /** The profile it was left on. */
  location: string;
}

export interface GoogleLocation {
  name: string;
  /** Business name and Google Maps link, as Google gives them (null if that lookup failed). */
  title: string | null;
  mapsUri: string | null;
  averageRating: number | null;
  totalReviewCount: number;
}

interface Snapshot {
  fetchedAt: number;
  locations: GoogleLocation[];
}

export const googleReviewsConfigured = () => env.GOOGLE_BUSINESS_LOCATIONS.length > 0;

class GoogleError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** A request to Google; 429 (rate limit) and 5xx are retried up to 3 times, honouring Retry-After. */
async function request(url: string, init: RequestInit): Promise<unknown> {
  for (let attempt = 1; ; attempt++) {
    const response = await fetch(url, { ...init, signal: AbortSignal.timeout(15_000) });
    if (response.ok) return response.json();
    const retryable = response.status === 429 || response.status >= 500;
    if (!retryable || attempt === 3) {
      // Google's error message, never the request (it carries the token).
      const detail = await response.text().catch(() => "");
      throw new GoogleError(response.status, `${new URL(url).host} answered ${response.status}: ${detail.slice(0, 300)}`);
    }
    const wait = Number(response.headers.get("retry-after"));
    await sleep(Number.isFinite(wait) && wait > 0 ? Math.min(wait, 30) * 1000 : 1000 * 2 ** attempt);
  }
}

async function accessToken() {
  const body = new URLSearchParams({
    client_id: env.GOOGLE_OAUTH_CLIENT_ID!,
    client_secret: env.GOOGLE_OAUTH_CLIENT_SECRET!,
    refresh_token: env.GOOGLE_OAUTH_REFRESH_TOKEN!,
    grant_type: "refresh_token",
  });
  const token = (await request(TOKEN_URL, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body })) as { access_token: string };
  return token.access_token;
}

async function readLocation(name: string, token: string): Promise<{ location: GoogleLocation; reviews: FetchedReview[] }> {
  const headers = { authorization: `Bearer ${token}` };
  const reviews: FetchedReview[] = [];
  let summary: { averageRating?: number; totalReviewCount?: number } = {};
  let pageToken: string | undefined;
  for (let page = 0; page < MAX_PAGES; page++) {
    const query = new URLSearchParams({ pageSize: "50", ...(pageToken && { pageToken }) });
    const body = (await request(`${REVIEWS_API}/${name}/reviews?${query}`, { headers })) as {
      reviews?: ApiReview[];
      averageRating?: number;
      totalReviewCount?: number;
      nextPageToken?: string;
    };
    if (page === 0) summary = body;
    for (const review of body.reviews ?? []) {
      const rating = STARS[review.starRating ?? ""];
      if (!rating) continue;
      const anonymous = review.reviewer?.isAnonymous ?? false;
      reviews.push({
        id: review.reviewId,
        author: anonymous ? null : (review.reviewer?.displayName ?? null),
        photoUrl: anonymous ? null : (review.reviewer?.profilePhotoUrl ?? null),
        rating,
        text: review.comment ?? "",
        createTime: review.createTime,
        location: name,
      });
    }
    pageToken = body.nextPageToken;
    if (!pageToken) break;
  }
  // The business name and its Google Maps link (Business Information API); the reviews do not depend on it.
  const info = (await request(`${INFO_API}/locations/${name.split("/").pop()}?readMask=title,metadata`, { headers }).catch((error: unknown) => {
    log.warn("google_reviews.location_info_failed", { location: name, error });
    return null;
  })) as { title?: string; metadata?: { mapsUri?: string } } | null;
  return {
    location: {
      name,
      title: info?.title ?? null,
      mapsUri: info?.metadata?.mapsUri ?? null,
      averageRating: summary.averageRating ?? null,
      totalReviewCount: summary.totalReviewCount ?? reviews.length,
    },
    reviews,
  };
}

/** Reads every profile from Google, then stores what it read; nothing is stored or deleted unless every profile was read. */
async function sync(): Promise<Snapshot> {
  const token = await accessToken();
  const results = [];
  // One profile after another: a handful of requests every few hours, far below Google's 300 a minute.
  for (const name of env.GOOGLE_BUSINESS_LOCATIONS) results.push(await readLocation(name, token));
  const syncedAt = new Date(Date.now());
  const reviews = results.flatMap((result) => result.reviews);
  if (reviews.length) {
    await GoogleReview.bulkWrite(
      reviews.map(({ id, createTime, ...review }) => ({
        updateOne: {
          filter: { reviewId: id },
          update: { $set: { ...review, createTime: new Date(createTime), syncedAt }, $setOnInsert: { _id: randomUUID(), packageId: null } },
          upsert: true,
        },
      })),
    );
  }
  // Reviews Google no longer has (removed by their author or by Google) and those of profiles no longer listed.
  await GoogleReview.deleteMany({ syncedAt: { $lt: syncedAt } });
  return { fetchedAt: syncedAt.getTime(), locations: results.map((result) => result.location) };
}

let snapshot: Snapshot | null = null;
let refreshing: Promise<void> | null = null;
let lastError: { at: number; message: string } | null = null;

function refresh() {
  refreshing ??= sync()
    .then((fresh) => {
      snapshot = fresh;
      lastError = null;
      log.info("google_reviews.refreshed", { locations: fresh.locations.length });
    })
    .catch((error: unknown) => {
      lastError = { at: Date.now(), message: error instanceof Error ? error.message : String(error) };
      log.error("google_reviews.refresh_failed", { error });
    })
    .finally(() => {
      refreshing = null;
    });
  return refreshing;
}

const stale = () => !snapshot || Date.now() - snapshot.fetchedAt > REFRESH_AFTER;
const retryAllowed = () => !lastError || Date.now() - lastError.at > RETRY_AFTER;

/** Reviews read from Google within the last 30 days: the only ones that may still be kept. */
const cutoff = () => new Date(Date.now() - MAX_AGE);
const kept = () => ({ syncedAt: { $gte: cutoff() } });

/** Deletes what Google's 30-day limit no longer allows keeping, then syncs first when a sync is due. */
async function current(): Promise<Snapshot | null> {
  await GoogleReview.deleteMany({ syncedAt: { $lt: cutoff() } });
  if (googleReviewsConfigured() && stale() && retryAllowed()) await refresh();
  if (snapshot && Date.now() - snapshot.fetchedAt > MAX_AGE) snapshot = null;
  return snapshot;
}

const locationTitle = (data: Snapshot | null, name: string) => data?.locations.find((location) => location.name === name)?.title ?? null;

/** For the website's reviews band: every review, newest first, with each profile's rating, total and Google Maps link. */
export async function publicGoogleReviews() {
  const data = await current();
  const rows = googleReviewsConfigured() ? await GoogleReview.find(kept()).sort({ createTime: -1 }).lean<GoogleReviewDoc[]>() : [];
  return {
    enabled: googleReviewsConfigured(),
    fetchedAt: data ? new Date(data.fetchedAt).toISOString() : null,
    locations: (data?.locations ?? []).map(({ name: _name, ...location }) => location),
    reviews: rows.map((row) => ({
      id: row.reviewId,
      author: row.author,
      photoUrl: row.photoUrl,
      rating: row.rating,
      text: row.text,
      createTime: row.createTime.toISOString(),
      location: locationTitle(data, row.location),
    })),
  };
}

/**
 * For a package page: the Google reviews the admin linked to it that have words, newest first, shaped like the
 * reviews entered in the admin (testimonialDto) and credited to Google.
 */
export async function googleReviewsForPackage(packageId: string) {
  if (!googleReviewsConfigured()) return [];
  const rows = await GoogleReview.find({ ...kept(), packageId, text: { $ne: "" } })
    .sort({ createTime: -1 })
    .lean<GoogleReviewDoc[]>();
  return rows.map((row) => ({
    id: row._id,
    customerName: row.author ?? "A Google user",
    profile: "",
    image: null,
    rating: row.rating,
    review: row.text,
    place: "",
    source: { name: "Google", url: null, date: row.createTime.toISOString().slice(0, 10) },
  }));
}

/** For the admin dashboard: what is shown and when it was fetched. Starts a refresh when one is due, without waiting. */
export async function googleReviewsStatus() {
  if (googleReviewsConfigured() && stale() && retryAllowed()) void refresh();
  return {
    configured: googleReviewsConfigured(),
    profiles: env.GOOGLE_BUSINESS_LOCATIONS.length,
    reviews: await GoogleReview.countDocuments(kept()),
    locations: snapshot?.locations.map(({ title, averageRating, totalReviewCount }) => ({ title, averageRating, totalReviewCount })) ?? [],
    fetchedAt: snapshot ? new Date(snapshot.fetchedAt).toISOString() : null,
    error: lastError?.message ?? null,
  };
}

/**
 * The admin's list of synced reviews. The words, stars and reviewer stay as Google gives them: the only change an
 * admin can make is the package a review is about (none keeps it general). Reviews arrive by sync only, and one
 * deleted here would come back with the next sync, so there is no create or delete.
 */
export const googleReviewAdminRoutes = crudRoutes({
  entity: "google_review",
  label: "Google review",
  model: GoogleReview,
  update: z.object({ packageId: optionalId }),
  search: ["author", "text"],
  sort: { createTime: -1 },
  filters: (query) => [
    query.package === "general" ? { packageId: null } : query.package === "linked" ? { packageId: { $ne: null } } : undefined,
    /^[1-5]$/.test(query.rating ?? "") ? { rating: Number(query.rating) } : undefined,
  ],
  toDto: async (rows) => {
    const title = await packageTitles(rows.map((row) => row.packageId));
    return rows.map((row) => ({
      id: row.id,
      customerName: row.author ?? "A Google user",
      photoUrl: row.photoUrl,
      rating: row.rating,
      review: row.text,
      excerpt: row.text.length > 90 ? `${row.text.slice(0, 89)}…` : row.text || "(stars only)",
      reviewedAt: row.createTime.toISOString().slice(0, 10),
      profile: locationTitle(snapshot, row.location),
      packageId: row.packageId,
      packageTitle: title(row.packageId),
    }));
  },
  refs: { packageId: Package },
  // The package pages show the linked reviews.
  tags: ["catalog"],
  roles: { delete: null },
});

/** Tests only: forget the last sync and the last error. */
export function resetGoogleReviews() {
  snapshot = null;
  lastError = null;
  refreshing = null;
}
