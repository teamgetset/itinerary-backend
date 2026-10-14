import assert from "node:assert/strict";
import { test } from "node:test";
import { Media, type CloudinaryAsset, type MediaDoc } from "../../db/models.ts";
import { PHOTO, api, app, signIn, uploadPhoto } from "../../test/helpers.ts";
import { imageStore } from "./store.ts";

/* Cloudinary is replaced by a fake here: tests never reach the network or the real account. */

const { token } = await signIn("ADMIN");

const fakeAsset = (publicId: string, bytes: number): CloudinaryAsset => ({
  publicId,
  secureUrl: `https://res.cloudinary.com/demo/image/upload/v1/${publicId}.jpg`,
  version: 1,
  format: "jpg",
  resourceType: "image",
  type: "upload",
  width: 1800,
  height: 1200,
  bytes,
});

const postPhoto = () => {
  const form = new FormData();
  form.append("file", new File([PHOTO], "photo.jpg", { type: "image/jpeg" }));
  return api("POST", "/api/admin/media", { token, form });
};

test("an image on Cloudinary is served from its Cloudinary URL; its old local address redirects there", async () => {
  const movedId = await uploadPhoto(token, "moved.jpg");
  const localId = await uploadPhoto(token, "still-local.jpg");
  const moved = (await Media.findById(movedId).lean<MediaDoc>())!;
  const asset = fakeAsset(`getset/test/images/${movedId}`, PHOTO.length);
  await Media.updateOne({ _id: movedId }, { $set: { cloudinary: asset } });

  assert.equal((await api("GET", `/api/admin/media/${movedId}`, { token })).body.data.url, asset.secureUrl);
  const redirect = await app.request(`/media/${moved.storageKey}`);
  assert.equal(redirect.status, 301);
  assert.equal(redirect.headers.get("location"), asset.secureUrl);

  // Images not moved keep their address and are served from local storage as before.
  const local = (await Media.findById(localId).lean<MediaDoc>())!;
  assert.equal(new URL((await api("GET", `/api/admin/media/${localId}`, { token })).body.data.url).pathname, `/media/${local.storageKey}`);
  const served = await app.request(`/media/${local.storageKey}`);
  assert.equal(served.status, 200);
  assert.equal(Buffer.from(await served.arrayBuffer()).equals(PHOTO), true);
});

test("with STORAGE_PROVIDER=cloudinary, uploads go to Cloudinary under the media id; failed uploads store nothing", async () => {
  const original = { ...imageStore, cloudinary: { ...imageStore.cloudinary } };
  const uploaded: string[] = [];
  imageStore.provider = "cloudinary";
  imageStore.cloudinary = {
    upload: async (mediaId, data) => {
      uploaded.push(mediaId);
      return { asset: fakeAsset(`getset/test/images/${mediaId}`, data.length), existing: false };
    },
    destroy: async () => {},
  };
  try {
    const id = await uploadPhoto(token, "new.jpg");
    assert.deepEqual(uploaded, [id]);
    const doc = (await Media.findById(id).lean<MediaDoc>())!;
    assert.equal(doc.storageKey, `getset/test/images/${id}`);
    assert.equal(doc.cloudinary?.publicId, `getset/test/images/${id}`);
    assert.equal((await api("GET", `/api/admin/media/${id}`, { token })).body.data.url, doc.cloudinary?.secureUrl);

    const before = await Media.countDocuments();
    imageStore.cloudinary.upload = async () => {
      throw new Error("network down");
    };
    const down = await postPhoto();
    assert.equal(down.status, 502);
    assert.equal(down.body.error.code, "STORAGE_ERROR");
    // An asset that does not match what was sent is refused too.
    imageStore.cloudinary.upload = async (mediaId) => ({ asset: fakeAsset(`getset/test/images/${mediaId}`, 1), existing: false });
    assert.equal((await postPhoto()).status, 502);
    assert.equal(await Media.countDocuments(), before);
  } finally {
    Object.assign(imageStore, original);
  }
});
