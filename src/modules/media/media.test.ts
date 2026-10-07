import assert from "node:assert/strict";
import { test } from "node:test";
import { PHOTO, api, app, signIn, uploadPhoto } from "../../test/helpers.ts";

const { token } = await signIn("ADMIN");

const upload = (name: string, bytes: Uint8Array, bearer = token, type = "image/jpeg") => {
  const form = new FormData();
  form.append("file", new File([bytes], name, { type }));
  return api("POST", "/api/admin/media", { token: bearer, form });
};

test("upload: a real image is stored, catalogued and publicly served", async () => {
  const result = await upload("Dubai Marina!!.JPG", PHOTO);
  assert.equal(result.status, 201);
  assert.equal(result.body.data.mimeType, "image/jpeg");
  assert.equal(result.body.data.fileName, "Dubai-Marina.jpg");
  assert.equal(result.body.data.sizeBytes, PHOTO.length);
  const path = new URL(result.body.data.url).pathname;
  assert.match(path, /^\/media\/images\/\d{4}\/\d{2}\/[0-9a-f-]{36}\.jpg$/);
  const served = await app.request(path);
  assert.equal(served.status, 200);
  assert.equal(served.headers.get("content-type"), "image/jpeg");
  assert.match(served.headers.get("cache-control")!, /immutable/);
});

test("upload checks the bytes, not the name: a renamed text file is refused", async () => {
  const fake = await upload("photo.jpg", new TextEncoder().encode("<script>alert(1)</script>"));
  assert.equal(fake.status, 400);
  assert.equal(fake.body.error.code, "UNSUPPORTED_FILE");
  const svg = await upload("logo.svg", new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"/>'), token, "image/svg+xml");
  assert.equal(svg.body.error.code, "UNSUPPORTED_FILE");
  const empty = await upload("empty.jpg", new Uint8Array());
  assert.equal(empty.body.error.code, "INVALID_UPLOAD");
});

test("upload size is limited to 10 MB", async () => {
  const big = new Uint8Array(11 * 1024 * 1024);
  big.set(PHOTO.subarray(0, 3));
  const result = await upload("huge.jpg", big);
  assert.equal(result.status, 413);
});

test("library: search, edit alt text and focal point, archive", async () => {
  const id = await uploadPhoto(token, "georgia-kazbegi.jpg");
  const found = await api("GET", "/api/admin/media?q=kazbegi", { token });
  assert.deepEqual(found.body.data.map((m: { id: string }) => m.id), [id]);
  const edited = await api("PATCH", `/api/admin/media/${id}`, { token, body: { alt: "Gergeti church below Kazbek", focalPoint: "center 30%" } });
  assert.equal(edited.body.data.alt, "Gergeti church below Kazbek");
  assert.equal(edited.body.data.focalPoint, "center 30%");
  const badFocal = await api("PATCH", `/api/admin/media/${id}`, { token, body: { focalPoint: "url(javascript:1)" } });
  assert.equal(badFocal.status, 400);

  const editor = await signIn("EDITOR");
  assert.equal((await api("DELETE", `/api/admin/media/${id}`, { token: editor.token })).status, 403);
  assert.equal((await api("DELETE", `/api/admin/media/${id}`, { token })).status, 200);
  assert.equal((await api("GET", "/api/admin/media?q=kazbegi", { token })).body.data.length, 0);
});

test("uploads need a signed-in admin", async () => {
  assert.equal((await upload("x.jpg", PHOTO, "")).status, 401);
});
