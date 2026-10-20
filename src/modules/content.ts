import { Hono } from "hono";
import { z } from "zod";
import { env } from "../config/env.ts";
import { SiteContent, type SiteContentDoc } from "../db/models.ts";
import { notFound } from "../lib/errors.ts";
import { ok, readBody, type AdminContext, type AppEnv } from "../lib/http.ts";
import { requireRole } from "./auth/middleware.ts";
import { audit } from "./audit.ts";
import { safeHref } from "./crud.ts";
import { revalidate } from "./revalidate.ts";

/*
 * Site-wide content blocks, one row per key, each validated by its own schema.
 * Missing rows fall back to the defaults below, so a fresh database still renders a complete site.
 * Adding a block = a schema + a default here, and a form in the admin's Global content page.
 */

const line = (max: number) => z.string().trim().max(max);
const link = z.object({ label: line(40).min(1), href: safeHref });

export const CONTENT_SCHEMAS = {
  "home.hero": z.object({
    eyebrow: line(60),
    heading: line(80).min(1),
    description: line(200),
    primaryCta: link,
    secondaryCta: link.nullable(),
  }),
  "home.branches": z.object({ heading: line(80).min(1), description: line(300) }),
  "home.packages": z.object({ heading: line(80).min(1), description: line(300) }),
  testimonials: z.object({ enabled: z.boolean(), heading: line(80).min(1), description: line(300) }),
  navigation: z.object({ header: z.array(link).max(8), footer: z.array(link).max(12) }),
  contact: z.object({
    email: z.email().max(254),
    /** Digits with country code, used for the site-wide WhatsApp button. */
    whatsapp: z.string().regex(/^\d{8,15}$/, "Digits only, with the country code"),
  }),
  social: z
    .array(
      z.object({
        network: z.enum(["instagram", "facebook", "linkedin", "youtube", "x", "tiktok"]),
        label: line(60).min(1),
        href: z.url().max(300),
      }),
    )
    .max(10),
  footer: z.object({ tagline: line(200), legalName: line(100).min(1) }),
  /** Shown on every package page and PDF, before the package's own notes. */
  "package.defaults": z.object({
    importantInfo: z.array(line(300).min(1)).max(20),
    terms: z.array(line(600).min(1)).max(40),
  }),
  /** Opening line of WhatsApp enquiries. {branch} and {package} are filled in. */
  enquiry: z.object({ whatsappTemplate: line(300).min(1) }),
} as const;

export type ContentKey = keyof typeof CONTENT_SCHEMAS;
export type Content = { [K in ContentKey]: z.infer<(typeof CONTENT_SCHEMAS)[K]> };

export const CONTENT_DEFAULTS: Content = {
  "home.hero": {
    eyebrow: "Holidays from Dubai & Calicut",
    heading: "Get set for somewhere new.",
    description: "Handpicked holidays, each with a day-by-day itinerary you can download.",
    primaryCta: { label: "Explore packages", href: "#branches" },
    secondaryCta: { label: "Chat on WhatsApp", href: "https://wa.me/971585689114" },
  },
  "home.branches": {
    heading: "Choose your branch",
    description: "Each office runs its own catalogue of trips. Start with the one you are booking from.",
  },
  "home.packages": {
    heading: "All tour packages",
    description: "Every trip from every branch. Switch between rupees and dirhams at the top of the page.",
  },
  testimonials: {
    enabled: true,
    heading: "Stories from our travellers",
    description: "Real Google reviews from people who planned holidays, visas and tickets with GETSET.",
  },
  navigation: {
    header: [{ label: "Home", href: "/" }],
    footer: [
      { label: "Home", href: "/" },
      { label: "Dubai", href: "/destinations/dubai" },
      { label: "UAE", href: "/destinations/uae" },
      { label: "All packages", href: "/packages" },
    ],
  },
  contact: { email: "info@teamgetset.com", whatsapp: "971585689114" },
  social: [
    { network: "instagram", label: "Instagram, Dubai office", href: "https://www.instagram.com/getset_travels_dubai/" },
    { network: "instagram", label: "Instagram, Calicut office", href: "https://www.instagram.com/getsettoursandtravels/" },
    { network: "linkedin", label: "LinkedIn", href: "https://www.linkedin.com/company/team-getset-tours-andtravels/" },
  ],
  footer: {
    tagline: "International holidays, visas and flights, planned by our teams in Dubai and Calicut.",
    legalName: "Team GETSET Tours & Travels",
  },
  "package.defaults": {
    importantInfo: [
      "Your passport should be valid for at least six months after your return date.",
      "Prices are per person on twin sharing, land only, and change with travel dates and availability.",
      "Hotel check-in is usually from 2 pm and check-out by 12 noon.",
      "Tour timings can shift with weather, traffic and local events. Your guide will keep you updated.",
    ],
    terms: [],
  },
  enquiry: { whatsappTemplate: "Hi GETSET {branch}, I'm interested in the {package} package." },
};

