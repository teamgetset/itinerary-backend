import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import mongoose from "mongoose";
import { env } from "../../config/env.ts";
import { AuditLog, Media, Package, type CloudinaryAsset, type MediaDoc, type PackageDoc } from "../../db/models.ts";
import { log } from "../../lib/logger.ts";
import { api, catalogue, PDF, PHOTO, readyPackage, signIn, uploadPdf, uploadPhoto } from "../../test/helpers.ts";
import { documentStore } from "../media/store.ts";
import { storage } from "../storage.ts";
import { PDF_MAX_BYTES } from "./itinerary-pdf.ts";

/* Uploaded itinerary PDFs. Cloudinary is replaced by an in-memory fake: tests never reach the network. */

const admin = await signIn("ADMIN");
const editor = await signIn("EDITOR");
const ids = await catalogue(admin.token);
let n = 0;
const draft = (pdf = false) => readyPackage(admin.token, ids, { title: `PDF Trip ${++n}` }, { pdf });
const pkgDoc = (id: string) => Package.findById(id).lean<PackageDoc>().then((doc) => doc!);
const mediaDoc = (id: string) => Media.findById(id).lean<MediaDoc>();
const pdfBytes = (size: number) => Buffer.concat([Buffer.from("%PDF-1.7\n"), Buffer.alloc(size - 9, 0x20)]);
const download = (slug: string, query = "") => api("GET", `/api/public/packages/${slug}/pdf${query}`);
const preview = (id: string) => api("GET", `/api/admin/packages/${id}/itinerary-pdf`, { token: admin.token });
/** Collects error logs for the rest of the test instead of printing them. */
function captureErrorLogs(t: TestContext) {
  const logged: Record<string, unknown>[] = [];
  t.mock.method(log, "error", (event: string, fields: Record<string, unknown> = {}) => logged.push({ event, ...fields }));
  return logged;
}

/** Runs with documents on a fake private Cloudinary; `failDestroy` makes deletions fail. */
async function onFakeCloudinary(run: (fake: { files: Map<string, Buffer>; destroyed: string[]; failDestroy: boolean; failUpload: boolean; onUpload?: () => Promise<void> }) => Promise<void>) {
  const saved = { provider: documentStore.provider, cloudinary: documentStore.cloudinary, folder: env.CLOUDINARY_FOLDER };
  const fake = { files: new Map<string, Buffer>(), destroyed: [] as string[], failDestroy: false, failUpload: false, onUpload: undefined as undefined | (() => Promise<void>) };
  const asset = (publicId: string, bytes: number): CloudinaryAsset => ({
    publicId,
    secureUrl: `https://res.cloudinary.com/demo/raw/authenticated/v1/${publicId}`,
    version: 1,
    format: null,
    resourceType: "raw",
    type: "authenticated",
    width: null,
    height: null,
    bytes,
  });
  documentStore.provider = "cloudinary";
  env.CLOUDINARY_FOLDER = "getset/test";
  documentStore.cloudinary = {
    upload: async (publicId, data) => {
      if (fake.failUpload) throw new Error("fake Cloudinary upload failure");
      await fake.onUpload?.();
      fake.files.set(publicId, Buffer.from(data));
      return { asset: asset(publicId, data.length), existing: false };
    },
    download: async (publicId) => {
      const data = fake.files.get(publicId);
      if (!data) throw new Error("not on the fake Cloudinary");
      return data;
    },
    destroy: async (publicId) => {
      if (fake.failDestroy) throw new Error("fake Cloudinary delete failure");
      fake.destroyed.push(publicId);
      fake.files.delete(publicId);
    },
  };
  try {
    await run(fake);
  } finally {
    Object.assign(documentStore, { provider: saved.provider, cloudinary: saved.cloudinary });
    env.CLOUDINARY_FOLDER = saved.folder;
  }
}

