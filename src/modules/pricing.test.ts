import assert from "node:assert/strict";
import { test } from "node:test";
import { formatMoney, formatMoneyCode } from "../lib/money.ts";
import { api, catalogue, readyPackage, signIn } from "../test/helpers.ts";
import { calculateTotal } from "./pricing.ts";

const prices = {
  ADULT: { INR: 54999, AED: 2450 },
  CHILD: { INR: 39999, AED: 1800 },
  INFANT: { INR: 8999, AED: 400 },
};

test("total = adult x adults + child x children + infant x infants, per currency", () => {
  const inr = calculateTotal(prices, "INR", { adults: 2, children: 1, infants: 1 });
  assert.equal(inr.total, 2 * 54999 + 39999 + 8999);
  assert.deepEqual(
    inr.lines.map((line) => [line.type, line.count, line.subtotal]),
    [["ADULT", 2, 109998], ["CHILD", 1, 39999], ["INFANT", 1, 8999]],
  );
  const aed = calculateTotal(prices, "AED", { adults: 2, children: 1, infants: 1 });
  assert.equal(aed.total, 2 * 2450 + 1800 + 400);
  // Groups with nobody in them are left out.
  assert.deepEqual(calculateTotal(prices, "AED", { adults: 1, children: 0, infants: 0 }).lines.length, 1);
});

test("a missing price for a traveller type that is present is an error, not a zero", () => {
  const partial = { ADULT: { INR: 1000 }, CHILD: {}, INFANT: {} };
  assert.equal(calculateTotal(partial, "INR", { adults: 2, children: 0, infants: 0 }).total, 2000);
  assert.throws(() => calculateTotal(partial, "INR", { adults: 1, children: 1, infants: 0 }), /no child price in INR/);
});

test("money formatting follows each currency's symbol and grouping", () => {
  assert.equal(formatMoney(54999, { code: "INR", symbol: "₹", locale: "en-IN" }), "₹54,999");
  assert.equal(formatMoney(101500, { code: "INR", symbol: "₹", locale: "en-IN" }), "₹1,01,500");
  assert.equal(formatMoney(2450, { code: "AED", symbol: "د.إ", locale: "en-AE" }), "د.إ2,450");
  assert.equal(formatMoneyCode(2450, { code: "AED", symbol: "د.إ", locale: "en-AE" }), "AED 2,450");
});

test("quote API: uses the published package's official prices", async () => {
  const { token } = await signIn("ADMIN");
  const ids = await catalogue(token);
  const pkg = await readyPackage(token, ids);
  const draftQuote = await api("POST", "/api/public/pricing/quote", { body: { packageSlug: pkg.slug, currency: "AED", adults: 1, children: 0, infants: 0 } });
  assert.equal(draftQuote.status, 404, "drafts are not quotable");
  await api("POST", `/api/admin/packages/${pkg.id}/publish`, { token });

  const quote = await api("POST", "/api/public/pricing/quote", { body: { packageSlug: pkg.slug, currency: "aed", adults: 2, children: 1, infants: 1 } });
  assert.equal(quote.status, 200);
  assert.equal(quote.body.data.currency, "AED");
  assert.equal(quote.body.data.total, 7100);
  const noAdults = await api("POST", "/api/public/pricing/quote", { body: { packageSlug: pkg.slug, currency: "INR", adults: 0, children: 1, infants: 0 } });
  assert.equal(noAdults.body.error.details[0].path, "adults");
  const unsupported = await api("POST", "/api/public/pricing/quote", { body: { packageSlug: pkg.slug, currency: "USD", adults: 1, children: 0, infants: 0 } });
  assert.equal(unsupported.body.error.code, "UNSUPPORTED_CURRENCY");
});
