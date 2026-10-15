import assert from "node:assert/strict";
import { test } from "node:test";
import { AuditLog } from "../../db/models.ts";
import { signToken } from "../../lib/crypto.ts";
import { FULL_PRICES, api, catalogue, readyPackage, signIn } from "../../test/helpers.ts";

const admin = await signIn("ADMIN");
const token = admin.token;
const ids = await catalogue(token);

test("create: a new package is a draft and is not public", async () => {
  const created = await api("POST", "/api/admin/packages", {
    token,
    body: { branchId: ids.branchId, destinationId: ids.destinationId, title: "Draft Trip", durationDays: 4, durationNights: 3 },
  });
  assert.equal(created.status, 201);
  assert.equal(created.body.data.status, "DRAFT");
  assert.equal(created.body.data.slug, "draft-trip");
  assert.equal((await api("GET", "/api/public/packages/draft-trip")).status, 404);
  assert.equal((await api("GET", "/api/public/packages")).body.data.some((p: { slug: string }) => p.slug === "draft-trip"), false);
});

test("create and update: field-level validation", async () => {
  const bad = await api("POST", "/api/admin/packages", {
    token,
    body: { branchId: ids.branchId, destinationId: ids.destinationId, title: "", durationDays: 0, durationNights: 1 },
  });
  const messages = Object.fromEntries(bad.body.error.details.map((d: { path: string; message: string }) => [d.path, d.message]));
  assert.equal(messages.title, "Package title is required.");
  assert.equal(messages.durationDays, "Duration must be greater than 0.");

  const unknownBranch = await api("POST", "/api/admin/packages", {
    token,
    body: { branchId: crypto.randomUUID(), destinationId: ids.destinationId, title: "X", durationDays: 2, durationNights: 1 },
  });
  assert.deepEqual(unknownBranch.body.error.details, [{ path: "branchId", message: "Choose a branch." }]);

  const pkg = await readyPackage(token, ids, { title: "Update Me" });
  const nights = await api("PATCH", `/api/admin/packages/${pkg.id}`, { token, body: { durationNights: 9 } });
  assert.deepEqual(nights.body.error.details, [{ path: "durationNights", message: "Nights cannot be more than days." }]);
  const ok = await api("PATCH", `/api/admin/packages/${pkg.id}`, { token, body: { shortDescription: "New pitch", isFeatured: true } });
  assert.equal(ok.body.data.shortDescription, "New pitch");
  assert.equal(ok.body.data.title, "Update Me");
});

test("itinerary: create days, update, reorder, add and remove timeline activities", async () => {
  const pkg = await readyPackage(token, ids, { title: "Itinerary Trip" });
  const days = [
    { title: "Day A", description: "First", activities: [{ time: "09:00", title: "Pickup", type: "TRANSFER" }] },
    { title: "Day B", meals: ["BREAKFAST"], activities: [] },
  ];
  let saved = await api("PUT", `/api/admin/packages/${pkg.id}/itinerary`, { token, body: { days } });
  assert.deepEqual(saved.body.data.itinerary.map((d: { dayNumber: number; title: string }) => [d.dayNumber, d.title]), [[1, "Day A"], [2, "Day B"]]);

  // Reorder, edit a title, add an activity to one day and remove the other's.
  const reordered = [
    { ...days[1], title: "Day B (edited)", activities: [{ time: "18:30", title: "Dinner", type: "MEAL" }, { title: "Free evening" }] },
    { ...days[0], activities: [] },
  ];
  saved = await api("PUT", `/api/admin/packages/${pkg.id}/itinerary`, { token, body: { days: reordered } });
  const [first, second] = saved.body.data.itinerary;
  assert.equal(first.title, "Day B (edited)");
  assert.equal(first.dayNumber, 1);
  assert.deepEqual(first.activities.map((a: { time: string | null; title: string }) => [a.time, a.title]), [["18:30", "Dinner"], [null, "Free evening"]]);
  assert.deepEqual(first.meals, ["BREAKFAST"]);
  assert.equal(second.activities.length, 0);

  const badTime = await api("PUT", `/api/admin/packages/${pkg.id}/itinerary`, {
    token,
    body: { days: [{ title: "X", activities: [{ time: "25:00", title: "Late" }] }] },
  });
  assert.equal(badTime.body.error.details[0].path, "days.0.activities.0.time");
  const noTitle = await api("PUT", `/api/admin/packages/${pkg.id}/itinerary`, { token, body: { days: [{ title: " " }] } });
  assert.equal(noTitle.body.error.details[0].message, "Day title is required.");
});

