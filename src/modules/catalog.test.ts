import assert from "node:assert/strict";
import { test } from "node:test";
import { api, catalogue, readyPackage, signIn, uploadPhoto } from "../test/helpers.ts";

const { token } = await signIn();
const ids = await catalogue(token);

test("branches: create, read, update, list and public retrieval", async () => {
  const created = await api("POST", "/api/admin/branches", {
    token,
    body: { name: "Abu Dhabi Office", city: "Abu Dhabi", countryCode: "ae", countryName: "UAE", phone: "+971 2 000 0000", description: "Office." },
  });
  assert.equal(created.status, 201);
  assert.equal(created.body.data.slug, "abu-dhabi-office");
  assert.equal(created.body.data.countryCode, "AE");

  const read = await api("GET", `/api/admin/branches/${created.body.data.id}`, { token });
  assert.equal(read.body.data.name, "Abu Dhabi Office");

  // PATCH changes only what is sent: the slug and description stay.
  const updated = await api("PATCH", `/api/admin/branches/${created.body.data.id}`, { token, body: { name: "Abu Dhabi" } });
  assert.equal(updated.body.data.name, "Abu Dhabi");
  assert.equal(updated.body.data.slug, "abu-dhabi-office");
  assert.equal(updated.body.data.description, "Office.");

  const list = await api("GET", "/api/admin/branches?q=abu", { token });
  assert.equal(list.body.meta.total, 1);

  const publicList = await api("GET", "/api/public/branches");
  assert.ok(publicList.body.data.some((b: { slug: string }) => b.slug === "abu-dhabi-office"));
  const publicOne = await api("GET", "/api/public/branches/dubai");
  assert.equal(publicOne.body.data.airport.code, "DXB");
  assert.match(publicOne.body.data.bannerImage.url, /^http:\/\/api\.test\/media\/images\//);
  assert.equal("id" in publicOne.body.data, false);
});

test("switched-off branches disappear from the public API", async () => {
  const branch = await api("POST", "/api/admin/branches", { token, body: { name: "Kochi", city: "Kochi", countryCode: "IN", countryName: "India", phone: "+91 0000 000" } });
  await api("PATCH", `/api/admin/branches/${branch.body.data.id}`, { token, body: { isActive: false } });
  assert.equal((await api("GET", "/api/public/branches/kochi")).status, 404);
  assert.equal((await api("GET", "/api/public/branches")).body.data.some((b: { slug: string }) => b.slug === "kochi"), false);
});

test("slugs: generated, made unique, and a taken slug is a field error", async () => {
  const again = await api("POST", "/api/admin/destinations", { token, body: { name: "Georgia", countryCode: "GE", countryName: "Georgia" } });
  assert.equal(again.body.data.slug, "georgia-2");
  const taken = await api("POST", "/api/admin/destinations", { token, body: { name: "Tbilisi", slug: "georgia", countryCode: "GE", countryName: "Georgia" } });
  assert.equal(taken.status, 409);
  assert.deepEqual(taken.body.error.details, [{ path: "slug", message: "This slug is already in use" }]);
  const bad = await api("POST", "/api/admin/destinations", { token, body: { name: "X", slug: "Not A Slug", countryCode: "GE", countryName: "Georgia" } });
  assert.equal(bad.body.error.details[0].path, "slug");
});

test("validation errors name the field and the problem", async () => {
  const result = await api("POST", "/api/admin/branches", { token, body: { name: "", city: "X", countryCode: "UAE", countryName: "X", phone: "1", whatsapp: "+971 58" } });
  assert.equal(result.status, 400);
  assert.equal(result.body.error.code, "VALIDATION_ERROR");
  const paths = result.body.error.details.map((d: { path: string }) => d.path).sort();
  assert.deepEqual(paths, ["countryCode", "name", "phone", "whatsapp"]);
  const json = await app_raw("POST", "/api/admin/branches", "{not json", token);
  assert.equal(json.body.error.code, "INVALID_JSON");
});

test("a branch with packages cannot be deleted, only switched off", async () => {
  await readyPackage(token, ids);
  const removed = await api("DELETE", `/api/admin/branches/${ids.branchId}`, { token });
  assert.equal(removed.status, 409);
  assert.equal(removed.body.error.code, "IN_USE");
  const unused = await api("POST", "/api/admin/categories", { token, body: { name: "Temporary" } });
  assert.equal((await api("DELETE", `/api/admin/categories/${unused.body.data.id}`, { token })).status, 200);
});

test("editors cannot change branches or currencies", async () => {
  const editor = await signIn("EDITOR");
  assert.equal((await api("PATCH", `/api/admin/branches/${ids.branchId}`, { token: editor.token, body: { name: "X" } })).status, 403);
  assert.equal((await api("POST", "/api/admin/currencies", { token: editor.token, body: { code: "USD", symbol: "$", name: "US dollar" } })).status, 403);
  // ...but can edit destinations.
  assert.equal((await api("PATCH", `/api/admin/destinations/${ids.destinationId}`, { token: editor.token, body: { region: "Caucasus" } })).status, 200);
});

test("destinations carry facts and their add-on activities with prices", async () => {
  const facts = [{ label: "Currency", value: "Georgian lari (GEL)" }];
  await api("PATCH", `/api/admin/destinations/${ids.destinationId}`, { token, body: { facts } });
  const activity = await api("POST", "/api/admin/activities", {
    token,
    body: { name: "Gudauri paragliding", destinationId: ids.destinationId, prices: [{ currencyCode: "AED", amount: 450 }, { currencyCode: "INR", amount: 10400 }] },
  });
  assert.equal(activity.status, 201);
  assert.deepEqual(activity.body.data.prices, { AED: 450, INR: 10400 });
  const page = await api("GET", "/api/public/destinations/georgia");
  assert.deepEqual(page.body.data.facts, facts);
  assert.equal(page.body.data.experiences[0].name, "Gudauri paragliding");
  assert.deepEqual(page.body.data.experiences[0].prices, { AED: 450, INR: 10400 });
});

test("hotels: create with a photo, star category validated", async () => {
  const photoId = await uploadPhoto(token, "hotel.jpg");
  const hotel = await api("POST", "/api/admin/hotels", { token, body: { name: "Rooms Kazbegi", location: "Stepantsminda", starCategory: 4, rating: 4.6, primaryImageId: photoId } });
  assert.equal(hotel.status, 201);
  assert.equal(hotel.body.data.primaryImage.id, photoId);
  const bad = await api("POST", "/api/admin/hotels", { token, body: { name: "X", location: "Y", starCategory: 7 } });
  assert.equal(bad.body.error.details[0].path, "starCategory");
});

test("site content: validated per block, defaults when unset, unsafe links refused", async () => {
  const settings = await api("GET", "/api/public/settings");
  assert.equal(settings.body.data.defaultCurrency, "INR");
  assert.deepEqual(settings.body.data.currencies.map((c: { code: string }) => c.code), ["INR", "AED"]);
  assert.equal(settings.body.data.content["home.hero"].heading, "Get set for somewhere new.");

  const hero = { ...settings.body.data.content["home.hero"], heading: "Holidays, sorted." };
  assert.equal((await api("PUT", "/api/admin/content/home.hero", { token, body: hero })).status, 200);
  assert.equal((await api("GET", "/api/public/settings")).body.data.content["home.hero"].heading, "Holidays, sorted.");

  const unsafe = await api("PUT", "/api/admin/content/navigation", {
    token,
    body: { header: [{ label: "Home", href: "javascript:alert(1)" }], footer: [] },
  });
  assert.equal(unsafe.status, 400);
  assert.equal(unsafe.body.error.details[0].path, "header.0.href");
  assert.equal((await api("PUT", "/api/admin/content/not-a-block", { token, body: {} })).status, 404);
});

test("currencies: the default cannot be switched off; changes reach the public settings", async () => {
  const off = await api("PATCH", "/api/admin/currencies/INR", { token, body: { isActive: false } });
  assert.equal(off.body.error.code, "DEFAULT_CURRENCY");
  await api("POST", "/api/admin/currencies", { token, body: { code: "usd", symbol: "$", name: "US dollar", locale: "en-US", displayOrder: 2 } });
  const codes = (await api("GET", "/api/public/settings")).body.data.currencies.map((c: { code: string }) => c.code);
  assert.deepEqual(codes, ["INR", "AED", "USD"]);
  await api("PATCH", "/api/admin/currencies/USD", { token, body: { isActive: false } });
  assert.equal((await api("GET", "/api/public/settings")).body.data.currencies.length, 2);
});

test("hero slides: only published ones, in display order", async () => {
  const photoId = await uploadPhoto(token, "slide.jpg");
  const first = await api("POST", "/api/admin/hero-slides", { token, body: { title: "Second", imageId: photoId, isPublished: true, buttonLink: "/packages/x" } });
  const second = await api("POST", "/api/admin/hero-slides", { token, body: { title: "First", imageId: photoId, isPublished: true } });
  await api("POST", "/api/admin/hero-slides", { token, body: { title: "Draft", imageId: photoId } });
  await api("PUT", "/api/admin/hero-slides/order", { token, body: { ids: [second.body.data.id, first.body.data.id] } });
  const slides = (await api("GET", "/api/public/hero-slides")).body.data;
  assert.deepEqual(slides.map((s: { title: string }) => s.title), ["First", "Second"]);
  const unsafe = await api("POST", "/api/admin/hero-slides", { token, body: { title: "X", imageId: photoId, buttonLink: "javascript:alert(1)" } });
  assert.equal(unsafe.body.error.details[0].path, "buttonLink");
});

/** Sends a raw body (to test malformed JSON). */
async function app_raw(method: string, path: string, body: string, bearer: string) {
  const { app } = await import("../test/helpers.ts");
  const response = await app.request(path, { method, body, headers: { "content-type": "application/json", authorization: `Bearer ${bearer}` } });
  return { status: response.status, body: (await response.json()) as any };
}
