import assert from "node:assert/strict";
import { mock, test } from "node:test";

/*
 * Google reviews against a stand-in for Google's APIs (fetch is replaced; nothing leaves the machine). The GOOGLE_*
 * settings are made up and set before the app loads its configuration.
 */
process.env.GOOGLE_OAUTH_CLIENT_ID = "test-client";
process.env.GOOGLE_OAUTH_CLIENT_SECRET = "test-secret";
process.env.GOOGLE_OAUTH_REFRESH_TOKEN = "test-refresh-token";
process.env.GOOGLE_BUSINESS_LOCATIONS = "accounts/111/locations/222, accounts/111/locations/333";
const { api, catalogue, readyPackage, signIn } = await import("../test/helpers.ts");
const { resetGoogleReviews } = await import("./google-reviews.ts");
const { GoogleReview } = await import("../db/models.ts");
const { token } = await signIn("ADMIN");

const day = (n: number) => `2026-${String(1 + Math.floor(n / 28)).padStart(2, "0")}-${String(1 + (n % 28)).padStart(2, "0")}T10:00:00Z`;
const review = (id: string, n: number, extra: Record<string, unknown> = {}) => ({
  reviewId: id,
  reviewer: { displayName: `Guest ${id}`, profilePhotoUrl: `https://lh3.googleusercontent.com/a/${id}` },
  starRating: "FIVE",
  comment: `Review ${id}`,
  createTime: day(n),
  ...extra,
});
// Dubai: 62 reviews over two pages (one anonymous, one with stars only, one without a rating); Calicut: 3.
const dubaiPage1 = Array.from({ length: 50 }, (_, i) => review(`d${i}`, i));
const dubaiPage2 = [
  ...Array.from({ length: 9 }, (_, i) => review(`d${50 + i}`, 50 + i)),
  review("anon", 60, { reviewer: { isAnonymous: true } }),
  review("stars-only", 61, { comment: undefined, starRating: "FOUR" }),
  review("unrated", 62, { starRating: "STAR_RATING_UNSPECIFIED" }),
];
const calicut = [review("c1", 3, { starRating: "THREE" }), review("c2", 70), review("c3", 71)];

let google = { failToken: false, rateLimitOnce: true };
const calls: string[] = [];
const fakeGoogle = async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  calls.push(`${url.host}${url.pathname}${url.search}`);
  const reply = (status: number, body: unknown, headers: Record<string, string> = {}) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
  if (url.host === "oauth2.googleapis.com") {
    const form = new URLSearchParams(String(init?.body));
    assert.equal(form.get("grant_type"), "refresh_token");
    assert.equal(form.get("refresh_token"), "test-refresh-token");
    return google.failToken ? reply(400, { error: "invalid_grant" }) : reply(200, { access_token: "test-access" });
  }
  assert.equal(new Headers(init?.headers).get("authorization"), "Bearer test-access");
  if (url.pathname === "/v4/accounts/111/locations/222/reviews") {
    assert.equal(url.searchParams.get("pageSize"), "50");
    return url.searchParams.get("pageToken") === "page-2"
      ? reply(200, { reviews: dubaiPage2, averageRating: 4.8, totalReviewCount: 62 })
      : reply(200, { reviews: dubaiPage1, averageRating: 4.8, totalReviewCount: 62, nextPageToken: "page-2" });
  }
  if (url.pathname === "/v4/accounts/111/locations/333/reviews") {
    if (google.rateLimitOnce) {
      google.rateLimitOnce = false;
      return reply(429, { error: { status: "RESOURCE_EXHAUSTED" } }, { "retry-after": "1" });
    }
    return reply(200, { reviews: calicut, averageRating: 4.3, totalReviewCount: 3 });
  }
  if (url.pathname === "/v1/locations/222") return reply(200, { title: "GETSET Tours & Travels", metadata: { mapsUri: "https://maps.google.com/?cid=7918922786561356044" } });
  if (url.pathname === "/v1/locations/333") return reply(404, { error: { status: "NOT_FOUND" } });
  throw new Error(`unexpected request ${url}`);
};
mock.method(globalThis, "fetch", fakeGoogle);
const now = Date.now();
let offset = 0;
mock.method(Date, "now", () => now + offset);
const HOUR = 60 * 60 * 1000;

