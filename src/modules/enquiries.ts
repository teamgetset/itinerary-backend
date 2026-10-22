import { Hono } from "hono";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { AdminUser, Branch, ENQUIRY_STATUSES, Enquiry, Package, defined, withId, type EnquiryDoc } from "../db/models.ts";
import { AppError, notFound } from "../lib/errors.ts";
import { idParam, ok, pageMeta, pageQuery, readBody, readQuery, type AppEnv } from "../lib/http.ts";
import { log } from "../lib/logger.ts";
import { rateLimiter } from "../lib/rate-limit.ts";
import { contains } from "../lib/text.ts";
import { audit } from "./audit.ts";
import { branchCurrency } from "./currencies.ts";
import { getPublicPackage, priceTable } from "./packages/read.ts";
import { calculateTotal, travellersInput } from "./pricing.ts";

/* Leads from the website. Public visitors create them; staff track them through to a booking. */

const STATUSES = ENQUIRY_STATUSES;
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
    // Estimated in the package's currency (its branch's), whatever the page sent.
    const currency = branchCurrency(graph.branch);
    try {
      estimatedTotal = calculateTotal(priceTable(graph.prices, new Set([currency])), currency, input).total;
      currencyCode = currency;
    } catch {
      // No price for that traveller mix: keep the enquiry, staff will quote.
    }
  } else if (input.branchSlug) {
    const branch = await Branch.findOne({ slug: input.branchSlug }, { _id: 1 }).lean<{ _id: string }>();
    branchId = branch?._id ?? null;
  }

  const created = await Enquiry.create({
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
  });
  // No names or contact details in logs.
  log.info("enquiry.created", { enquiryId: created._id, packageId, branchId });
  return { id: created._id as string };
}

// ---------------------------------------------------------------------------------------------
// Admin

const listQuery = pageQuery.extend({
  q: z.string().trim().max(100).optional(),
  status: z.enum(STATUSES).optional(),
  branchId: z.uuid().optional(),
  packageId: z.uuid().optional(),
});

type EnquiryRow = Omit<EnquiryDoc, "_id" | "notes"> & { id: string };

/** An enquiry as the admin sees it: its fields plus the package and branch it came from. */
async function withLinks(docs: EnquiryDoc[]) {
  const ids = (field: "packageId" | "branchId") => [...new Set(docs.map((doc) => doc[field]).filter((id): id is string => !!id))];
  const [packages, branches] = await Promise.all([
    Package.find({ _id: { $in: ids("packageId") } }, { title: 1, slug: 1 }).lean<{ _id: string; title: string; slug: string }[]>(),
    Branch.find({ _id: { $in: ids("branchId") } }, { name: 1 }).lean<{ _id: string; name: string }[]>(),
  ]);
  return docs.map((doc) => {
    const { notes: _notes, ...enquiry }: EnquiryRow & { notes: unknown } = withId(doc);
    const pkg = packages.find((row) => row._id === doc.packageId);
    const branch = branches.find((row) => row._id === doc.branchId);
    return {
      ...enquiry,
      package: pkg ? { id: pkg._id, title: pkg.title, slug: pkg.slug } : null,
      branch: branch ? { id: branch._id, name: branch.name } : null,
    };
  });
}

export const enquiryAdminRoutes = new Hono<AppEnv>()
  .get("/", async (c) => {
    const query = readQuery(c, listQuery);
    const filter: Record<string, unknown> = defined({ status: query.status, branchId: query.branchId, packageId: query.packageId });
    if (query.q) {
      const packages = await Package.find({ title: contains(query.q) }, { _id: 1 }).lean<{ _id: string }[]>();
      filter.$or = [
        { name: contains(query.q) },
        { email: contains(query.q) },
        { phone: contains(query.q) },
        { whatsapp: contains(query.q) },
        { packageId: { $in: packages.map((row) => row._id) } },
      ];
    }
    const [docs, total] = await Promise.all([
      Enquiry.find(filter)
        .sort({ createdAt: -1 })
        .skip((query.page - 1) * query.pageSize)
        .limit(query.pageSize)
        .lean<EnquiryDoc[]>(),
      Enquiry.countDocuments(filter),
    ]);
    return ok(c, await withLinks(docs), pageMeta(query.page, query.pageSize, total));
  })
  .get("/:id", async (c) => {
    const doc = await Enquiry.findById(idParam(c)).lean<EnquiryDoc>();
    if (!doc) throw notFound("Enquiry");
    const [enquiry] = await withLinks([doc]);
    const authors = await AdminUser.find({ _id: { $in: doc.notes.map((note) => note.adminUserId).filter(Boolean) } }, { name: 1 }).lean<{ _id: string; name: string }[]>();
    const notes = [...doc.notes]
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .map((note) => ({ id: note._id, body: note.body, createdAt: note.createdAt, author: authors.find((a) => a._id === note.adminUserId)?.name ?? null }));
    return ok(c, { ...enquiry, notes });
  })
  .patch("/:id", async (c) => {
    const id = idParam(c);
    const { status } = await readBody(c, z.object({ status: z.enum(STATUSES) }));
    const updated = await Enquiry.updateOne({ _id: id }, { $set: { status } });
    if (!updated.matchedCount) throw notFound("Enquiry");
    await audit(c.get("admin"), "ENQUIRY_STATUS_CHANGED", "enquiry", id, { status });
    return ok(c, { id, status });
  })
  .post("/:id/notes", async (c) => {
    const id = idParam(c);
    const { body } = await readBody(c, z.object({ body: z.string().trim().min(1, "Write a note.").max(4000) }));
    const admin = c.get("admin");
    const note = { _id: randomUUID(), adminUserId: admin.id, body, createdAt: new Date() };
    // Adding a note also marks the enquiry as updated.
    const updated = await Enquiry.updateOne({ _id: id }, { $push: { notes: note } });
    if (!updated.matchedCount) throw notFound("Enquiry");
    await audit(admin, "ENQUIRY_NOTE_ADDED", "enquiry", id);
    return ok(c, { id: note._id, enquiryId: id, adminUserId: admin.id, body, createdAt: note.createdAt, author: admin.name }, undefined, 201);
  });