const isKey = (key: string): key is ContentKey => key in CONTENT_SCHEMAS;

export async function getContent(): Promise<Content> {
  const rows = await SiteContent.find().lean<SiteContentDoc[]>();
  const content = { ...CONTENT_DEFAULTS } as Record<string, unknown>;
  for (const row of rows) {
    // A stored value that no longer fits its schema (after a schema change) falls back to the default.
    if (isKey(row._id) && CONTENT_SCHEMAS[row._id].safeParse(row.value).success) content[row._id] = row.value;
  }
  return content as Content;
}

export async function getContentBlock<K extends ContentKey>(key: K): Promise<Content[K]> {
  const row = await SiteContent.findById(key).lean<SiteContentDoc>();
  const parsed = row ? CONTENT_SCHEMAS[key].safeParse(row.value) : null;
  return (parsed?.success ? parsed.data : CONTENT_DEFAULTS[key]) as Content[K];
}

// ---------------------------------------------------------------------------------------------
// Links to a page that is going away (a deleted destination)

const siteHost = (host: string) => host.replace(/^www\./, "");

/** Whether a content link opens `path` on this site: relative ("/destinations/georgia") or absolute to the site. */
function linksTo(href: string, path: string) {
  let url: URL;
  try {
    url = new URL(href, env.FRONTEND_URL);
  } catch {
    return false;
  }
  return siteHost(url.host) === siteHost(new URL(env.FRONTEND_URL).host) && url.pathname.replace(/\/+$/, "") === path;
}

/** The menu links and homepage buttons that open `path`, for the deletion warning. */
export async function contentLinksTo(path: string) {
  const { navigation, "home.hero": hero } = await getContent();
  return [
    ...navigation.header.filter((l) => linksTo(l.href, path)).map((l) => `Header menu: ${l.label}`),
    ...navigation.footer.filter((l) => linksTo(l.href, path)).map((l) => `Footer menu: ${l.label}`),
    ...[hero.primaryCta, hero.secondaryCta].filter((l) => l && linksTo(l.href, path)).map((l) => `Homepage button: ${l!.label}`),
  ];
}

/**
 * Takes links to `path` out of the site content, so nothing on the website leads to a removed page: menu links are
 * dropped, the second homepage button is removed and the first one (required) goes back to its default.
 * Runs inside the caller's transaction.
 */
export async function removeContentLinksTo(path: string, admin: AdminContext) {
  const { navigation, "home.hero": hero } = await getContent();
  const changes: [ContentKey, unknown][] = [];
  const header = navigation.header.filter((l) => !linksTo(l.href, path));
  const footer = navigation.footer.filter((l) => !linksTo(l.href, path));
  if (header.length !== navigation.header.length || footer.length !== navigation.footer.length) changes.push(["navigation", { header, footer }]);
  if (linksTo(hero.primaryCta.href, path) || (hero.secondaryCta && linksTo(hero.secondaryCta.href, path))) {
    changes.push([
      "home.hero",
      {
        ...hero,
        primaryCta: linksTo(hero.primaryCta.href, path) ? CONTENT_DEFAULTS["home.hero"].primaryCta : hero.primaryCta,
        secondaryCta: hero.secondaryCta && linksTo(hero.secondaryCta.href, path) ? null : hero.secondaryCta,
      },
    ]);
  }
  for (const [key, value] of changes) {
    await SiteContent.updateOne({ _id: key }, { $set: { value, updatedById: admin.id } }, { upsert: true });
    await audit(admin, "CONTENT_UPDATED", "site_content", key, { removedLinksTo: path });
  }
  if (changes.length) revalidate("content");
}

export const contentAdminRoutes = new Hono<AppEnv>()
  .get("/", async (c) => ok(c, await getContent()))
  .put("/:key", requireRole("EDITOR"), async (c) => {
    const key = c.req.param("key");
    if (!isKey(key)) throw notFound("Content block");
    const value = await readBody(c, CONTENT_SCHEMAS[key]);
    const admin = c.get("admin");
    await SiteContent.updateOne({ _id: key }, { $set: { value, updatedById: admin.id } }, { upsert: true });
    await audit(admin, "CONTENT_UPDATED", "site_content", key);
    revalidate("content");
    return ok(c, value);
  });