test("itinerary hotels: the hotel chosen for a day is saved, shown to the admin and on the public page; deleting it unlinks", async () => {
  const pkg = await readyPackage(token, ids, { title: "Hotel Trip" });
  const hotel = await api("POST", "/api/admin/hotels", { token, body: { name: "lyf Funan Singapore", location: "Funan, Singapore", starCategory: 4 } });
  assert.equal(hotel.status, 201, JSON.stringify(hotel.body));
  const hotelId = hotel.body.data.id;
  const days = [
    { title: "Arrive", stay: "Singapore", hotelId },
    { title: "City tour", stay: "Singapore", hotelId },
    { title: "Depart" },
  ];
  const saved = await api("PUT", `/api/admin/packages/${pkg.id}/itinerary`, { token, body: { days } });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  assert.deepEqual(saved.body.data.itinerary.map((d: { hotelId: string | null }) => d.hotelId), [hotelId, hotelId, null], "the editor gets the choice back");

  await api("POST", `/api/admin/packages/${pkg.id}/publish`, { token });
  const page = (await api("GET", `/api/public/packages/${pkg.slug}`)).body.data;
  assert.deepEqual(page.itinerary[0].hotel, { name: "lyf Funan Singapore", starCategory: 4, location: "Funan, Singapore" });
  assert.deepEqual(page.itinerary[1].hotel, page.itinerary[0].hotel);
  assert.equal(page.itinerary[2].hotel, null);

  // Changing the choice on a live package shows the new hotel; an unknown hotel is refused and changes nothing.
  const other = (await api("POST", "/api/admin/hotels", { token, body: { name: "Marina Bay Sands", location: "Marina Bay, Singapore", starCategory: 5 } })).body.data;
  await api("PUT", `/api/admin/packages/${pkg.id}/itinerary`, { token, body: { days: [days[0], { ...days[1], hotelId: other.id }, days[2]] } });
  assert.equal((await api("GET", `/api/public/packages/${pkg.slug}`)).body.data.itinerary[1].hotel.name, "Marina Bay Sands");
  const unknown = await api("PUT", `/api/admin/packages/${pkg.id}/itinerary`, { token, body: { days: [{ title: "X", hotelId: crypto.randomUUID() }] } });
  assert.equal(unknown.body.error.details[0].message, "A selected hotel no longer exists.");
  assert.equal((await api("GET", `/api/public/packages/${pkg.slug}`)).body.data.itinerary.length, 3);

  // A hotel used only by itinerary days can be deleted: those days lose the link, the rest of the day stays.
  assert.equal((await api("DELETE", `/api/admin/hotels/${other.id}`, { token })).status, 200);
  const after = (await api("GET", `/api/public/packages/${pkg.slug}`)).body.data.itinerary;
  assert.equal(after[1].hotel, null);
  assert.equal(after[1].stay, "Singapore");
  assert.equal(after[0].hotel.name, "lyf Funan Singapore");
});

