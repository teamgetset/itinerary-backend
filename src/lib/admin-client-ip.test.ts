import assert from "node:assert/strict";
import { test } from "node:test";
import { env } from "../config/env.ts";
import { api, signIn } from "../test/helpers.ts";
import { FORWARDED_IP_HEADER, PROXY_SECRET_HEADER } from "./http.ts";

/*
 * The admin's server signs people in from Vercel, so on Render every admin sign-in arrives from Vercel's address.
 * With ADMIN_PROXY_SECRET it passes on each visitor's own address; without a valid secret that address is ignored.
 * Each test uses its own addresses, so the in-process counters of one test never affect another.
 */

const SECRET = "test-only-admin-proxy-secret-0123456789";
const VERCEL = "198.51.100.200"; // what CF-Connecting-IP shows for every request from the admin's server

const fromAdmin = (visitor: string, secret = SECRET) => ({ "cf-connecting-ip": VERCEL, [FORWARDED_IP_HEADER]: visitor, [PROXY_SECRET_HEADER]: secret });
const login = (email: string, headers: Record<string, string>, password = "wrong-password") =>
  api("POST", "/api/auth/login", { body: { email, password }, headers });
let next = 0;
const unknownEmail = () => `nobody-${next++}@example.invalid`;

/** Render with the secret configured, as in production (null: not configured); restored afterwards. */
async function onRender(run: () => Promise<void>, secret: string | null = SECRET) {
  const saved = { proxy: env.TRUST_PROXY, secret: env.ADMIN_PROXY_SECRET };
  env.TRUST_PROXY = "cloudflare";
  env.ADMIN_PROXY_SECRET = secret ?? undefined;
  try {
    await run();
  } finally {
    env.TRUST_PROXY = saved.proxy;
    env.ADMIN_PROXY_SECRET = saved.secret;
  }
}

/** 20 failed sign-ins pass, the 21st is refused: proof that all of them were counted for one address. */
async function exhaust(headers: () => Record<string, string>) {
  for (let i = 0; i < 20; i++) assert.equal((await login(unknownEmail(), headers())).status, 401, `attempt ${i + 1}`);
  return (await login(unknownEmail(), headers())).status;
}

test("with the secret, each visitor has their own sign-in limit: one person cannot lock out the others", () =>
  onRender(async () => {
    assert.equal(await exhaust(() => fromAdmin("203.0.113.10")), 429);
    assert.equal((await login(unknownEmail(), fromAdmin("203.0.113.11"))).status, 401, "another visitor through the same admin server");
    assert.equal((await login(unknownEmail(), fromAdmin("2001:db8::11"))).status, 401, "IPv6 visitors work too");
  }));

test("a wrong secret means the passed-on address is ignored: attempts count for the sender's own address", () =>
  onRender(async () => {
    let n = 0;
    const forged = () => ({ ...fromAdmin(`203.0.113.${100 + n++}`, "a-wrong-secret-that-is-long-enough-0000"), "cf-connecting-ip": "198.51.100.21" });
    assert.equal(await exhaust(forged), 429, "changing the forged address every time does not help");
    assert.equal((await login(unknownEmail(), { "cf-connecting-ip": "198.51.100.21", [FORWARDED_IP_HEADER]: "203.0.113.250" })).status, 429, "no secret at all: ignored too");
    assert.equal((await login(unknownEmail(), { "cf-connecting-ip": "198.51.100.21", [PROXY_SECRET_HEADER]: "", [FORWARDED_IP_HEADER]: "203.0.113.251" })).status, 429, "an empty secret: ignored");
  }));

test("when the API has no secret configured, passed-on addresses are always ignored", () =>
  onRender(async () => {
    let n = 0;
    assert.equal(await exhaust(() => ({ ...fromAdmin(`203.0.113.${n++}`), "cf-connecting-ip": "198.51.100.22" })), 429);
  }, null));

test("a malformed passed-on address is never used as a key, even with the right secret", () =>
  onRender(async () => {
    const malformed = ["not-an-ip", "203.0.113.1, 203.0.113.2", "", "999.1.1.1", "203.0.113.1:8080"];
    let n = 0;
    assert.equal(await exhaust(() => ({ ...fromAdmin(malformed[n++ % malformed.length]!), "cf-connecting-ip": "198.51.100.23" })), 429);
  }));

test("forged X-Forwarded-For and CF-Connecting-IP cannot replace a valid passed-on address", () =>
  onRender(async () => {
    let n = 0;
    const headers = () => ({ ...fromAdmin("203.0.113.30"), "cf-connecting-ip": `198.51.100.${30 + (n % 50)}`, "x-forwarded-for": `192.0.2.${n++ % 200}` });
    assert.equal(await exhaust(headers), 429, "all counted for the visitor 203.0.113.30");
  }));

test("the per-account sign-in limit still holds, whatever visitor addresses are passed on", async () => {
  const { email } = await signIn();
  await onRender(async () => {
    for (let i = 0; i < 5; i++) assert.equal((await login(email, fromAdmin(`203.0.113.${60 + i}`), `wrong-${i}`)).status, 401);
    const blocked = await login(email, fromAdmin("203.0.113.69"), "wrong-x");
    assert.equal(blocked.status, 429);
    assert.equal(blocked.body.error.code, "TOO_MANY_REQUESTS");
  });
});

test("enquiries: forged admin headers do not reset the per-address limit", () =>
  onRender(async () => {
    const enquiry = { name: "Rate Test", phone: "+91 98765 43210", adults: 1, children: 0, infants: 0 };
    const send = async (headers: Record<string, string>) => (await api("POST", "/api/public/enquiries", { body: enquiry, headers })).status;
    const visitor = { "cf-connecting-ip": "198.51.100.40" };
    for (let i = 0; i < 5; i++) assert.equal(await send(visitor), 201);
    assert.equal(await send({ ...visitor, [FORWARDED_IP_HEADER]: "203.0.113.70", [PROXY_SECRET_HEADER]: "a-wrong-secret-that-is-long-enough-0000" }), 429);
    assert.equal(await send({ ...visitor, [FORWARDED_IP_HEADER]: "203.0.113.71" }), 429);
  }));

test("locally (no Render, no secret) nothing changes: forwarded headers are ignored", async () => {
  assert.equal(env.TRUST_PROXY, "false");
  assert.equal(env.ADMIN_PROXY_SECRET, undefined);
  // Every request shares the connection's address ("unknown" in tests; an earlier sign-in already used it once),
  // so 21 attempts with ever-changing passed-on addresses still end refused.
  const statuses = [];
  for (let n = 0; n < 21; n++) statuses.push((await login(unknownEmail(), fromAdmin(`203.0.113.${150 + n}`))).status);
  assert.equal(statuses.at(-1), 429);
  assert.ok(statuses.every((status) => status === 401 || status === 429));
});
