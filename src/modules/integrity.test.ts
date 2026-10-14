import assert from "node:assert/strict";
import { test } from "node:test";
import { danglingReferences } from "../db/indexes.ts";
import { AuditLog, Package } from "../db/models.ts";
import { api, catalogue, readyPackage, signIn } from "../test/helpers.ts";

/*
 * Rules PostgreSQL used to enforce by itself (foreign keys, unique constraints, transactions), now enforced by the
 * services on MongoDB, plus response-shape guarantees of the move.
 */

const { token } = await signIn("SUPER_ADMIN");
const ids = await catalogue(token);
const missingId = "00000000-0000-4000-8000-000000000000";

const hasMongoInternals = (value: unknown): boolean =>
  Array.isArray(value)
    ? value.some(hasMongoInternals)
    : !!value && typeof value === "object" && Object.entries(value).some(([key, v]) => key === "_id" || key === "__v" || hasMongoInternals(v));

test("links to records that do not exist are refused (INVALID_REFERENCE)", async () => {
  const branch = await api("POST", "/api/admin/branches", {
    token,
    body: { name: "Doha", city: "Doha", countryCode: "QA", countryName: "Qatar", phone: "+974 0000 0000", bannerImageId: missingId },
  });
  assert.equal(branch.status, 400);
  assert.equal(branch.body.error.code, "INVALID_REFERENCE");
  assert.equal(branch.body.error.details[0].path, "bannerImageId");

  const slide = await api("POST", "/api/admin/hero-slides", { token, body: { title: "Somewhere", imageId: missingId } });
  assert.equal(slide.body.error.code, "INVALID_REFERENCE");
  const review = await api("POST", "/api/admin/testimonials", { token, body: { customerName: "A", rating: 5, review: "Lovely", packageId: missingId } });
  assert.equal(review.body.error.code, "INVALID_REFERENCE");
  const activity = await api("POST", "/api/admin/activities", { token, body: { name: "Kayaking", prices: [{ currencyCode: "XXX", amount: 10 }] } });
  assert.equal(activity.body.error.code, "INVALID_REFERENCE");
});

test("records still in use cannot be deleted (IN_USE); links to deleted ones are cleared", async () => {
  const category = (await api("POST", "/api/admin/categories", { token, body: { name: "Short breaks" } })).body.data;
  const pkg = await readyPackage(token, ids, { categoryId: category.id });
  const hotel = (await api("POST", "/api/admin/hotels", { token, body: { name: "Rooms Kazbegi", location: "Stepantsminda" } })).body.data;
  const dayHotel = (await api("POST", "/api/admin/hotels", { token, body: { name: "Stamba", location: "Tbilisi" } })).body.data;
  const offered = (await api("POST", "/api/admin/activities", { token, body: { name: "Jvari pass drive" } })).body.data;
  const mentioned = (await api("POST", "/api/admin/activities", { token, body: { name: "Wine tasting" } })).body.data;
  await api("PUT", `/api/admin/packages/${pkg.id}/hotels`, { token, body: { hotels: [{ hotelId: hotel.id, nights: 2 }] } });
  await api("PUT", `/api/admin/packages/${pkg.id}/activities`, { token, body: { activityIds: [offered.id] } });
  await api("PUT", `/api/admin/packages/${pkg.id}/itinerary`, {
    token,
    body: { days: [{ title: "Tbilisi", hotelId: dayHotel.id, activities: [{ title: "Tasting", activityId: mentioned.id }] }] },
  });

  for (const path of [`/api/admin/hotels/${hotel.id}`, `/api/admin/activities/${offered.id}`, `/api/admin/destinations/${ids.destinationId}`]) {
    const removed = await api("DELETE", path, { token });
    assert.equal(removed.status, 409, path);
    assert.equal(removed.body.error.code, "IN_USE");
  }

  // Hotels and activities only mentioned in the itinerary can go; the itinerary keeps its text and loses the link.
  assert.equal((await api("DELETE", `/api/admin/hotels/${dayHotel.id}`, { token })).status, 200);
  assert.equal((await api("DELETE", `/api/admin/activities/${mentioned.id}`, { token })).status, 200);
  assert.equal((await api("DELETE", `/api/admin/categories/${category.id}`, { token })).status, 200);
  const editor = (await api("GET", `/api/admin/packages/${pkg.id}`, { token })).body.data;
  assert.equal(editor.itinerary[0].hotelId, null);
  assert.equal(editor.itinerary[0].activities[0].activityId, null);
  assert.equal(editor.itinerary[0].activities[0].title, "Tasting");
  assert.equal(editor.categoryId, null);

  // A destination without packages can be deleted; its add-on activities stay, unlinked.
  const empty = (await api("POST", "/api/admin/destinations", { token, body: { name: "Batumi", countryCode: "GE", countryName: "Georgia" } })).body.data;
  const addOn = (await api("POST", "/api/admin/activities", { token, body: { name: "Botanical garden", destinationId: empty.id } })).body.data;
  assert.equal((await api("DELETE", `/api/admin/destinations/${empty.id}`, { token })).status, 200);
  assert.equal((await api("GET", `/api/admin/activities/${addOn.id}`, { token })).body.data.destinationId, null);
  // After all of that, every reference in the database still points at an existing document.
  assert.deepEqual(await danglingReferences(), []);
});

