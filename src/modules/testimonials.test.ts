import assert from "node:assert/strict";
import { test } from "node:test";
import { AuditLog } from "../db/models.ts";
import { api, signIn } from "../test/helpers.ts";

const { token } = await signIn();
const review = (name: string, extra: Record<string, unknown> = {}) => ({
  customerName: name,
  profile: "Malaysia holiday",
  rating: 5,
  review: "Everything was well organised.",
  place: "Malaysia",
  sourceName: "Google",
  sourceUrl: "https://maps.google.com/?cid=1",
  reviewedAt: "2025-02-18",
  ...extra,
});

test("CRUD: create, read, update, delete (soft)", async () => {
  const created = await api("POST", "/api/admin/testimonials", { token, body: review("Athul KP") });
  assert.equal(created.status, 201);
  assert.equal(created.body.data.isPublished, false, "new reviews start unpublished");
  const id = created.body.data.id;
  assert.equal((await api("GET", `/api/admin/testimonials/${id}`, { token })).body.data.customerName, "Athul KP");
  const updated = await api("PATCH", `/api/admin/testimonials/${id}`, { token, body: { place: "Kuala Lumpur, Malaysia" } });
  assert.equal(updated.body.data.place, "Kuala Lumpur, Malaysia");
  assert.equal(updated.body.data.review, "Everything was well organised.");
  assert.equal((await api("DELETE", `/api/admin/testimonials/${id}`, { token })).status, 200);
  assert.equal((await api("GET", `/api/admin/testimonials/${id}`, { token })).status, 404);
});

test("rating must be 1 to 5", async () => {
  const bad = await api("POST", "/api/admin/testimonials", { token, body: review("X", { rating: 6 }) });
  assert.equal(bad.body.error.details[0].path, "rating");
});

test("publish and unpublish: only published reviews are public, and both are audited", async () => {
  const created = await api("POST", "/api/admin/testimonials", { token, body: review("Jencey Varughese") });
  const id = created.body.data.id;
  const isPublic = async () => (await api("GET", "/api/public/testimonials")).body.data.some((t: { id: string }) => t.id === id);
  assert.equal(await isPublic(), false);
  await api("PATCH", `/api/admin/testimonials/${id}`, { token, body: { isPublished: true } });
  assert.equal(await isPublic(), true);
  await api("PATCH", `/api/admin/testimonials/${id}`, { token, body: { isPublished: false } });
  assert.equal(await isPublic(), false);
  const actions = (await AuditLog.find({ entityId: id }).lean()).map((row) => row.action);
  assert.ok(actions.includes("TESTIMONIAL_PUBLISHED"));
  assert.ok(actions.includes("TESTIMONIAL_UNPUBLISHED"));
});

test("ordering and pagination of the public carousel", async () => {
  const names = ["Zara", "Yusuf", "Xavier"];
  const created = [];
  for (const name of names) created.push((await api("POST", "/api/admin/testimonials", { token, body: review(name, { isPublished: true }) })).body.data.id);
  await api("PUT", "/api/admin/testimonials/order", { token, body: { ids: [...created].reverse() } });
  const all = (await api("GET", "/api/public/testimonials")).body.data.map((t: { customerName: string }) => t.customerName);
  assert.deepEqual(all.slice(0, 3), ["Xavier", "Yusuf", "Zara"]);
  const page = await api("GET", "/api/public/testimonials?pageSize=2&page=2");
  assert.equal(page.body.meta.pageSize, 2);
  assert.equal(page.body.data.length, 1);
  const sample = page.body.data[0];
  assert.deepEqual(sample.source, { name: "Google", url: "https://maps.google.com/?cid=1", date: "2025-02-18" });
  assert.equal("isPublished" in sample, false);
});

test("admin filters: published, rating, place", async () => {
  await api("POST", "/api/admin/testimonials", { token, body: review("Four Star", { rating: 4, place: "Baku", isPublished: true }) });
  const fours = await api("GET", "/api/admin/testimonials?rating=4", { token });
  assert.ok(fours.body.data.every((t: { rating: number }) => t.rating === 4));
  const baku = await api("GET", "/api/admin/testimonials?q=baku", { token });
  assert.equal(baku.body.data[0].place, "Baku");
  const drafts = await api("GET", "/api/admin/testimonials?published=false", { token });
  assert.ok(drafts.body.data.every((t: { isPublished: boolean }) => !t.isPublished));
});