test("activities tab: the experiences chosen are saved in order and published with their details", async () => {
  const pkg = await readyPackage(token, ids, { title: "Experiences Trip" });
  const make = async (body: Record<string, unknown>) => (await api("POST", "/api/admin/activities", { token, body })).body.data;
  const cruise = await make({ name: "Dhow Cruise", description: "Dinner on a traditional dhow along the marina.", location: "Dubai Marina", imageId: ids.photoId });
  const garden = await make({ name: "Miracle Garden", location: "Al Barsha South" });
  const put = (activityIds: string[]) => api("PUT", `/api/admin/packages/${pkg.id}/activities`, { token, body: { activityIds } });
  const shown = async () =>
    (await api("GET", `/api/public/packages/${pkg.slug}`)).body.data.activities.map((a: { name: string; description: string; location: string | null; image: unknown }) => [
      a.name,
      a.description || null,
      a.location,
      !!a.image,
    ]);

  const saved = await put([garden.id, cruise.id]);
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  assert.deepEqual(saved.body.data.activities.map((a: { activityId: string }) => a.activityId), [garden.id, cruise.id], "the editor gets them back, in order");
  await api("POST", `/api/admin/packages/${pkg.id}/publish`, { token });
  assert.deepEqual(await shown(), [
    ["Miracle Garden", null, "Al Barsha South", false],
    ["Dhow Cruise", "Dinner on a traditional dhow along the marina.", "Dubai Marina", true],
  ]);

  // Changing the choice on a live package; a switched-off activity is not shown; an unknown one is refused.
  await put([cruise.id]);
  assert.deepEqual((await shown()).map((row: unknown[]) => row[0]), ["Dhow Cruise"]);
  await api("PATCH", `/api/admin/activities/${cruise.id}`, { token, body: { isActive: false } });
  assert.deepEqual(await shown(), []);
  await api("PATCH", `/api/admin/activities/${cruise.id}`, { token, body: { isActive: true } });
  assert.equal((await put([crypto.randomUUID()])).body.error.details[0].message, "A selected activity no longer exists.");
  assert.deepEqual((await shown()).map((row: unknown[]) => row[0]), ["Dhow Cruise"], "unchanged after the refused save");
  await put([]);
  assert.deepEqual(await shown(), []);
});

test("itinerary timeline: each step's type and its linked catalogue activity reach the public page", async () => {
  const pkg = await readyPackage(token, ids, { title: "Timeline Trip" });
  const safari = (
    await api("POST", "/api/admin/activities", {
      token,
      body: { name: "Desert Safari", description: "Dune drive, camel ride and a barbecue dinner at a desert camp.", location: "Lahbab desert", imageId: ids.photoId },
    })
  ).body.data;
  const steps = [
    { time: "15:00", title: "Hotel pickup", type: "TRANSFER" },
    { time: "16:30", title: "Dune drive", type: "ACTIVITY", activityId: safari.id },
    { title: "Sunset at the camp", description: "Our own words.", location: "Camp Al Khayma", type: "ACTIVITY", activityId: safari.id },
    { title: "Something else" },
  ];
  const saved = await api("PUT", `/api/admin/packages/${pkg.id}/itinerary`, { token, body: { days: [{ title: "Desert day", activities: steps }] } });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  assert.deepEqual(
    saved.body.data.itinerary[0].activities.map((a: { type: string; activityId: string | null }) => [a.type, a.activityId]),
    [["TRANSFER", null], ["ACTIVITY", safari.id], ["ACTIVITY", safari.id], ["OTHER", null]],
    "the editor gets the type and the link back",
  );

  await api("POST", `/api/admin/packages/${pkg.id}/publish`, { token });
  const timeline = async () => (await api("GET", `/api/public/packages/${pkg.slug}`)).body.data.itinerary[0].activities;
  let shown = await timeline();
  assert.deepEqual(shown.map((a: { type: string }) => a.type), ["TRANSFER", "ACTIVITY", "ACTIVITY", "OTHER"]);
  assert.equal(shown[0].activity, null, "an unlinked step has no catalogue activity");
  assert.deepEqual(
    { ...shown[1].activity, image: shown[1].activity.image?.url ? "image" : null },
    { slug: safari.slug, name: "Desert Safari", description: "Dune drive, camel ride and a barbecue dinner at a desert camp.", location: "Lahbab desert", image: "image" },
  );
  assert.deepEqual([shown[2].title, shown[2].description, shown[2].location], ["Sunset at the camp", "Our own words.", "Camp Al Khayma"], "the step keeps its own text");
  assert.equal(shown[3].activity, null);

  // Switched off in the catalogue: no longer shown; the step stays as written.
  await api("PATCH", `/api/admin/activities/${safari.id}`, { token, body: { isActive: false } });
  shown = await timeline();
  assert.equal(shown[1].activity, null);
  assert.equal(shown[1].title, "Dune drive");
  // Deleted from the catalogue: the link is cleared, the step stays.
  assert.equal((await api("DELETE", `/api/admin/activities/${safari.id}`, { token })).status, 200);
  shown = await timeline();
  assert.deepEqual(shown.map((a: { title: string; activity: unknown }) => [a.title, a.activity]), steps.map((step) => [step.title, null]));
});