test("duplicates name the field; responses carry ids, never MongoDB internals, and keep null fields", async () => {
  const currency = await api("POST", "/api/admin/currencies", { token, body: { code: "INR", symbol: "₹", name: "Rupee" } });
  assert.equal(currency.status, 409);
  assert.deepEqual(currency.body.error.details, [{ path: "code", message: "This currency already exists" }]);

  const branch = (await api("GET", `/api/admin/branches/${ids.otherBranchId}`, { token })).body.data;
  assert.match(branch.id, /^[0-9a-f-]{36}$/);
  for (const field of ["whatsapp", "email", "latitude", "mapUrl", "seoTitle", "ogImageId"]) {
    assert.ok(field in branch && branch[field] === null, `${field} should be present as null`);
  }

  const pkg = await readyPackage(token, ids);
  const responses = await Promise.all([
    api("GET", `/api/admin/packages/${pkg.id}`, { token }),
    api("GET", "/api/admin/packages", { token }),
    api("GET", "/api/admin/branches", { token }),
    api("GET", "/api/admin/media", { token }),
    api("GET", "/api/admin/currencies", { token }),
    api("GET", "/api/admin/dashboard", { token }),
    api("GET", "/api/admin/audit-logs", { token }),
    api("GET", "/api/public/settings"),
    api("GET", "/api/public/branches"),
    api("GET", "/api/public/destinations"),
  ]);
  for (const response of responses) {
    assert.equal(response.status, 200);
    assert.equal(hasMongoInternals(response.body), false);
  }
  const editor = responses[0]!.body.data;
  assert.ok("bestTime" in editor && "deletedAt" in editor && editor.deletedAt === null);
});

test("search text with regular-expression characters is matched literally", async () => {
  for (const q of ["a+b(", "[", ".*", "\\"]) {
    assert.equal((await api("GET", `/api/public/search?q=${encodeURIComponent(q)}`)).status, 200, q);
    assert.equal((await api("GET", `/api/admin/packages?q=${encodeURIComponent(q)}`, { token })).status, 200, q);
  }
  await api("POST", "/api/public/enquiries", { body: { name: "Asha", email: "asha@example.com", adults: 1, children: 0, infants: 0 } });
  assert.equal((await api("GET", "/api/admin/enquiries?q=.*", { token })).body.meta.total, 0);
  assert.equal((await api("GET", "/api/admin/enquiries?q=ash", { token })).body.meta.total, 1);
});

test("price sorting puts packages without a price in the chosen currency last", async () => {
  const priced = await readyPackage(token, ids, { title: "Priced in dirhams" });
  const unpriced = await readyPackage(token, ids, { title: "Rupees only" });
  // Published straight in the database: this test is about sorting, not the publish flow.
  await Package.updateMany({ _id: { $in: [priced.id, unpriced.id] } }, { $set: { status: "PUBLISHED", publishedAt: new Date() } });
  await Package.updateOne({ _id: unpriced.id }, { $pull: { prices: { currencyCode: "AED", priceType: "ADULT" } } });

  for (const sort of ["price-asc", "price-desc"]) {
    const slugs = (await api("GET", `/api/public/packages?currency=AED&sort=${sort}&pageSize=48`)).body.data.map((p: { slug: string }) => p.slug);
    assert.equal(slugs.at(-1), unpriced.slug, sort);
    assert.ok(slugs.indexOf(priced.slug) < slugs.indexOf(unpriced.slug), sort);
  }
  const inRange = (await api("GET", "/api/public/packages?currency=AED&minPrice=1")).body.data.map((p: { slug: string }) => p.slug);
  assert.ok(inRange.includes(priced.slug) && !inRange.includes(unpriced.slug));
});

test("a refused edit is rolled back completely, audit entry included (transactions)", async () => {
  const pkg = await readyPackage(token, ids, { title: "Live and complete" });
  await Package.updateOne({ _id: pkg.id }, { $set: { status: "PUBLISHED", publishedAt: new Date() } });
  const audited = () => AuditLog.countDocuments({ entityId: pkg.id, action: "PACKAGE_UPDATED" });
  const before = await audited();

  const refused = await api("PUT", `/api/admin/packages/${pkg.id}/itinerary`, { token, body: { days: [] } });
  assert.equal(refused.status, 422);
  assert.equal(refused.body.error.code, "PUBLISHED_INCOMPLETE");
  assert.equal((await api("GET", `/api/admin/packages/${pkg.id}`, { token })).body.data.itinerary.length, 3);
  assert.equal(await audited(), before);
});
