import { Hono } from "hono";
import { z } from "zod";
import { env } from "../config/env.ts";
import { Currency, defined, type CurrencyDoc } from "../db/models.ts";
import { badRequest, notFound } from "../lib/errors.ts";
import { ok, readBody, type AppEnv } from "../lib/http.ts";
import { requireRole } from "./auth/middleware.ts";
import { audit } from "./audit.ts";
import { revalidate } from "./revalidate.ts";

/*
 * Currencies the site can show prices in. Each package carries its own official price per currency;
 * there are no exchange rates anywhere. A currency can be switched off, not deleted, so old prices stay valid.
 */

/** A currency with its code (stored as the document id). */
export type CurrencyRow = Omit<CurrencyDoc, "_id"> & { code: string };

const toRow = ({ _id, ...rest }: CurrencyDoc): CurrencyRow => ({ code: _id, ...rest });

const currencyInput = z.object({
  code: z.string().trim().toUpperCase().regex(/^[A-Z]{3}$/, "ISO 4217 code, e.g. AED"),
  symbol: z.string().trim().min(1).max(8),
  name: z.string().trim().min(1).max(60),
  locale: z
    .string()
    .trim()
    .max(20)
    .refine((value) => {
      try {
        return Intl.NumberFormat.supportedLocalesOf(value).length > 0;
      } catch {
        return false;
      }
    }, "Unknown locale, e.g. en-IN")
    .optional(),
  displayOrder: z.number().int().min(0).optional(),
  isActive: z.boolean().optional(),
});

export const currencyDto = (row: CurrencyRow) => ({
  code: row.code,
  symbol: row.symbol,
  name: row.name,
  locale: row.locale,
  displayOrder: row.displayOrder,
  isActive: row.isActive,
});

// ponytail: the countries GETSET has offices in, for branches saved before they had a currency; a branch anywhere
// else has its currency set in the admin.
const COUNTRY_CURRENCY: Record<string, string> = { AE: "AED", IN: "INR" };

/**
 * The one currency a branch's packages are priced in, entered in and shown in: the branch's own setting, else its
 * country's (Dubai AED, Calicut INR), else the default currency. Nothing is converted.
 */
export const branchCurrency = (branch: { currencyCode?: string | null; countryCode: string }) =>
  branch.currencyCode ?? COUNTRY_CURRENCY[branch.countryCode] ?? env.DEFAULT_CURRENCY;

export async function activeCurrencies() {
  return (await Currency.find({ isActive: true }).sort({ displayOrder: 1, _id: 1 }).lean<CurrencyDoc[]>()).map(toRow);
}

export const currencyAdminRoutes = new Hono<AppEnv>()
  .get("/", async (c) => {
    const rows = await Currency.find().sort({ displayOrder: 1, _id: 1 }).lean<CurrencyDoc[]>();
    return ok(c, rows.map(toRow).map(currencyDto));
  })
  .post("/", requireRole("ADMIN"), async (c) => {
    const { code, ...input } = await readBody(c, currencyInput);
    const created = await Currency.create({ _id: code, ...defined(input) });
    await audit(c.get("admin"), "CURRENCY_CREATED", "currency", code);
    revalidate("catalog");
    return ok(c, currencyDto(toRow(created.toObject() as CurrencyDoc)), undefined, 201);
  })
  .patch("/:code", requireRole("ADMIN"), async (c) => {
    const code = c.req.param("code").toUpperCase();
    const input = await readBody(c, currencyInput.omit({ code: true }).partial());
    if (input.isActive === false && code === env.DEFAULT_CURRENCY) {
      throw badRequest("DEFAULT_CURRENCY", `${code} is the default currency (DEFAULT_CURRENCY) and cannot be switched off`);
    }
    const fields = defined(input);
    const row = Object.keys(fields).length
      ? await Currency.findOneAndUpdate({ _id: code }, { $set: fields }, { returnDocument: "after" }).lean<CurrencyDoc>()
      : await Currency.findById(code).lean<CurrencyDoc>();
    if (!row) throw notFound("Currency");
    await audit(c.get("admin"), "CURRENCY_UPDATED", "currency", code, { fields: Object.keys(input) });
    revalidate("catalog");
    return ok(c, currencyDto(toRow(row)));
  });