test("hotel options: every field is optional; empty rows are dropped; a row without a hotel is kept but not published", async () => {
  const pkg = await readyPackage(token, ids, { title: "Optional Hotels Trip" });
  const hotel = (await api("POST", "/api/admin/hotels", { token, body: { name: "Rove Downtown", location: "Downtown Dubai", starCategory: 3 } })).body.data;
  const put = (hotels: unknown[]) => api("PUT", `/api/admin/packages/${pkg.id}/hotels`, { token, body: { hotels } });
  type Row = { hotelId: string | null; nights: number | null; roomType: string | null; mealPlan: string | null; isDefault: boolean };

  const saved = await put([
    { hotelId: hotel.id },
    { hotelId: null, nights: null, roomType: "Deluxe room", mealPlan: null, isDefault: true },
    { hotelId: null, nights: null, roomType: null, mealPlan: null },
    { hotelId: hotel.id, nights: 2, roomType: "Suite", mealPlan: "Half board", isDefault: false },
  ]);
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  assert.deepEqual(
    saved.body.data.hotels.map(({ hotelId, nights, roomType, mealPlan, isDefault }: Row) => ({ hotelId, nights, roomType, mealPlan, isDefault })),
    [
      { hotelId: hotel.id, nights: null, roomType: null, mealPlan: null, isDefault: true },
      { hotelId: null, nights: null, roomType: "Deluxe room", mealPlan: null, isDefault: true },
      { hotelId: hotel.id, nights: 2, roomType: "Suite", mealPlan: "Half board", isDefault: false },
    ],
    "the empty row is dropped; the others are kept as entered, for the admin to finish",
  );
  assert.equal(saved.body.data.hotels[1].hotel, null);

  await api("POST", `/api/admin/packages/${pkg.id}/publish`, { token });
  const page = (await api("GET", `/api/public/packages/${pkg.slug}`)).body.data;
  assert.deepEqual(
    page.hotels.map((h: { name: string; nights: number | null; roomType: string | null; mealPlan: string | null; isDefault: boolean }) => [h.name, h.nights, h.roomType, h.mealPlan, h.isDefault]),
    [["Rove Downtown", null, null, null, true], ["Rove Downtown", 2, "Suite", "Half board", false]],
    "only rows with a hotel are published",
  );

  // A hotel switched off in the catalogue is not published; switched back on, it is.
  await api("PATCH", `/api/admin/hotels/${hotel.id}`, { token, body: { isActive: false } });
  assert.deepEqual((await api("GET", `/api/public/packages/${pkg.slug}`)).body.data.hotels, []);
  await api("PATCH", `/api/admin/hotels/${hotel.id}`, { token, body: { isActive: true } });
  assert.equal((await api("GET", `/api/public/packages/${pkg.slug}`)).body.data.hotels.length, 2);

  // Values are still checked when given.
  assert.equal((await put([{ hotelId: hotel.id, nights: 0 }])).body.error.details[0].message, "At least one night.");
  assert.equal((await put([{ hotelId: crypto.randomUUID() }])).body.error.details[0].message, "A selected hotel no longer exists.");
  assert.equal((await api("GET", `/api/public/packages/${pkg.slug}`)).body.data.hotels.length, 2, "unchanged after refused saves");
  assert.deepEqual((await put([])).body.data.hotels, []);
  assert.deepEqual((await api("GET", `/api/public/packages/${pkg.slug}`)).body.data.hotels, []);
});

test("pricing: adult, child and infant in INR and AED; negatives and unknown currencies refused", async () => {
  const pkg = await readyPackage(token, ids, { title: "Pricing Trip" });
  const editor = (await api("GET", `/api/admin/packages/${pkg.id}`, { token })).body.data;
  assert.equal(editor.prices.length, 6);

  const negative = await api("PUT", `/api/admin/packages/${pkg.id}/prices`, {
    token,
    body: { prices: [{ currencyCode: "INR", priceType: "ADULT", amount: -1 }] },
  });
  assert.equal(negative.body.error.details[0].message, "Adult INR price cannot be negative.");
  const unknown = await api("PUT", `/api/admin/packages/${pkg.id}/prices`, {
    token,
    body: { prices: [{ currencyCode: "XYZ", priceType: "ADULT", amount: 10 }] },
  });
  assert.equal(unknown.body.error.details[0].message, "XYZ is not a supported currency.");
  const twice = await api("PUT", `/api/admin/packages/${pkg.id}/prices`, {
    token,
    body: { prices: [FULL_PRICES[0], FULL_PRICES[0]] },
  });
  assert.equal(twice.status, 400);
});