test("an editor uploads a PDF: stored privately, recorded with name, size and date, and audited", async () => {
  const pkg = await draft();
  const uploaded = await uploadPdf(editor.token, pkg.id, PDF, "Dubai itinerary (final).pdf");
  assert.equal(uploaded.status, 200, JSON.stringify(uploaded.body));
  const info = uploaded.body.data.pdf;
  assert.equal(info.fileName, "Dubai-itinerary-final.pdf");
  assert.equal(info.sizeBytes, PDF.length);
  assert.ok(Date.parse(info.uploadedAt));
  assert.equal(info.uploadedBy, editor.user.name);

  const editorView = await api("GET", `/api/admin/packages/${pkg.id}`, { token: admin.token });
  assert.deepEqual(editorView.body.data.itineraryPdf, info);
  const record = (await mediaDoc(info.mediaId))!;
  assert.equal(record.kind, "DOCUMENT");
  assert.equal(record.storageKey, `documents/itineraries/${pkg.id}/${info.mediaId}.pdf`);
  assert.deepEqual(await storage.get(record.storageKey), PDF);
  assert.ok(await AuditLog.exists({ action: "ITINERARY_PDF_UPLOADED", entityId: pkg.id }));

  // The admin's package list says which packages have a PDF (for the "Itinerary PDFs" page).
  const list = await api("GET", "/api/admin/packages?pageSize=100", { token: admin.token });
  const row = (id: string) => list.body.data.find((item: { id: string }) => item.id === id);
  assert.deepEqual(row(pkg.id).itineraryPdf, { fileName: info.fileName, sizeBytes: info.sizeBytes, uploadedAt: info.uploadedAt });
  const without = await draft();
  const again = await api("GET", "/api/admin/packages?pageSize=100", { token: admin.token });
  assert.equal(again.body.data.find((item: { id: string }) => item.id === without.id).itineraryPdf, null);
});

test("uploads are checked: empty, too large, wrong type, not really a PDF, no file, not signed in", async () => {
  const pkg = await draft();
  const reject = async (status: number, code: string, ...args: Parameters<typeof uploadPdf> extends [string, string, ...infer R] ? R : never) => {
    const result = await uploadPdf(admin.token, pkg.id, ...args);
    assert.equal(result.status, status, JSON.stringify(result.body));
    assert.equal(result.body.error.code, code);
  };
  await reject(400, "EMPTY_FILE", new Uint8Array(0));
  await reject(413, "FILE_TOO_LARGE", pdfBytes(PDF_MAX_BYTES + 1));
  await reject(413, "FILE_TOO_LARGE", pdfBytes(5 * 1024 * 1024));
  await reject(400, "UNSUPPORTED_FILE", PDF, "itinerary.pdf", "image/png");
  await reject(400, "UNSUPPORTED_FILE", PHOTO, "photo-renamed.pdf", "application/pdf");
  await reject(400, "UNSUPPORTED_FILE", Buffer.from("just text, %PDF- later"), "notes.pdf", "application/pdf");

  const noFile = await api("PUT", `/api/admin/packages/${pkg.id}/itinerary-pdf`, { token: admin.token, form: new FormData() });
  assert.equal(noFile.body.error.code, "INVALID_UPLOAD");
  assert.equal((await uploadPdf("", pkg.id)).status, 401);
  assert.equal((await uploadPdf(admin.token, crypto.randomUUID())).status, 404);

  assert.equal((await pkgDoc(pkg.id)).itineraryPdfId, null, "nothing was attached");
  assert.equal(await Media.countDocuments({ storageKey: new RegExp(`^documents/itineraries/${pkg.id}/`) }), 0, "nothing was stored");
  const exact = await uploadPdf(admin.token, pkg.id, pdfBytes(PDF_MAX_BYTES));
  assert.equal(exact.status, 200, "exactly 4 MB is allowed");
});

