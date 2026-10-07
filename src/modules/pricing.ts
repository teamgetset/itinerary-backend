import { z } from "zod";
import { AppError, notFound } from "../lib/errors.ts";
import { activeCurrencies } from "./currencies.ts";
import { getPublicPackage, priceTable, type PriceTable } from "./packages/read.ts";

/*
 * Trip totals. The calculation lives here (not in any UI), so the website, enquiries and anything later
 * (bookings, quotes) use the same rule: each traveller pays the official price for their age group.
 */

export interface Travellers {
  adults: number;
  children: number;
  infants: number;
}

const TYPES = [
  ["adults", "ADULT"],
  ["children", "CHILD"],
  ["infants", "INFANT"],
] as const;

/** (adult x adults) + (child x children) + (infant x infants), in one currency. */
export function calculateTotal(prices: PriceTable, currency: string, travellers: Travellers) {
  const lines = TYPES.filter(([group]) => travellers[group] > 0).map(([group, type]) => {
    const unitPrice = prices[type][currency];
    if (unitPrice === undefined) {
      throw new AppError(422, "PRICE_UNAVAILABLE", `There is no ${type.toLowerCase()} price in ${currency} for this package yet.`);
    }
    return { type, count: travellers[group], unitPrice, subtotal: Math.round(unitPrice * travellers[group] * 100) / 100 };
  });
  return { currency, lines, total: Math.round(lines.reduce((sum, line) => sum + line.subtotal, 0) * 100) / 100 };
}

export const travellersInput = z.object({
  adults: z.number().int().min(1, "At least one adult.").max(30),
  children: z.number().int().min(0).max(30),
  infants: z.number().int().min(0).max(30),
});

export const quoteInput = travellersInput.extend({
  packageSlug: z.string().min(1).max(120),
  currency: z.string().trim().toUpperCase().regex(/^[A-Z]{3}$/),
});

export async function quote(input: z.infer<typeof quoteInput>) {
  const graph = await getPublicPackage(input.packageSlug);
  if (!graph) throw notFound("Package");
  const codes = new Set((await activeCurrencies()).map((currency) => currency.code));
  if (!codes.has(input.currency)) throw new AppError(400, "UNSUPPORTED_CURRENCY", `${input.currency} is not offered`);
  return { packageSlug: graph.slug, ...calculateTotal(priceTable(graph.prices, codes), input.currency, input) };
}