test("publishing is blocked until the package is complete, with a checklist", async () => {
  const bare = await api("POST", "/api/admin/packages", {
    token,
    body: { branchId: ids.branchId, destinationId: ids.destinationId, title: "Incomplete", durationDays: 2, durationNights: 1 },
  });
  const check = await api("GET", `/api/admin/packages/${bare.body.data.id}/publish-check`, { token });
  assert.equal(check.body.data.ready, false);
  const failing = check.body.data.checklist.filter((i: { ok: boolean }) => !i.ok).map((i: { key: string }) => i.key);
  assert.deepEqual(failing, ["heroImage", "description", "pricing", "itinerary", "itineraryPdf"]);

  const publish = await api("POST", `/api/admin/packages/${bare.body.data.id}/publish`, { token });
  assert.equal(publish.status, 422);
  assert.equal(publish.body.error.code, "PUBLISH_BLOCKED");
  const pricing = publish.body.error.details.find((d: { path: string }) => d.path === "pricing");
  assert.match(pricing.message, /Adult INR, Child INR, Infant INR, Adult AED, Child AED, Infant AED/);
  const itinerary = publish.body.error.details.find((d: { path: string }) => d.path === "itinerary");
  assert.equal(itinerary.message, "At least one itinerary day is required before publishing.");
});

test("publish, unpublish, archive: public visibility follows status; the uploaded PDF is offered; actions audited", async () => {
  const pkg = await readyPackage(token, ids, { title: "Lifecycle Trip" });
  const published = await api("POST", `/api/admin/packages/${pkg.id}/publish`, { token });
  assert.equal(published.status, 200, JSON.stringify(published.body));
  assert.equal(published.body.data.status, "PUBLISHED");

  const detail = await api("GET", `/api/public/packages/${pkg.slug}`);
  assert.equal(detail.status, 200);
  assert.deepEqual(detail.body.data.prices.ADULT, { INR: 54999, AED: 2450 });
  assert.deepEqual(detail.body.data.overview, ["First paragraph.", "Second paragraph."]);
  assert.equal(detail.body.data.itinerary[0].activities[0].time, "10:30");
  assert.equal(detail.body.data.branch.slug, "dubai");
  assert.match(detail.body.data.pdf.url, /\/api\/public\/packages\/lifecycle-trip\/pdf$/);
  assert.ok(detail.body.data.pdf.sizeBytes > 0);

  await api("POST", `/api/admin/packages/${pkg.id}/unpublish`, { token });
  assert.equal((await api("GET", `/api/public/packages/${pkg.slug}`)).status, 404);
  await api("POST", `/api/admin/packages/${pkg.id}/archive`, { token });
  assert.equal((await api("GET", `/api/admin/packages/${pkg.id}`, { token })).body.data.status, "ARCHIVED");

  const actions = (await AuditLog.find({ entityId: pkg.id }).lean()).map((row) => row.action);
  for (const action of ["PACKAGE_CREATED", "PACKAGE_UPDATED", "ITINERARY_PDF_UPLOADED", "PACKAGE_PUBLISHED", "PACKAGE_UNPUBLISHED", "PACKAGE_ARCHIVED"]) {
    assert.ok(actions.includes(action), `missing ${action}`);
  }
});

test("a live package cannot be edited into an incomplete state", async () => {
  const pkg = await readyPackage(token, ids, { title: "Live Guard" });
  await api("POST", `/api/admin/packages/${pkg.id}/publish`, { token });
  const noHero = await api("PATCH", `/api/admin/packages/${pkg.id}`, { token, body: { heroImageId: null } });
  assert.equal(noHero.status, 422);
  assert.equal(noHero.body.error.code, "PUBLISHED_INCOMPLETE");
  const noDays = await api("PUT", `/api/admin/packages/${pkg.id}/itinerary`, { token, body: { days: [] } });
  assert.equal(noDays.body.error.details[0].path, "itinerary");
  // Nothing was changed by the refused edits.
  const detail = await api("GET", `/api/public/packages/${pkg.slug}`);
  assert.ok(detail.body.data.heroImage);
  assert.equal(detail.body.data.itinerary.length, 3);
  // Ordinary edits still work.
  assert.equal((await api("PATCH", `/api/admin/packages/${pkg.id}`, { token, body: { bestTime: "All year" } })).status, 200);
});

