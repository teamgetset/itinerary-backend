import assert from "node:assert/strict";
import { test } from "node:test";
import { Media, type CloudinaryAsset, type MediaDoc } from "../../db/models.ts";
import { api, app, catalogue, readyPackage, signIn } from "../../test/helpers.ts";
import { documentStore } from "../media/store.ts";

/* Where PDFs are stored. Cloudinary is replaced by a fake: tests never reach the network or the real account. */

const { token } = await signIn("SUPER_ADMIN");
const ids = await catalogue(token);

const privateAsset = (publicId: string, bytes: number): CloudinaryAsset => ({
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

test("with STORAGE_PROVIDER=cloudinary, both prints are stored privately and downloads stream them through the API", async () => {
  const original = { ...documentStore, cloudinary: { ...documentStore.cloudinary } };
  const files = new Map<string, Buffer>();
  documentStore.provider = "cloudinary";
  documentStore.cloudinary = {
    upload: async (publicId, data) => {
      files.set(publicId, data);
      return { asset: privateAsset(publicId, data.length), existing: false };
    },
    download: async (publicId) => {
      const data = files.get(publicId);
      if (!data) throw new Error("not on the fake Cloudinary");
      return data;
    },
  };
  try {
    const pkg = await readyPackage(token, ids, { title: "Cloud PDF trip" });
    const built = await api("POST", `/api/admin/packages/${pkg.id}/pdf`, { token });
    assert.equal(built.status, 200);
    assert.equal(built.body.data.version, 1);
    // The admin API keeps its former shape: no storage internals.
    assert.equal("cloudinary" in built.body.data.withLogo, false);
    assert.equal(files.size, 2);
    for (const publicId of files.keys()) assert.match(publicId, /\/documents\/itineraries\/[0-9a-f-]{36}\/v1-with(out)?-logo-[0-9a-f]{12}\.pdf$/);

    const record = (await Media.findById(built.body.data.withLogo.mediaId).lean<MediaDoc>())!;
    assert.equal(record.cloudinary?.type, "authenticated");
    assert.equal(record.storageKey, record.cloudinary?.publicId);

    const inline = await api("GET", `/api/admin/packages/${pkg.id}/pdf/1/with-logo`, { token });
    assert.equal(inline.status, 200);
    await api("POST", `/api/admin/packages/${pkg.id}/publish`, { token });
    const download = await app.request(`/api/public/packages/${pkg.slug}/pdf?branding=without-logo`);
    assert.equal(download.status, 200);
    assert.match(download.headers.get("content-disposition")!, /attachment; filename="getset-cloud-pdf-trip-itinerary-no-logo\.pdf"/);
    const withoutLogo = [...files.entries()].find(([id]) => id.includes("without-logo"))![1];
    assert.equal(Buffer.from(await download.arrayBuffer()).equals(withoutLogo), true);
    assert.equal(files.size, 2, "publishing reused the PDF: no new upload");
  } finally {
    Object.assign(documentStore, original);
  }
});

test("moving a photo to another host does not make a new PDF version (URLs are not printed)", async () => {
  const pkg = await readyPackage(token, ids, { title: "Stable hash trip" });
  const first = await api("POST", `/api/admin/packages/${pkg.id}/pdf`, { token });
  assert.equal(first.body.data.version, 1);
  await Media.updateOne(
    { _id: ids.photoId },
    { $set: { cloudinary: { ...privateAsset(`getset/test/images/${ids.photoId}`, 1), resourceType: "image", type: "upload", format: "jpg", secureUrl: `https://res.cloudinary.com/demo/image/upload/v1/getset/test/images/${ids.photoId}.jpg` } } },
  );
  const hero = (await api("GET", `/api/admin/packages/${pkg.id}`, { token })).body.data.heroImage;
  assert.match(hero.url, /^https:\/\/res\.cloudinary\.com\//, "the hero image URL did change");
  const again = await api("POST", `/api/admin/packages/${pkg.id}/pdf`, { token });
  assert.equal(again.body.data.version, 1);
  assert.equal(again.body.data.id, first.body.data.id);
  const status = (await api("GET", `/api/admin/packages/${pkg.id}/pdf`, { token })).body.data;
  assert.equal(status.upToDate, true);
  assert.equal(status.versions.length, 1);
});
