import assert from "node:assert/strict";
import { test } from "node:test";
import { env } from "../config/env.ts";
import { api, signIn } from "../test/helpers.ts";

/*
 * Which address rate limits count. Behind Render, Cloudflare overwrites CF-Connecting-IP and appends to
 * X-Forwarded-For, so only CF-Connecting-IP may be trusted, and only when TRUST_PROXY=cloudflare.
 * Tests run in order: the first one uses up the shared "connection address" allowance that a later one relies on.
 */

const enquiry = { name: "Rate Test", phone: "+91 98765 43210", adults: 1, children: 0, infants: 0 };
const send = async (headers: Record<string, string>) => (await api("POST", "/api/public/enquiries", { body: enquiry, headers })).status;

async function onRender(run: () => Promise<void>) {
  env.TRUST_PROXY = "cloudflare";
  try {
    await run();
  } finally {
    env.TRUST_PROXY = "false";
  }
}

test("by default no forwarding header is trusted: spoofed addresses still share the connection's limit", async () => {
  const statuses = [];
  for (let i = 0; i < 6; i++) statuses.push(await send({ "x-forwarded-for": `203.0.113.${i}`, "cf-connecting-ip": `198.51.100.${i}` }));
  assert.deepEqual(statuses, [201, 201, 201, 201, 201, 429]);
});

test("on Render, enquiries are counted per CF-Connecting-IP and a spoofed X-Forwarded-For changes nothing", () =>
  onRender(async () => {
    const visitor = { "cf-connecting-ip": "198.51.100.7" };
    for (let i = 0; i < 5; i++) assert.equal(await send({ ...visitor, "x-forwarded-for": `203.0.113.${i}` }), 201);
    assert.equal(await send({ ...visitor, "x-forwarded-for": "203.0.113.250" }), 429, "a new X-Forwarded-For does not reset the limit");
    assert.equal(await send({ "x-forwarded-for": "203.0.113.251" }), 429, "X-Forwarded-For alone is ignored (the connection's limit is used up)");
    assert.equal(await send({ "cf-connecting-ip": "198.51.100.8" }), 201, "another visitor has their own limit");
    assert.equal(await send({ "cf-connecting-ip": "2001:db8::8" }), 201, "IPv6 addresses work");
    assert.equal(await send({ "cf-connecting-ip": "not-an-ip" }), 429, "an invalid value falls back to the connection's address");
  }));

test("on Render, sign-in attempts are counted per CF-Connecting-IP, whatever X-Forwarded-For says", () =>
  onRender(async () => {
    const attempt = (n: number) =>
      api("POST", "/api/auth/login", {
        body: { email: `nobody-${n}@example.invalid`, password: "wrong-password" },
        headers: { "cf-connecting-ip": "198.51.100.30", "x-forwarded-for": `203.0.113.${n}` },
      });
    for (let n = 0; n < 20; n++) assert.equal((await attempt(n)).status, 401);
    assert.equal((await attempt(20)).status, 429);
  }));

test("on Render, the per-account sign-in limit still holds across addresses", async () => {
  const { email } = await signIn();
  await onRender(async () => {
    for (let i = 0; i < 5; i++) {
      await api("POST", "/api/auth/login", { body: { email, password: `wrong-${i}` }, headers: { "cf-connecting-ip": `198.51.100.${40 + i}` } });
    }
    const blocked = await api("POST", "/api/auth/login", { body: { email, password: "wrong-x" }, headers: { "cf-connecting-ip": "198.51.100.99" } });
    assert.equal(blocked.status, 429);
    assert.equal(blocked.body.error.code, "TOO_MANY_REQUESTS");
  });
});