test("delete: refused while published; soft delete frees the slug", async () => {
  const pkg = await readyPackage(token, ids, { title: "Delete Me" });
  await api("POST", `/api/admin/packages/${pkg.id}/publish`, { token });
  assert.equal((await api("DELETE", `/api/admin/packages/${pkg.id}`, { token })).body.error.code, "PACKAGE_PUBLISHED");
  await api("POST", `/api/admin/packages/${pkg.id}/unpublish`, { token });
  assert.equal((await api("DELETE", `/api/admin/packages/${pkg.id}`, { token })).status, 200);
  assert.equal((await api("GET", `/api/admin/packages/${pkg.id}`, { token })).status, 404);
  const again = await readyPackage(token, ids, { title: "Delete Me" });
  assert.equal(again.slug, "delete-me");
});

test("duplicate: a new draft with the same itinerary, prices and lists", async () => {
  const pkg = await readyPackage(token, ids, { title: "Original" });
  await api("PUT", `/api/admin/packages/${pkg.id}/highlights`, { token, body: { items: [{ title: "Old Tbilisi" }] } });
  const copy = await api("POST", `/api/admin/packages/${pkg.id}/duplicate`, { token });
  assert.equal(copy.status, 201);
  assert.equal(copy.body.data.title, "Original (copy)");
  assert.equal(copy.body.data.slug, "original-copy");
  assert.equal(copy.body.data.status, "DRAFT");
  assert.equal(copy.body.data.itinerary.length, 3);
  assert.equal(copy.body.data.itinerary[0].activities[0].title, "Airport arrival");
  assert.equal(copy.body.data.prices.length, 6);
  assert.equal(copy.body.data.highlights[0].title, "Old Tbilisi");
});

test("listing: filters by branch, destination, duration, price range in a currency; paginates; never mixes catalogues", async () => {
  const georgia = await readyPackage(token, ids, { title: "Filter Georgia", durationDays: 3 });
  const maldives = await readyPackage(token, ids, {
    title: "Filter Maldives",
    branchId: ids.otherBranchId,
    destinationId: ids.otherDestinationId,
    durationDays: 3,
    keywords: ["honeymoon"],
  });
  await api("PUT", `/api/admin/packages/${maldives.id}/prices`, {
    token,
    body: { prices: FULL_PRICES.map((p) => ({ ...p, amount: p.amount * 2 })) },
  });
  for (const pkg of [georgia, maldives]) await api("POST", `/api/admin/packages/${pkg.id}/publish`, { token });

  const slugs = async (query: string) =>
    (await api("GET", `/api/public/packages?${query}`)).body.data.map((p: { slug: string }) => p.slug).sort();

  assert.ok((await slugs("branch=dubai")).includes("filter-georgia"));
  assert.equal((await slugs("branch=dubai")).includes("filter-maldives"), false);
  assert.deepEqual(await slugs("branch=calicut"), ["filter-maldives"]);
  assert.deepEqual(await slugs("destination=male"), ["filter-maldives"]);
  assert.deepEqual(await slugs("currency=AED&minPrice=3000"), ["filter-maldives"]);
  assert.ok((await slugs("currency=INR&maxPrice=60000")).includes("filter-georgia"));
  assert.deepEqual(await slugs("slugs=filter-maldives,filter-georgia"), ["filter-georgia", "filter-maldives"]);
  assert.deepEqual(await slugs("minDays=30"), []);

  const branchRoute = await api("GET", "/api/public/branches/calicut/packages");
  assert.deepEqual(branchRoute.body.data.map((p: { slug: string }) => p.slug), ["filter-maldives"]);

  const page = await api("GET", "/api/public/packages?pageSize=1&page=2&sort=price-desc&currency=AED");
  assert.equal(page.body.meta.pageSize, 1);
  assert.equal(page.body.meta.page, 2);
  assert.equal(page.body.data.length, 1);
  assert.ok(page.body.meta.total >= 2);

  // Search ignores case and accents: "male" finds the Malé destination.
  assert.deepEqual(await slugs("q=MALE"), ["filter-maldives"]);
  assert.deepEqual(await slugs("q=honeymoon"), ["filter-maldives"]);
  // The selling branch is not a search word: "dubai" (a branch here) must not find the Dubai branch's Georgia trip.
  assert.equal((await slugs("q=dubai")).includes("filter-georgia"), false);
  assert.equal((await slugs("q=calicut")).includes("filter-maldives"), false);
  assert.ok((await slugs("q=mountains")).includes("filter-georgia"), "the category is still searchable");
  const search = await api("GET", "/api/public/search?q=georgia");
  assert.ok(search.body.data.packages.some((p: { slug: string }) => p.slug === "filter-georgia"));
  assert.ok(search.body.data.destinations.some((d: { slug: string }) => d.slug === "georgia"));

  // Recommendations: never the same package or destination; same branch first.
  const recs = await api("GET", `/api/public/packages/${georgia.slug}/recommendations`);
  assert.equal(recs.status, 200);
  for (const rec of recs.body.data) {
    assert.notEqual(rec.slug, georgia.slug);
    assert.notEqual(rec.destination.slug, "georgia");
  }
  assert.ok(recs.body.data.some((p: { slug: string }) => p.slug === "filter-maldives"));
});

