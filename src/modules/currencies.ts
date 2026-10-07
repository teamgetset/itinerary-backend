import { Hono } from "hono";
import { asc, eq } from "drizzle-orm";
import { z } from "zod";
import { env } from "../config/env.ts";
import { db } from "../db/client.ts";
import { currencies } from "../db/schema.ts";
import { badRequest, notFound } from "../lib/errors.ts";
import { ok, readBody, type AppEnv } from "../lib/http.ts";
import { requireRole } from "./auth/middleware.ts";
import { audit } from "./audit.ts";
import { revalidate } from "./revalidate.ts";

/*
 * Currencies the site can show prices in. Each package carries its own official price per currency;
 * there are no exchange rates anywhere. A currency can be switched off, not deleted, so old prices stay valid.
 */

export type CurrencyRow = typeof currencies.$inferSelect;

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

export async function activeCurrencies() {
  return db.select().from(currencies).where(eq(currencies.isActive, true)).orderBy(asc(currencies.displayOrder), asc(currencies.code));
}

export const currencyAdminRoutes = new Hono<AppEnv>()
  .get("/", async (c) => {
    const rows = await db.select().from(currencies).orderBy(asc(currencies.displayOrder), asc(currencies.code));
    return ok(c, rows.map(currencyDto));
  })
  .post("/", requireRole("ADMIN"), async (c) => {
    const input = await readBody(c, currencyInput);
    const [row] = await db.insert(currencies).values(input).returning();
    await audit(db, c.get("admin"), "CURRENCY_CREATED", "currency", row!.code);
    revalidate("catalog");
    return ok(c, currencyDto(row!), undefined, 201);
  })
  .patch("/:code", requireRole("ADMIN"), async (c) => {
    const code = c.req.param("code").toUpperCase();
    const input = await readBody(c, currencyInput.omit({ code: true }).partial());
    if (input.isActive === false && code === env.DEFAULT_CURRENCY) {
      throw badRequest("DEFAULT_CURRENCY", `${code} is the default currency (DEFAULT_CURRENCY) and cannot be switched off`);
    }
    const [row] = await db.update(currencies).set(input).where(eq(currencies.code, code)).returning();
    if (!row) throw notFound("Currency");
    await audit(db, c.get("admin"), "CURRENCY_UPDATED", "currency", code, { fields: Object.keys(input) });
    revalidate("catalog");
    return ok(c, currencyDto(row));
  });
