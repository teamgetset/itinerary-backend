import assert from "node:assert/strict";
import { test } from "node:test";
import { api, catalogue, readyPackage, signIn } from "../test/helpers.ts";

const { token } = await signIn("ADMIN");
const ids = await catalogue(token);
const pkg = await readyPackage(token, ids, { title: "Enquiry Trip" });
await api("POST", `/api/admin/packages/${pkg.id}/publish`, { token });

const base = { name: "Rahul Nair", phone: "+91 98765 43210", adults: 2, children: 1, infants: 1 };

test("create: stores travellers, the package's branch and the estimate in the chosen currency", async () => {
  const created = await api("POST", "/api/public/enquiries", {
    body: { ...base, packageSlug: pkg.slug, currency: "AED", travelDate: "2099-12-20", message: "Window seats please" },
  });
  assert.equal(created.status, 201);
  const id = created.body.data.id;
  const detail = await api("GET", `/api/admin/enquiries/${id}`, { token });
  assert.equal(detail.body.data.status, "NEW");
  assert.equal(detail.body.data.package.slug, pkg.slug);
  assert.equal(detail.body.data.branch.id, ids.branchId);
  assert.deepEqual([detail.body.data.adults, detail.body.data.children, detail.body.data.infants], [2, 1, 1]);
  assert.equal(detail.body.data.currencyCode, "AED");
  assert.equal(detail.body.data.estimatedTotal, 2 * 2450 + 1800 + 400);
});

test("validation: a way to reply is required, dates must be in the future", async () => {
  const noContact = await api("POST", "/api/public/enquiries", { body: { name: "No Contact", adults: 1, children: 0, infants: 0 } });
  assert.equal(noContact.body.error.details[0].message, "Add an email, phone or WhatsApp number so we can reply.");
  const past = await api("POST", "/api/public/enquiries", { body: { ...base, travelDate: "2020-01-01" } });
  assert.equal(past.body.error.details[0].path, "travelDate");
  const badEmail = await api("POST", "/api/public/enquiries", { body: { ...base, email: "not-an-email" } });
  assert.equal(badEmail.body.error.details[0].path, "email");
  assert.equal((await api("POST", "/api/public/enquiries", { body: { ...base, packageSlug: "no-such-trip" } })).status, 404);
});

test("admin: search, filter, change status, add internal notes", async () => {
  const list = await api("GET", "/api/admin/enquiries?q=rahul&status=NEW", { token });
  assert.equal(list.body.data.length, 1);
  const id = list.body.data[0].id;
  assert.equal(list.body.data[0].package.title, "Enquiry Trip");
  assert.equal((await api("GET", "/api/admin/enquiries?q=enquiry trip", { token })).body.data.length, 1);

  const updated = await api("PATCH", `/api/admin/enquiries/${id}`, { token, body: { status: "CONTACTED" } });
  assert.equal(updated.body.data.status, "CONTACTED");
  assert.equal((await api("PATCH", `/api/admin/enquiries/${id}`, { token, body: { status: "LOST" } })).status, 400);
  const note = await api("POST", `/api/admin/enquiries/${id}/notes`, { token, body: { body: "Called, sending a quote." } });
  assert.equal(note.status, 201);
  const detail = await api("GET", `/api/admin/enquiries/${id}`, { token });
  assert.equal(detail.body.data.notes[0].body, "Called, sending a quote.");
  assert.ok(detail.body.data.notes[0].author);
  assert.equal((await api("GET", "/api/admin/enquiries?status=CONTACTED", { token })).body.data.length, 1);

  const dashboard = await api("GET", "/api/admin/dashboard", { token });
  assert.equal(dashboard.body.data.counts.newEnquiries, 0);
});

test("bots filling the hidden field get a quiet success and nothing is stored", async () => {
  const before = (await api("GET", "/api/admin/enquiries", { token })).body.meta.total;
  const bot = await api("POST", "/api/public/enquiries", { body: { ...base, website: "http://spam.example" } });
  assert.equal(bot.status, 201);
  assert.equal((await api("GET", "/api/admin/enquiries", { token })).body.meta.total, before);
});

test("public enquiries are rate limited per address", async () => {
  let last = 0;
  for (let i = 0; i < 6; i++) last = (await api("POST", "/api/public/enquiries", { body: base })).status;
  assert.equal(last, 429);
});
