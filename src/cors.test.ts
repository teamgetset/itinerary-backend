import assert from "node:assert/strict";
import { test } from "node:test";
import { createApp } from "./app.ts";
import { env, originUrl } from "./config/env.ts";
import "./test/helpers.ts";

/*
 * CORS as on the live site: the apex domain redirects to www, the browser calls the API from www, and both are allowed.
 * The allow-list is read when the app is created, so this file builds its own app after setting the origins.
 */
Object.assign(env, { FRONTEND_URL: "https://www.getsy.test", CORS_EXTRA_ORIGINS: ["https://getsy.test"] });
const app = createApp();

const preflight = (origin: string) =>
  app.request("/api/public/enquiries", {
    method: "OPTIONS",
    headers: { origin, "access-control-request-method": "POST", "access-control-request-headers": "content-type" },
  });

test("the enquiry preflight allows the website's www and apex origins and the admin, nothing else", async () => {
  for (const origin of ["https://www.getsy.test", "https://getsy.test", "http://admin.test"]) {
    const response = await preflight(origin);
    assert.equal(response.status, 204, origin);
    assert.equal(response.headers.get("access-control-allow-origin"), origin, origin);
    assert.match(response.headers.get("access-control-allow-methods") ?? "", /\bPOST\b/);
    assert.match(response.headers.get("access-control-allow-headers") ?? "", /Content-Type/);
    assert.equal(response.headers.get("access-control-allow-credentials"), null, "no cookies across origins");
  }
  for (const origin of ["https://evil.test", "https://www.getsy.test.evil.test", "http://www.getsy.test", "https://getsy.test:8443", "null"]) {
    assert.equal((await preflight(origin)).headers.get("access-control-allow-origin"), null, origin);
  }
});

test("an enquiry sent from the www site is stored and its response is readable by the page", async () => {
  const response = await app.request("/api/public/enquiries", {
    method: "POST",
    headers: { origin: "https://www.getsy.test", "content-type": "application/json" },
    body: JSON.stringify({ name: "CORS Check", phone: "+91 98765 43210", adults: 1, children: 0, infants: 0 }),
  });
  assert.equal(response.status, 201, await response.clone().text());
  assert.equal(response.headers.get("access-control-allow-origin"), "https://www.getsy.test");
  assert.equal(((await response.json()) as { success: boolean }).success, true);
});

test("origins: a trailing slash is dropped; a path, query, credentials or a bare host is refused", () => {
  assert.equal(originUrl.parse("https://www.getsy.me/"), "https://www.getsy.me");
  assert.equal(originUrl.parse("https://getsy.me"), "https://getsy.me");
  assert.equal(originUrl.parse("http://localhost:3000"), "http://localhost:3000");
  for (const bad of ["https://getsy.me/contact", "https://getsy.me/?x=1", "https://user:pw@getsy.me", "getsy.me"]) {
    assert.equal(originUrl.safeParse(bad).success, false, bad);
  }
});