test("preview links show drafts to whoever holds the link, until they expire", async () => {
  const pkg = await readyPackage(token, ids, { title: "Preview Draft" });
  const link = await api("POST", `/api/admin/packages/${pkg.id}/preview`, { token });
  const url = new URL(link.body.data.url);
  assert.equal(url.origin, "http://site.test");
  const tokenParam = url.searchParams.get("token")!;
  const preview = await api("GET", `/api/public/preview/packages/${pkg.id}?token=${encodeURIComponent(tokenParam)}`);
  assert.equal(preview.status, 200);
  assert.equal(preview.body.data.status, "DRAFT");
  assert.equal(preview.headers.get("x-robots-tag"), "noindex, nofollow");

  const otherId = crypto.randomUUID();
  assert.equal((await api("GET", `/api/public/preview/packages/${otherId}?token=${encodeURIComponent(tokenParam)}`)).status, 403);
  const tampered = tokenParam.slice(0, -2) + (tokenParam.endsWith("AA") ? "BB" : "AA");
  assert.equal((await api("GET", `/api/public/preview/packages/${pkg.id}?token=${encodeURIComponent(tampered)}`)).status, 403);
  const expired = signToken(`package:${pkg.id}`, process.env.AUTH_SECRET!, -10);
  assert.equal((await api("GET", `/api/public/preview/packages/${pkg.id}?token=${encodeURIComponent(expired)}`)).status, 403);
});