test("replacing stores the new PDF first, then deletes the old file and its record; the site is refreshed", async () => {
  const pkg = await draft(true);
  await api("POST", `/api/admin/packages/${pkg.id}/publish`, { token: admin.token });
  const old = (await pkgDoc(pkg.id)).itineraryPdfId!;
  const oldKey = (await mediaDoc(old))!.storageKey;

  const saved = env.REVALIDATE_SECRET;
  const realFetch = globalThis.fetch;
  const refreshed: unknown[] = [];
  env.REVALIDATE_SECRET = "test-revalidate-secret-0123456789";
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    if (String(url).endsWith("/api/revalidate")) {
      refreshed.push(JSON.parse(String(init?.body)));
      return new Response("{}");
    }
    return realFetch(url, init);
  }) as typeof fetch;
  try {
    const replacement = Buffer.concat([PDF, Buffer.from("% replacement\n")]);
    const replaced = await uploadPdf(admin.token, pkg.id, replacement, "new.pdf");
    assert.equal(replaced.status, 200);
    assert.equal(replaced.body.data.warning, undefined);
    await new Promise((resolve) => setTimeout(resolve, 400));
    assert.deepEqual(refreshed, [{ tags: ["catalog"] }], "the website was asked to refresh the package pages");

    const current = (await pkgDoc(pkg.id)).itineraryPdfId!;
    assert.notEqual(current, old);
    assert.equal(await mediaDoc(old), null, "the old record is gone");
    assert.equal(await storage.get(oldKey), null, "the old file is gone");
    assert.equal((await download(pkg.slug)).headers.get("content-length"), String(replacement.length), "the website gets the new file");
    const audit = await AuditLog.findOne({ action: "ITINERARY_PDF_REPLACED", entityId: pkg.id }).lean<{ metadata: Record<string, unknown> }>();
    assert.equal(audit?.metadata.previousMediaId, old);
  } finally {
    globalThis.fetch = realFetch;
    env.REVALIDATE_SECRET = saved;
  }
});

test("replacing: if storing the new file fails, the old PDF stays in place", () =>
  onFakeCloudinary(async (fake) => {
    const pkg = await draft(true);
    const old = (await pkgDoc(pkg.id)).itineraryPdfId;
    fake.failUpload = true;
    const failed = await uploadPdf(admin.token, pkg.id);
    assert.equal(failed.status, 502);
    assert.equal(failed.body.error.code, "STORAGE_ERROR");
    assert.equal((await pkgDoc(pkg.id)).itineraryPdfId, old);
    assert.ok(await mediaDoc(old!), "the old record is untouched");
  }));

test("replacing: if recording fails after the upload, the new file is deleted and the old PDF stays", () =>
  onFakeCloudinary(async (fake) => {
    const pkg = await draft();
    // The package disappears while the file uploads, so the recording step fails.
    fake.onUpload = async () => {
      await Package.updateOne({ _id: pkg.id }, { $set: { deletedAt: new Date() } });
    };
    const failed = await uploadPdf(admin.token, pkg.id);
    assert.equal(failed.status, 404);
    assert.equal(fake.files.size, 0, "the uploaded file was deleted again");
    assert.equal(fake.destroyed.length, 1);
  }));

test("replacing: if the database reports a failure after committing, the new file is kept because the package uses it", (t) =>
  onFakeCloudinary(async (fake) => {
    const pkg = await draft();
    await uploadPdf(admin.token, pkg.id);
    const old = (await pkgDoc(pkg.id)).itineraryPdfId!;
    // The transaction commits, then the caller gets an error anyway (as with an unknown commit result).
    const commit = mongoose.connection.transaction.bind(mongoose.connection);
    t.mock.method(mongoose.connection, "transaction", async (fn: () => Promise<unknown>) => {
      await commit(fn);
      throw new Error("fake: commit result unknown");
    });
    const logged = captureErrorLogs(t);
    const failed = await uploadPdf(admin.token, pkg.id, Buffer.concat([PDF, Buffer.from("% v2\n")]));
    assert.equal(failed.status, 500);

    const current = (await pkgDoc(pkg.id)).itineraryPdfId!;
    assert.notEqual(current, old, "the replacement was committed");
    assert.deepEqual(fake.destroyed, [], "no file was deleted");
    assert.equal((await preview(pkg.id)).status, 200, "the package's new PDF is served");
    const skipped = logged.find((entry) => entry.event === "pdf.discard_skipped");
    assert.equal(skipped?.reason, "in_use");
    assert.equal(skipped?.mediaId, current);
    assert.equal(skipped?.storageKey, (await mediaDoc(current))!.storageKey);
  }));