test("every review of every profile is read page by page, newest first, with each profile's rating and link", async () => {
  const result = await api("GET", "/api/public/google-reviews");
  assert.equal(result.status, 200);
  const { enabled, locations, reviews } = result.body.data;
  assert.equal(enabled, true);
  assert.equal(reviews.length, 50 + 11 + 3, "all pages, without the review that has no rating");
  assert.ok(calls.some((c) => c.includes("pageToken=page-2")), "the second page was requested");
  assert.equal(calls.filter((c) => c.endsWith("/locations/333/reviews?pageSize=50")).length, 2, "the rate-limited request was retried");
  assert.deepEqual(reviews.map((r: { createTime: string }) => r.createTime), [...reviews.map((r: { createTime: string }) => r.createTime)].sort().reverse());
  assert.deepEqual(locations, [
    { title: "GETSET Tours & Travels", mapsUri: "https://maps.google.com/?cid=7918922786561356044", averageRating: 4.8, totalReviewCount: 62 },
    { title: null, mapsUri: null, averageRating: 4.3, totalReviewCount: 3 },
  ]);
  const byId = (id: string) => reviews.find((r: { id: string }) => r.id === id);
  assert.deepEqual(byId("d0"), {
    id: "d0",
    author: "Guest d0",
    photoUrl: "https://lh3.googleusercontent.com/a/d0",
    rating: 5,
    text: "Review d0",
    createTime: new Date(day(0)).toISOString(),
    location: "GETSET Tours & Travels",
  });
  assert.deepEqual([byId("anon").author, byId("anon").photoUrl], [null, null], "anonymous reviewers stay anonymous");
  assert.deepEqual([byId("stars-only").rating, byId("stars-only").text], [4, ""]);
  assert.equal(byId("c1").rating, 3, "low ratings are shown too");
  assert.equal(byId("unrated"), undefined);
  assert.ok(!JSON.stringify(result.body).includes("test-access") && !JSON.stringify(result.body).includes("accounts/111"), "no token or account ids in the answer");
});

test("the copy is reused for 6 hours, then refreshed; while Google fails the last copy is served, but never past 30 days", async () => {
  const before = calls.length;
  await api("GET", "/api/public/google-reviews");
  assert.equal(calls.length, before, "served without asking Google");

  offset = 7 * HOUR;
  await api("GET", "/api/public/google-reviews");
  assert.ok(calls.length > before, "refreshed after 6 hours");

  google = { failToken: true, rateLimitOnce: false };
  offset = 14 * HOUR;
  const failed = await api("GET", "/api/public/google-reviews");
  assert.equal(failed.status, 200, "Google failing is not the website's error");
  assert.equal(failed.body.data.reviews.length, 64, "the last good copy is still shown");
  const dashboard = await api("GET", "/api/admin/dashboard", { token });
  assert.equal(dashboard.body.data.googleReviews.configured, true);
  assert.equal(dashboard.body.data.googleReviews.reviews, 64);
  assert.match(dashboard.body.data.googleReviews.error, /oauth2\.googleapis\.com answered 400/);

  const afterFailure = calls.length;
  offset = 14 * HOUR + 5 * 60 * 1000;
  await api("GET", "/api/public/google-reviews");
  assert.equal(calls.length, afterFailure, "no new attempt within 15 minutes of a failure");

  offset = 31 * 24 * HOUR;
  const expired = await api("GET", "/api/public/google-reviews");
  assert.deepEqual(expired.body.data.reviews, [], "content older than 30 days is no longer shown");
  assert.equal(await GoogleReview.countDocuments(), 0, "nor kept");

  google = { failToken: false, rateLimitOnce: false };
  offset = 31 * 24 * HOUR + HOUR;
  assert.equal((await api("GET", "/api/public/google-reviews")).body.data.reviews.length, 64, "back once Google answers again");
  const healthy = await api("GET", "/api/admin/dashboard", { token });
  assert.deepEqual(
    { ...healthy.body.data.googleReviews, fetchedAt: typeof healthy.body.data.googleReviews.fetchedAt },
    {
      configured: true,
      profiles: 2,
      reviews: 64,
      locations: [
        { title: "GETSET Tours & Travels", averageRating: 4.8, totalReviewCount: 62 },
        { title: null, averageRating: 4.3, totalReviewCount: 3 },
      ],
      fetchedAt: "string",
      error: null,
    },
  );
  resetGoogleReviews();
});