test("good to know and important information: the shared content until the package saves its own lists, then exactly those", async () => {
  const pkg = await readyPackage(token, ids, { title: "Info Trip" });
  const other = await readyPackage(token, ids, { title: "Info Trip Untouched" });
  for (const p of [pkg, other]) await api("POST", `/api/admin/packages/${p.id}/publish`, { token });
  const editor = await signIn("EDITOR");
  const put = (section: string, items: unknown[], as = editor.token) => api("PUT", `/api/admin/packages/${pkg.id}/${section}`, { token: as, body: { items } });
  const shown = async (slug = pkg.slug) => (await api("GET", `/api/public/packages/${slug}`)).body.data;
  const editorView = async () => (await api("GET", `/api/admin/packages/${pkg.id}`, { token })).body.data;
  const facts = [
    { label: "Currency", value: "Georgian lari (GEL)" },
    { label: "Visa", value: "Visa-free for many passports." },
  ];
  await api("PATCH", `/api/admin/destinations/${ids.destinationId}`, { token, body: { facts } });
  const shared = (await api("GET", "/api/admin/content", { token })).body.data["package.defaults"];
  const asItems = facts.map(({ label, value }) => ({ title: label, description: value }));

  // Before the package has its own lists: the page and the editor both show the shared content, once each.
  let page = await shown();
  assert.deepEqual(page.goodToKnow, asItems);
  assert.deepEqual(page.importantInfo, shared.importantInfo);
  assert.deepEqual(page.destination.facts, [], "the facts are not sent a second time");
  let view = await editorView();
  assert.equal(view.ownInfo, false);
  assert.deepEqual([view.goodToKnow, view.importantInfo], [asItems, shared.importantInfo], "the admin starts from exactly what the page shows");

  // Saving one list gives the package its own copy of both, exactly as saved.
  const goodToKnow = [...asItems, { title: "Dress code", description: "Cover shoulders and knees in churches." }, { title: "Tipping is welcome but not expected", description: null }];
  const saved = await put("good-to-know", goodToKnow);
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  assert.equal(saved.body.data.ownInfo, true);
  page = await shown();
  assert.deepEqual(page.goodToKnow, goodToKnow);
  assert.deepEqual(page.importantInfo, shared.importantInfo, "the other list is kept as it was shown");
  const notes = [shared.importantInfo[0], "Carry a printed copy of your hotel voucher."];
  assert.equal((await put("important-info", notes)).status, 200);
  assert.deepEqual((await shown()).importantInfo, notes, "a shared note removed, a note added: exactly what was saved");
  for (const section of ["goodToKnow", "importantInfo"]) {
    assert.ok(await AuditLog.exists({ action: "PACKAGE_UPDATED", entityId: pkg.id, "metadata.section": section }), section);
  }

  // Changing the shared content now only affects packages without their own lists.
  await api("PATCH", `/api/admin/destinations/${ids.destinationId}`, { token, body: { facts: [facts[0]] } });
  await api("PUT", "/api/admin/content/package.defaults", { token, body: { ...shared, importantInfo: ["Only this shared note."] } });
  page = await shown();
  assert.deepEqual([page.goodToKnow, page.importantInfo], [goodToKnow, notes], "this package keeps its own lists");
  const untouched = await shown(other.slug);
  assert.deepEqual([untouched.goodToKnow, untouched.importantInfo], [[asItems[0]], ["Only this shared note."]], "a package without its own lists follows the shared content");
  await api("PUT", "/api/admin/content/package.defaults", { token, body: shared });

  // Checked like every other section; nothing is saved when a list is invalid.
  const blank = await put("good-to-know", [{ title: "  ", description: null }]);
  assert.equal(blank.body.error.details[0].path, "items.0.title");
  assert.equal(blank.body.error.details[0].message, "Text is required.");
  assert.equal((await put("important-info", Array.from({ length: 41 }, (_, i) => `Note ${i + 1}`))).status, 400, "at most 40 notes");
  assert.equal((await put("important-info", ["x".repeat(301)])).status, 400, "at most 300 characters each");
  assert.equal((await put("important-info", notes, "")).status, 401);
  assert.deepEqual((await shown()).goodToKnow, goodToKnow, "unchanged after the refused saves");

  // A copy keeps the package's own lists; emptied lists leave nothing to show (no shared content comes back).
  const copy = (await api("POST", `/api/admin/packages/${pkg.id}/duplicate`, { token })).body.data;
  assert.deepEqual([copy.ownInfo, copy.goodToKnow, copy.importantInfo], [true, goodToKnow, notes]);
  await put("good-to-know", []);
  await put("important-info", []);
  page = await shown();
  assert.deepEqual([page.goodToKnow, page.importantInfo], [[], []]);
});

test("editors can edit packages but not publish them", async () => {
  const editor = await signIn("EDITOR");
  const pkg = await readyPackage(editor.token, ids, { title: "Editor Trip" });
  assert.equal((await api("PATCH", `/api/admin/packages/${pkg.id}`, { token: editor.token, body: { bestTime: "Summer" } })).status, 200);
  assert.equal((await api("POST", `/api/admin/packages/${pkg.id}/publish`, { token: editor.token })).status, 403);
  assert.equal((await api("DELETE", `/api/admin/packages/${pkg.id}`, { token: editor.token })).status, 403);
});

test("admin list: search by title, destination or branch, filter by status", async () => {
  const list = await api("GET", "/api/admin/packages?q=georgia&status=PUBLISHED", { token });
  assert.ok(list.body.data.length > 0);
  assert.ok(list.body.data.every((p: { status: string }) => p.status === "PUBLISHED"));
  assert.ok(list.body.data[0].startingPrice.INR > 0);
  const byBranch = await api("GET", `/api/admin/packages?branchId=${ids.otherBranchId}`, { token });
  assert.ok(byBranch.body.data.every((p: { branch: { id: string } }) => p.branch.id === ids.otherBranchId));
});