test("replacing: if it cannot be checked whether the new file is used, it is kept and logged, not deleted", (t) =>
  onFakeCloudinary(async (fake) => {
    const pkg = await draft();
    fake.onUpload = async () => {
      await Package.updateOne({ _id: pkg.id }, { $set: { deletedAt: new Date() } });
    };
    t.mock.method(Package, "exists", () => Promise.reject(new Error("fake database failure")));
    const logged = captureErrorLogs(t);
    const failed = await uploadPdf(admin.token, pkg.id);
    assert.equal(failed.status, 404, "the original error is reported");
    assert.equal(fake.files.size, 1, "the uploaded file was kept");
    assert.deepEqual(fake.destroyed, []);
    const skipped = logged.find((entry) => entry.event === "pdf.discard_skipped");
    assert.equal(skipped?.reason, "lookup_failed");
    assert.equal(skipped?.packageId, pkg.id);
    assert.equal(skipped?.storageKey, [...fake.files.keys()][0], "enough to find the file by hand");
  }));

test("replacing: if the old file cannot be deleted, the new PDF is live, the response says so, the record is kept archived", () =>
  onFakeCloudinary(async (fake) => {
    const pkg = await draft();
    await uploadPdf(admin.token, pkg.id);
    const old = (await pkgDoc(pkg.id)).itineraryPdfId!;
    fake.failDestroy = true;
    const replaced = await uploadPdf(admin.token, pkg.id, Buffer.concat([PDF, Buffer.from("% v2\n")]));
    assert.equal(replaced.status, 200);
    assert.match(replaced.body.data.warning, /new PDF is live, but the previous file could not be deleted/);
    assert.notEqual((await pkgDoc(pkg.id)).itineraryPdfId, old);
    const kept = await mediaDoc(old);
    assert.ok(kept?.deletedAt, "kept, archived, for clean-up");
    assert.equal(fake.files.size, 2, "both files still exist; only the new one is used");
  }));

test("replacing: if the old record cannot be deleted after its file was, the replacement still succeeds and the record is logged", (t) =>
  onFakeCloudinary(async (fake) => {
    const pkg = await draft();
    await uploadPdf(admin.token, pkg.id);
    const old = (await pkgDoc(pkg.id)).itineraryPdfId!;
    const oldKey = (await mediaDoc(old))!.storageKey;
    t.mock.method(Media, "deleteOne", () => Promise.reject(new Error("fake database failure")));
    const logged = captureErrorLogs(t);
    const replaced = await uploadPdf(admin.token, pkg.id, Buffer.concat([PDF, Buffer.from("% v2\n")]));
    assert.equal(replaced.status, 200, JSON.stringify(replaced.body));
    assert.equal(replaced.body.data.warning, undefined, "nothing for the admin to act on: the old file is gone");

    assert.notEqual((await pkgDoc(pkg.id)).itineraryPdfId, old);
    assert.equal(fake.files.size, 1, "the old file was deleted");
    assert.ok((await mediaDoc(old))?.deletedAt, "its record is kept, archived");
    const failure = logged.find((entry) => entry.event === "pdf.record_delete_failed");
    assert.equal(failure?.mediaId, old);
    assert.equal(failure?.storageKey, oldKey);
    assert.equal(failure?.fileDeleted, true);
  }));

