import { Hono } from "hono";
import { and, count, desc, eq, ilike, or } from "drizzle-orm";
import { z } from "zod";
import { db } from "../db/client.ts";
import { adminUsers, branches, enquiries, enquiryNotes, packages } from "../db/schema.ts";
import { AppError, notFound } from "../lib/errors.ts";
import { idParam, ok, pageMeta, pageQuery, readBody, readQuery, type AppEnv } from "../lib/http.ts";
import { log } from "../lib/logger.ts";
import { rateLimiter } from "../lib/rate-limit.ts";
import { escapeLike } from "../lib/text.ts";
import { audit } from "./audit.ts";
import { activeCurrencies } from "./currencies.ts";
import { getPublicPackage, priceTable } from "./packages/read.ts";
import { calculateTotal, travellersInput } from "./pricing.ts";

/* Leads from the website. Public visitors create them; staff track them through to a booking. */

const STATUSES = ["NEW", "CONTACTED", "IN_PROGRESS", "CONVERTED", "CLOSED"] as const;
const phone = z
  .string()
  .trim()
  .max(30)
  .regex(/^\+?[\d\s()-]{7,}$/, "Enter a valid phone number")
  .nullish()
  .transform((value) => value || null);

export const enquiryInput = travellersInput
  .extend({
    name: z.string().trim().min(2, "Please tell us your name.").max(100),
    email: z.email("Enter a valid email address.").max(254).nullish().or(z.literal("").transform(() => null)),
    phone,
    whatsapp: phone,
    packageSlug: z.string().max(120).nullish(),
    branchSlug: z.string().max(80).nullish(),
    travelDate: z.iso.date("Use a date like 2026-12-20.").nullish(),
    currency: z.string().trim().toUpperCase().regex(/^[A-Z]{3}$/).nullish(),
    message: z.string().trim().max(2000).nullish(),
    /** Honeypot: hidden from people, filled in by bots. */
    website: z.string().max(200).optional(),
  })
  .refine((data) => data.email || data.phone || data.whatsapp, {
    path: ["phone"],
    message: "Add an email, phone or WhatsApp number so we can reply.",
  });

const enquiriesPerIp = rateLimiter({ limit: 5, windowMs: 10 * 60_000 });

export async function createEnquiry(input: z.infer<typeof enquiryInput>, ip: string) {
  enquiriesPerIp.hit(ip);
  // Bots that fill the hidden field get a normal-looking success and nothing is stored.
  if (input.website) return { id: null };
  if (input.travelDate && input.travelDate < new Date().toISOString().slice(0, 10)) {
    throw new AppError(400, "VALIDATION_ERROR", "The travel date is in the past", [{ path: "travelDate", message: "Choose a future date." }]);
  }

  let packageId: string | null = null;
  let branchId: string | null = null;
  let estimatedTotal: number | null = null;
  let currencyCode: string | null = null;
  if (input.packageSlug) {
    const graph = await getPublicPackage(input.packageSlug);
    if (!graph) throw notFound("Package");
    packageId = graph.id;
    branchId = graph.branchId;
    const codes = new Set((await activeCurrencies()).map((currency) => currency.code));
    if (input.currency && codes.has(input.currency)) {
      try {
        estimatedTotal = calculateTotal(priceTable(graph.prices, codes), input.currency, input).total;
        currencyCode = input.currency;
      } catch {
        // No price for that traveller mix: keep the enquiry, staff will quote.
      }
    }
  } else if (input.branchSlug) {
    const [branch] = await db.select({ id: branches.id }).from(branches).where(eq(branches.slug, input.branchSlug)).limit(1);
    branchId = branch?.id ?? null;
  }

  const [row] = await db
    .insert(enquiries)
    .values({
      name: input.name,
      email: input.email ?? null,
      phone: input.phone,
      whatsapp: input.whatsapp,
      packageId,
      branchId,
      travelDate: input.travelDate ?? null,
      adults: input.adults,
      children: input.children,
      infants: input.infants,
      currencyCode,
      estimatedTotal,
      message: input.message ?? null,
    })
    .returning({ id: enquiries.id });
  // No names or contact details in logs.
  log.info("enquiry.created", { enquiryId: row!.id, packageId, branchId });
  return { id: row!.id };
}

