import assert from "node:assert/strict";
import { test } from "node:test";
import { api, catalogue, readyPackage, signIn } from "../../test/helpers.ts";
import { loadPackageGraph, packageDetail } from "../packages/read.ts";
import { itineraryHtml } from "./template.ts";

const { token } = await signIn("ADMIN");
const ids = await catalogue(token);
const pkg = await readyPackage(token, ids, { title: "PDF Trip" });
await api("PUT", `/api/admin/packages/${pkg.id}/inclusions`, { token, body: { items: [{ title: "Private airport transfers" }] } });
await api("POST", `/api/admin/packages/${pkg.id}/publish`, { token });

const download = async (branding: string) => {
  const response = await (await import("../../test/helpers.ts")).app.request(`/api/public/packages/${pkg.slug}/pdf?branding=${branding}`);
  return { response, bytes: Buffer.from(await response.arrayBuffer()) };
};

test("both prints come from one template; only the logo differs", async () => {
  const graph = await loadPackageGraph({ _id: pkg.id });
  const detail = await packageDetail(graph!);
  const meta = { version: 1, updatedAt: new Date("2026-10-06"), currencies: [{ code: "INR", symbol: "₹", locale: "en-IN" }], siteUrl: "http://site.test" };
  const images = { logo: "data:image/png;base64,LOGO", hero: null, gallery: [] };
  const withLogo = itineraryHtml(detail, "with-logo", images, meta);
  const withoutLogo = itineraryHtml(detail, "without-logo", images, meta);
  assert.ok(withLogo.includes('src="data:image/png;base64,LOGO"'));
  assert.equal(withoutLogo.includes("base64,LOGO"), false);
  // Remove the logo element from each: the rest is identical.
  const strip = (html: string) => html.replace(/<img src="data:image\/png;base64,LOGO"[^>]*>|<span class="logo-space"><\/span>/, "");
  assert.equal(strip(withLogo), strip(withoutLogo));
  // Currency symbols are bidi-isolated (<bdi>) so right-to-left ones (د.إ) sit correctly.
  for (const text of ["PDF Trip", "DAY", "10:30 AM", "Airport arrival", "<bdi>₹</bdi>54,999", "Private airport transfers", "Version 1"]) {
    assert.ok(withLogo.includes(text), `missing ${text}`);
  }
});

test("public download: with-logo and without-logo PDFs, as attachments", async () => {
  const withLogo = await download("with-logo");
  const withoutLogo = await download("without-logo");
  assert.equal(withLogo.response.status, 200);
  assert.equal(withLogo.response.headers.get("content-type"), "application/pdf");
  assert.match(withLogo.response.headers.get("content-disposition")!, /attachment; filename="getset-pdf-trip-itinerary\.pdf"/);
  assert.match(withoutLogo.response.headers.get("content-disposition")!, /getset-pdf-trip-itinerary-no-logo\.pdf/);
  assert.equal(withLogo.bytes.subarray(0, 5).toString(), "%PDF-");
  assert.equal(withoutLogo.bytes.subarray(0, 5).toString(), "%PDF-");
  // The logo image is the only extra content.
  assert.ok(withLogo.bytes.length > withoutLogo.bytes.length);
  assert.equal(withLogo.response.headers.get("x-pdf-version"), "1");
  assert.equal((await download("sideways")).response.status, 400);
});

test("versioning: same content reuses the PDF; a change makes a new version and the old one is never served", async () => {
  const again = await api("POST", `/api/admin/packages/${pkg.id}/pdf`, { token });
  assert.equal(again.body.data.version, 1);

  await api("PATCH", `/api/admin/packages/${pkg.id}`, { token, body: { shortDescription: "A changed pitch." } });
  const stale = await api("GET", `/api/admin/packages/${pkg.id}/pdf`, { token });
  assert.equal(stale.body.data.upToDate, false);
  assert.equal(stale.body.data.current, null);

  const fresh = await download("with-logo");
  assert.equal(fresh.response.headers.get("x-pdf-version"), "2");
  const status = await api("GET", `/api/admin/packages/${pkg.id}/pdf`, { token });
  assert.equal(status.body.data.upToDate, true);
  assert.deepEqual(status.body.data.versions.map((v: { version: number }) => v.version), [2, 1]);
});

test("admin preview of any version, inline; drafts' PDFs are not public", async () => {
  const preview = await (await import("../../test/helpers.ts")).app.request(`/api/admin/packages/${pkg.id}/pdf/1/without-logo`, {
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(preview.status, 200);
  assert.match(preview.headers.get("content-disposition")!, /^inline;/);
  assert.equal(preview.headers.get("cache-control"), "private, no-store");
  assert.equal((await api("GET", `/api/admin/packages/${pkg.id}/pdf/9/with-logo`, { token })).status, 404);
  assert.equal((await api("GET", `/api/admin/packages/${pkg.id}/pdf/1/with-logo`)).status, 401);

  await api("POST", `/api/admin/packages/${pkg.id}/unpublish`, { token });
  assert.equal((await download("with-logo")).response.status, 404);
  // Generated documents are never served from the public media path.
  assert.equal((await api("GET", "/media/documents/itineraries/x.pdf")).status, 404);
});