test("removing: admins only; the file and record are deleted; a live package keeps its PDF", async () => {
  const pkg = await draft(true);
  const mediaId = (await pkgDoc(pkg.id)).itineraryPdfId!;
  const key = (await mediaDoc(mediaId))!.storageKey;
  assert.equal((await api("DELETE", `/api/admin/packages/${pkg.id}/itinerary-pdf`, { token: editor.token })).status, 403);
  assert.equal((await api("DELETE", `/api/admin/packages/${pkg.id}/itinerary-pdf`)).status, 401);

  await api("POST", `/api/admin/packages/${pkg.id}/publish`, { token: admin.token });
  const live = await api("DELETE", `/api/admin/packages/${pkg.id}/itinerary-pdf`, { token: admin.token });
  assert.equal(live.status, 409);
  assert.equal(live.body.error.code, "PDF_REQUIRED");
  await api("POST", `/api/admin/packages/${pkg.id}/unpublish`, { token: admin.token });

  const removed = await api("DELETE", `/api/admin/packages/${pkg.id}/itinerary-pdf`, { token: admin.token });
  assert.equal(removed.status, 200);
  assert.deepEqual(removed.body.data, { removed: true, fileDeleted: true });
  assert.equal((await pkgDoc(pkg.id)).itineraryPdfId, null);
  assert.equal(await mediaDoc(mediaId), null);
  assert.equal(await storage.get(key), null);
  assert.ok(await AuditLog.exists({ action: "ITINERARY_PDF_REMOVED", entityId: pkg.id }));
  assert.equal((await api("DELETE", `/api/admin/packages/${pkg.id}/itinerary-pdf`, { token: admin.token })).status, 404, "nothing left to remove");
});

test("removing: if the file cannot be deleted, the response says so instead of claiming success", () =>
  onFakeCloudinary(async (fake) => {
    const pkg = await draft();
    await uploadPdf(admin.token, pkg.id);
    const mediaId = (await pkgDoc(pkg.id)).itineraryPdfId!;
    fake.failDestroy = true;
    const removed = await api("DELETE", `/api/admin/packages/${pkg.id}/itinerary-pdf`, { token: admin.token });
    assert.equal(removed.status, 200);
    assert.equal(removed.body.data.fileDeleted, false);
    assert.match(removed.body.data.warning, /could not be deleted from storage/);
    assert.equal((await pkgDoc(pkg.id)).itineraryPdfId, null, "the package no longer points at it");
    assert.ok((await mediaDoc(mediaId))?.deletedAt, "kept, archived, for clean-up");
  }));

test("the media library cannot archive a package's PDF; other files are archived as before", async () => {
  const pkg = await draft(true);
  const mediaId = (await pkgDoc(pkg.id)).itineraryPdfId!;
  const refused = await api("DELETE", `/api/admin/media/${mediaId}`, { token: admin.token });
  assert.equal(refused.status, 409);
  assert.equal(refused.body.error.code, "IN_USE");
  assert.equal((await mediaDoc(mediaId))!.deletedAt, null, "still live");
  assert.equal((await preview(pkg.id)).status, 200, "still served");

  const photo = await uploadPhoto(admin.token);
  assert.equal((await api("DELETE", `/api/admin/media/${photo}`, { token: admin.token })).status, 200);
});

test("the public download streams the private file with a safe name; no storage URL reaches the browser", () =>
  onFakeCloudinary(async () => {
    const pkg = await draft(true);
    await api("POST", `/api/admin/packages/${pkg.id}/publish`, { token: admin.token });
    for (const query of ["", "?branding=without-logo"]) {
      const file = await download(pkg.slug, query);
      assert.equal(file.status, 200);
      assert.equal(file.headers.get("content-type"), "application/pdf");
      assert.equal(file.headers.get("content-disposition"), `attachment; filename="getset-${pkg.slug}-itinerary.pdf"`);
      assert.equal(file.headers.get("x-content-type-options"), "nosniff");
      assert.equal(file.body.raw.startsWith("%PDF-"), true);
    }
    const detail = await api("GET", `/api/public/packages/${pkg.slug}`);
    assert.match(detail.body.data.pdf.url, new RegExp(`/api/public/packages/${pkg.slug}/pdf$`));
    assert.equal(detail.body.data.pdf.sizeBytes, PDF.length);
    const editorView = await api("GET", `/api/admin/packages/${pkg.id}`, { token: admin.token });
    for (const body of [detail.body, editorView.body]) assert.doesNotMatch(JSON.stringify(body), /cloudinary|authenticated/i);
  }));