test("each review is stored once, however often it is synced, and changes and removals on Google follow", async () => {
  assert.equal(await GoogleReview.countDocuments(), 64);
  calicut[1]!.comment = "Edited on Google";
  const removed = calicut.pop()!;
  offset += 7 * HOUR;
  const { reviews } = (await api("GET", "/api/public/google-reviews")).body.data;
  assert.equal(await GoogleReview.countDocuments(), 63, "no duplicates; the review removed on Google is gone");
  assert.equal((await GoogleReview.distinct("reviewId")).length, 63);
  assert.equal(reviews.find((r: { id: string }) => r.id === "c2").text, "Edited on Google");
  assert.equal(reviews.find((r: { id: string }) => r.id === removed.reviewId), undefined);
  calicut.push(removed);
});

test("an admin links a Google review to a package; the package page shows only its own reviews, the rest stay general", async () => {
  const editor = (await signIn("EDITOR")).token;
  const ids = await catalogue(token);
  const trip = await readyPackage(token, ids, { title: "Reviewed Trip" });
  const other = await readyPackage(token, ids, { title: "Other Trip" });
  for (const pkg of [trip, other]) assert.equal((await api("POST", `/api/admin/packages/${pkg.id}/publish`, { token })).status, 200);

  const list = await api("GET", "/api/admin/google-reviews?pageSize=100", { token: editor });
  assert.equal(list.status, 200);
  assert.equal(list.body.meta.total, 63, "c3 is back only with the next sync");
  assert.deepEqual(new Set(list.body.data.map((r: { packageTitle: string | null }) => r.packageTitle)), new Set([null]), "every review starts general");
  const reviewOf = (reviewId: string) => GoogleReview.findOne({ reviewId }).lean();
  const c2 = (await reviewOf("c2"))!;
  const starsOnly = (await reviewOf("stars-only"))!;

  const linked = await api("PATCH", `/api/admin/google-reviews/${c2._id}`, { token: editor, body: { packageId: trip.id, text: "Changed", rating: 1 } });
  assert.equal(linked.status, 200);
  assert.equal(linked.body.data.packageTitle, "Reviewed Trip");
  assert.deepEqual([linked.body.data.review, linked.body.data.rating], ["Edited on Google", 5], "the words and stars stay as Google gives them");
  assert.equal((await api("PATCH", `/api/admin/google-reviews/${starsOnly._id}`, { token: editor, body: { packageId: trip.id } })).status, 200);
  const unknown = await api("PATCH", `/api/admin/google-reviews/${c2._id}`, { token: editor, body: { packageId: "00000000-0000-4000-8000-000000000000" } });
  assert.equal(unknown.status, 400);
  assert.equal((await api("POST", "/api/admin/google-reviews", { token, body: { reviewId: "x" } })).status, 404, "reviews only arrive by sync");
  assert.equal((await api("DELETE", `/api/admin/google-reviews/${c2._id}`, { token })).status, 404, "nor are they deleted in the admin");

  const filtered = async (value: string) => (await api("GET", `/api/admin/google-reviews?package=${value}`, { token })).body.meta.total;
  assert.deepEqual([await filtered("linked"), await filtered("general")], [2, 61]);

  const page = (await api("GET", `/api/public/packages/${trip.slug}`)).body.data;
  assert.deepEqual(page.reviews, [
    {
      id: c2._id,
      customerName: "Guest c2",
      profile: "",
      image: null,
      rating: 5,
      review: "Edited on Google",
      place: "",
      source: { name: "Google", url: null, date: new Date(day(70)).toISOString().slice(0, 10) },
    },
  ], "its linked review with words, not the stars-only one or the general ones");
  assert.deepEqual((await api("GET", `/api/public/packages/${other.slug}`)).body.data.reviews, [], "another package shows none of them");

  offset += 7 * HOUR;
  await api("GET", "/api/public/google-reviews");
  assert.equal((await reviewOf("c2"))!.packageId, trip.id, "the link survives a sync");
  assert.equal((await api("GET", "/api/public/google-reviews")).body.data.reviews.length, 64, "linked reviews stay in the site-wide band too, and c3 is back");

  assert.equal((await api("PATCH", `/api/admin/google-reviews/${c2._id}`, { token: editor, body: { packageId: null } })).status, 200);
  assert.deepEqual((await api("GET", `/api/public/packages/${trip.slug}`)).body.data.reviews, [], "unlinked: general again");
  resetGoogleReviews();
});
