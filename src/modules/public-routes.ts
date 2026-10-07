import { Hono } from "hono";
import { and, asc, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import { env } from "../config/env.ts";
import { db } from "../db/client.ts";
import { packageCategories, packages } from "../db/schema.ts";
import { verifyToken } from "../lib/crypto.ts";
import { AppError, notFound } from "../lib/errors.ts";
import { clientIp, ok, pageQuery, parse, queryFlag, readBody, readQuery, type AppEnv } from "../lib/http.ts";
import { SLUG_PATTERN } from "../lib/text.ts";
import { getPublicBranch, listPublicBranches } from "./branches.ts";
import { getContent } from "./content.ts";
import { activeCurrencies, currencyDto } from "./currencies.ts";
import { getPublicDestination, listPublicDestinations } from "./destinations.ts";
import { createEnquiry, enquiryInput } from "./enquiries.ts";
import { listPublicHeroSlides } from "./hero-slides.ts";
import { ensureCurrentPdf, pdfHeaders, readPdf } from "./pdf/service.ts";
import { getPublicPackage, listPublicPackages, loadPackageGraph, packageDetail, recommendations } from "./packages/read.ts";
import { quote, quoteInput } from "./pricing.ts";
import { search } from "./search.ts";
import { listPublicTestimonials } from "./testimonials.ts";

/*
 * Read-only data for the customer website, plus the two public writes (enquiries, price quotes).
 * Only published packages of active branches and destinations are ever returned here.
 */

const slug = z.string().max(120).regex(SLUG_PATTERN);
const slugList = z
  .string()
  .transform((value) => value.split(",").map((item) => item.trim()).filter(Boolean))
  .pipe(z.array(slug).max(48));

const packageQuery = pageQuery.extend({
  pageSize: z.coerce.number().int().min(1).max(48).default(12),
  branch: slug.optional(),
  destination: slug.optional(),
  category: slug.optional(),
  country: z.string().regex(/^[A-Za-z]{2}$/).optional(),
  minDays: z.coerce.number().int().min(1).max(90).optional(),
  maxDays: z.coerce.number().int().min(1).max(90).optional(),
  minPrice: z.coerce.number().min(0).optional(),
  maxPrice: z.coerce.number().min(0).optional(),
  currency: z.string().trim().toUpperCase().regex(/^[A-Z]{3}$/).optional(),
  featured: queryFlag.optional(),
  recommended: queryFlag.optional(),
  slugs: slugList.optional(),
  q: z.string().trim().max(100).optional(),
  sort: z.enum(["recommended", "price-asc", "price-desc", "duration-asc", "duration-desc", "newest"]).optional(),
});

const slugParam = (value: string | undefined) => {
  if (!value || !SLUG_PATTERN.test(value)) throw new AppError(404, "NOT_FOUND", "Not found");
  return value;
};

export const publicRoutes = new Hono<AppEnv>()
  // Browsers and CDNs may keep public reads briefly; the website itself caches by tag and is refreshed on publish.
  .use("*", async (c, next) => {
    await next();
    if (c.req.method === "GET" && c.res.status === 200 && !c.res.headers.has("Cache-Control")) {
      c.header("Cache-Control", "public, max-age=60, stale-while-revalidate=300");
    }
  })

  .get("/settings", async (c) => {
    const [currencies, content] = await Promise.all([activeCurrencies(), getContent()]);
    return ok(c, { defaultCurrency: env.DEFAULT_CURRENCY, currencies: currencies.map(currencyDto), content });
  })

  .get("/branches", async (c) => ok(c, await listPublicBranches()))
  .get("/branches/:slug", async (c) => ok(c, await getPublicBranch(slugParam(c.req.param("slug")))))
  .get("/branches/:slug/packages", async (c) => {
    const branch = slugParam(c.req.param("slug"));
    await getPublicBranch(branch);
    const { items, meta } = await listPublicPackages({ ...readQuery(c, packageQuery), branch });
    return ok(c, items, meta);
  })

  .get("/destinations", async (c) => ok(c, await listPublicDestinations()))
  .get("/destinations/:slug", async (c) => ok(c, await getPublicDestination(slugParam(c.req.param("slug")))))

  .get("/categories", async (c) => {
    const rows = await db.select().from(packageCategories).orderBy(asc(packageCategories.displayOrder), asc(packageCategories.name));
    return ok(c, rows.map(({ slug: categorySlug, name }) => ({ slug: categorySlug, name })));
  })

  .get("/packages", async (c) => {
    const { items, meta } = await listPublicPackages(readQuery(c, packageQuery));
    return ok(c, items, meta);
  })
  .get("/packages/:slug", async (c) => {
    const graph = await getPublicPackage(slugParam(c.req.param("slug")));
    if (!graph) throw notFound("Package");
    return ok(c, await packageDetail(graph));
  })
  .get("/packages/:slug/recommendations", async (c) => {
    const limit = parse(z.coerce.number().int().min(1).max(12).default(4), c.req.query("limit"));
    const items = await recommendations(slugParam(c.req.param("slug")), limit);
    if (!items) throw notFound("Package");
    return ok(c, items);
  })
  /** The itinerary PDF matching the package as published now (built on first request after a change). */
  .get("/packages/:slug/pdf", async (c) => {
    const branding = parse(z.enum(["with-logo", "without-logo"]).default("with-logo"), c.req.query("branding"));
    const graph = await getPublicPackage(slugParam(c.req.param("slug")));
    if (!graph) throw notFound("Package");
    const version = await ensureCurrentPdf(graph.id, null);
    const file = branding === "with-logo" ? version.withLogo : version.withoutLogo;
    return c.body(new Uint8Array(await readPdf(file)), 200, {
      ...pdfHeaders(file, "attachment"),
      "Cache-Control": "public, max-age=300",
      "X-Pdf-Version": String(version.version),
    });
  })

  /** Draft preview for admins, through a signed link from POST /api/admin/packages/:id/preview. Never cached or indexed. */
  .get("/preview/packages/:id", async (c) => {
    const id = c.req.param("id");
    const payload = verifyToken(c.req.query("token") ?? "", env.AUTH_SECRET);
    if (payload !== `package:${id}`) throw new AppError(403, "PREVIEW_EXPIRED", "This preview link is invalid or has expired");
    const graph = await loadPackageGraph(and(eq(packages.id, id), isNull(packages.deletedAt))!);
    if (!graph) throw notFound("Package");
    c.header("Cache-Control", "private, no-store");
    c.header("X-Robots-Tag", "noindex, nofollow");
    return ok(c, { ...(await packageDetail(graph)), status: graph.status });
  })

  .post("/pricing/quote", async (c) => ok(c, await quote(await readBody(c, quoteInput))))

  .get("/search", async (c) => {
    const query = readQuery(c, z.object({ q: z.string().trim().max(100).default(""), limit: z.coerce.number().int().min(1).max(24).default(8) }));
    return ok(c, await search(query.q, query.limit));
  })

  .get("/testimonials", async (c) => {
    const query = readQuery(c, pageQuery.extend({ pageSize: z.coerce.number().int().min(1).max(50).default(20) }));
    const { items, meta } = await listPublicTestimonials(query.page, query.pageSize);
    return ok(c, items, meta);
  })

  .get("/hero-slides", async (c) => ok(c, await listPublicHeroSlides()))

  .post("/enquiries", async (c) => {
    const result = await createEnquiry(await readBody(c, enquiryInput), clientIp(c));
    return ok(c, { received: true, id: result.id }, undefined, 201);
  });