test("no PDF: the page still works (pdf: null) and the download answers 'not available'", async () => {
  // A package published before PDFs were required.
  const pkg = await draft();
  await Package.updateOne({ _id: pkg.id }, { $set: { status: "PUBLISHED", publishedAt: new Date() } });
  const detail = await api("GET", `/api/public/packages/${pkg.slug}`);
  assert.equal(detail.status, 200);
  assert.equal(detail.body.data.pdf, null);
  const missing = await download(pkg.slug);
  assert.equal(missing.status, 404);
  assert.equal(missing.body.error.code, "PDF_NOT_AVAILABLE");
  assert.equal((await download("no-such-package")).status, 404);

  // Its other content stays editable: the PDF rule applies when publishing.
  const edited = await api("PATCH", `/api/admin/packages/${pkg.id}`, { token: admin.token, body: { shortDescription: "Edited while live." } });
  assert.equal(edited.status, 200, JSON.stringify(edited.body));

  // A record whose file has gone missing from storage is treated as not available, not as a crash.
  const withFile = await draft(true);
  await api("POST", `/api/admin/packages/${withFile.id}/publish`, { token: admin.token });
  await storage.delete((await mediaDoc((await pkgDoc(withFile.id)).itineraryPdfId!))!.storageKey);
  assert.equal((await download(withFile.slug)).body.error.code, "PDF_NOT_AVAILABLE");
});

test("publishing needs the PDF; once uploaded it is allowed", async () => {
  const pkg = await draft();
  const blocked = await api("POST", `/api/admin/packages/${pkg.id}/publish`, { token: admin.token });
  assert.equal(blocked.status, 422);
  assert.equal(blocked.body.error.code, "PUBLISH_BLOCKED");
  assert.deepEqual(blocked.body.error.details, [{ path: "itineraryPdf", message: "Upload the itinerary PDF." }]);
  assert.equal((await pkgDoc(pkg.id)).status, "DRAFT");

  await uploadPdf(admin.token, pkg.id);
  const published = await api("POST", `/api/admin/packages/${pkg.id}/publish`, { token: admin.token });
  assert.equal(published.status, 200, JSON.stringify(published.body));
  assert.equal((await pkgDoc(pkg.id)).status, "PUBLISHED");
});

test("a duplicate starts without a PDF (each package owns its file)", async () => {
  const pkg = await draft(true);
  const copy = await api("POST", `/api/admin/packages/${pkg.id}/duplicate`, { token: admin.token });
  assert.equal(copy.status, 201);
  assert.equal(copy.body.data.itineraryPdf, null);
  assert.ok((await pkgDoc(pkg.id)).itineraryPdfId, "the original keeps its PDF");
});

test("the admin preview streams the PDF inline and is never cached", async () => {
  const pkg = await draft(true);
  const preview = await api("GET", `/api/admin/packages/${pkg.id}/itinerary-pdf`, { token: editor.token });
  assert.equal(preview.status, 200);
  assert.equal(preview.headers.get("content-disposition"), 'inline; filename="itinerary.pdf"');
  assert.equal(preview.headers.get("cache-control"), "private, no-store");
  assert.equal((await api("GET", `/api/admin/packages/${pkg.id}/itinerary-pdf`)).status, 401);
  const none = await draft();
  assert.equal((await api("GET", `/api/admin/packages/${none.id}/itinerary-pdf`, { token: admin.token })).status, 404);
});