// ---------------------------------------------------------------------------------------------
// Admin

const listQuery = pageQuery.extend({
  q: z.string().trim().max(100).optional(),
  status: z.enum(STATUSES).optional(),
  branchId: z.uuid().optional(),
  packageId: z.uuid().optional(),
});

const enquiryColumns = {
  enquiry: enquiries,
  package: { id: packages.id, title: packages.title, slug: packages.slug },
  branch: { id: branches.id, name: branches.name },
};

export const enquiryAdminRoutes = new Hono<AppEnv>()
  .get("/", async (c) => {
    const query = readQuery(c, listQuery);
    const like = query.q ? `%${escapeLike(query.q)}%` : null;
    const where = and(
      query.status ? eq(enquiries.status, query.status) : undefined,
      query.branchId ? eq(enquiries.branchId, query.branchId) : undefined,
      query.packageId ? eq(enquiries.packageId, query.packageId) : undefined,
      like
        ? or(
            ilike(enquiries.name, like),
            ilike(enquiries.email, like),
            ilike(enquiries.phone, like),
            ilike(enquiries.whatsapp, like),
            ilike(packages.title, like),
          )
        : undefined,
    );
    const [rows, [{ total }]] = await Promise.all([
      db
        .select(enquiryColumns)
        .from(enquiries)
        .leftJoin(packages, eq(packages.id, enquiries.packageId))
        .leftJoin(branches, eq(branches.id, enquiries.branchId))
        .where(where)
        .orderBy(desc(enquiries.createdAt))
        .limit(query.pageSize)
        .offset((query.page - 1) * query.pageSize),
      db.select({ total: count() }).from(enquiries).leftJoin(packages, eq(packages.id, enquiries.packageId)).where(where),
    ]);
    const items = rows.map(({ enquiry, package: pkg, branch }) => ({ ...enquiry, package: pkg?.id ? pkg : null, branch: branch?.id ? branch : null }));
    return ok(c, items, pageMeta(query.page, query.pageSize, total));
  })
  .get("/:id", async (c) => {
    const id = idParam(c);
    const [row] = await db
      .select(enquiryColumns)
      .from(enquiries)
      .leftJoin(packages, eq(packages.id, enquiries.packageId))
      .leftJoin(branches, eq(branches.id, enquiries.branchId))
      .where(eq(enquiries.id, id))
      .limit(1);
    if (!row) throw notFound("Enquiry");
    const notes = await db
      .select({ id: enquiryNotes.id, body: enquiryNotes.body, createdAt: enquiryNotes.createdAt, author: adminUsers.name })
      .from(enquiryNotes)
      .leftJoin(adminUsers, eq(adminUsers.id, enquiryNotes.adminUserId))
      .where(eq(enquiryNotes.enquiryId, id))
      .orderBy(desc(enquiryNotes.createdAt));
    return ok(c, { ...row.enquiry, package: row.package?.id ? row.package : null, branch: row.branch?.id ? row.branch : null, notes });
  })
  .patch("/:id", async (c) => {
    const id = idParam(c);
    const { status } = await readBody(c, z.object({ status: z.enum(STATUSES) }));
    const [row] = await db.update(enquiries).set({ status }).where(eq(enquiries.id, id)).returning({ id: enquiries.id });
    if (!row) throw notFound("Enquiry");
    await audit(db, c.get("admin"), "ENQUIRY_STATUS_CHANGED", "enquiry", id, { status });
    return ok(c, { id, status });
  })
  .post("/:id/notes", async (c) => {
    const id = idParam(c);
    const { body } = await readBody(c, z.object({ body: z.string().trim().min(1, "Write a note.").max(4000) }));
    const [exists] = await db.select({ id: enquiries.id }).from(enquiries).where(eq(enquiries.id, id)).limit(1);
    if (!exists) throw notFound("Enquiry");
    const admin = c.get("admin");
    const [note] = await db.insert(enquiryNotes).values({ enquiryId: id, adminUserId: admin.id, body }).returning();
    await db.update(enquiries).set({ updatedAt: new Date() }).where(eq(enquiries.id, id));
    await audit(db, admin, "ENQUIRY_NOTE_ADDED", "enquiry", id);
    return ok(c, { ...note, author: admin.name }, undefined, 201);
  });
