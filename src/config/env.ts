import { existsSync } from "node:fs";
import { z } from "zod";

/*
 * All configuration comes from environment variables, validated once at start-up.
 * A local .env file is loaded when present (development); production sets real variables.
 */
// Tests get their whole environment from the test runner and must never see a developer's .env (its database).
if (process.env.NODE_ENV !== "test" && existsSync(".env")) process.loadEnvFile(".env");

/** Unset and empty are the same: an empty optional variable means "not configured". */
const optional = <T extends z.ZodType>(schema: T) => z.preprocess((value) => (value === "" ? undefined : value), schema.optional());

const list = z
  .string()
  .transform((value) => value.split(",").map((item) => item.trim().toUpperCase()).filter(Boolean));

/**
 * A site's origin exactly as browsers send it in the Origin header (scheme, host, port; no path). A trailing slash is
 * dropped, because CORS compares the strings exactly and "https://www.example.com/" would never match.
 */
export const originUrl = z
  .url()
  .refine((value) => {
    // Zod still runs this after the URL check fails, so a non-URL must not reach `new URL`.
    if (!URL.canParse(value)) return false;
    const url = new URL(value);
    return url.pathname === "/" && !url.search && !url.hash && !url.username && !url.password;
  }, "must be just an origin, like https://www.example.com (no path)")
  .transform((value) => new URL(value).origin);

const schema = z
  .object({
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
    PORT: z.coerce.number().int().positive().default(4000),
    LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),

    /** MongoDB connection string (Atlas: mongodb+srv://...). Secret: never logged. */
    MONGODB_URI: z.string().regex(/^mongodb(\+srv)?:\/\//, "must be a mongodb:// or mongodb+srv:// connection string"),
    MONGODB_DB_NAME: z.string().regex(/^[A-Za-z0-9_-]{1,38}$/, "letters, numbers, - and _ only"),

    /** Public base URL of this API. Media and PDF links are built from it. */
    API_URL: z.url(),
    /** The website's canonical origin (the one visitors end up on): CORS, preview links and cache refreshes. */
    FRONTEND_URL: originUrl,
    ADMIN_URL: originUrl,
    /**
     * More browser origins allowed to call the API (CORS), comma-separated: e.g. https://getsy.me when FRONTEND_URL is
     * https://www.getsy.me. Exact origins only; never a wildcard.
     */
    CORS_EXTRA_ORIGINS: z.preprocess(
      (value) => (typeof value === "string" ? value.split(",").map((item) => item.trim()).filter(Boolean) : []),
      z.array(originUrl),
    ),

    /** Signs draft preview links. Long random string, server only. */
    AUTH_SECRET: z.string().min(32, "must be at least 32 characters"),
    /** Admin sessions expire this many hours after sign-in. */
    SESSION_TTL_HOURS: z.coerce.number().positive().max(24 * 30).default(12),
    /** Shared with the customer frontend so the API can ask it to refresh cached pages. */
    REVALIDATE_SECRET: optional(z.string().min(24)),
    /**
     * Shared with the admin's server (the same value in its Vercel project): only requests carrying it may name the
     * visitor's address for rate limits. Secret, server only, never logged. Unset: such requests are ignored.
     */
    ADMIN_PROXY_SECRET: optional(
      z.string().min(32, "must be at least 32 characters").refine((value) => value === value.trim(), "must not start or end with spaces"),
    ),
    /**
     * Where the client's address (for rate limits) comes from. "cloudflare" on Render: its Cloudflare edge overwrites
     * CF-Connecting-IP on every request. "false" elsewhere: the connection's address. X-Forwarded-For is never used:
     * the edge appends to it, so its first entry is whatever the caller sent.
     */
    TRUST_PROXY: z
      .enum(["false", "cloudflare"], { error: 'use "cloudflare" on Render, "false" elsewhere (X-Forwarded-For is never trusted)' })
      .default("false"),

    /** Where new uploads go. "cloudinary" needs the CLOUDINARY_* variables; "local" writes to STORAGE_LOCAL_DIR. */
    STORAGE_PROVIDER: z.enum(["local", "cloudinary"]).default("local"),
    STORAGE_LOCAL_DIR: z.string().default("./storage"),
    CLOUDINARY_CLOUD_NAME: optional(z.string()),
    /** Secret, like CLOUDINARY_API_SECRET: server only, never logged. */
    CLOUDINARY_API_KEY: optional(z.string()),
    CLOUDINARY_API_SECRET: optional(z.string()),
    /** Folder for this database's assets, e.g. getset/staging. Part of every asset's permanent URL. */
    CLOUDINARY_FOLDER: optional(z.string().regex(/^[A-Za-z0-9_-]+(\/[A-Za-z0-9_-]+)*$/, "folder names like getset/staging")),

    DEFAULT_CURRENCY: z.string().length(3).toUpperCase().default("INR"),
    SUPPORTED_CURRENCIES: list.default(["INR", "AED"]),
    /** Fallback WhatsApp number (international format, digits only) when a branch has none. */
    WHATSAPP_NUMBER: optional(z.string().regex(/^\d{8,15}$/)),

    /**
     * Google reviews on the website, read with the Google Business Profile API (see README, "Google reviews"): an OAuth
     * client, the profile owner's refresh token (secret, server only, never logged) and the profiles to show, as
     * accounts/<id>/locations/<id>, comma-separated. All four or none; none means no Google reviews.
     */
    GOOGLE_OAUTH_CLIENT_ID: optional(z.string().trim().min(1)),
    GOOGLE_OAUTH_CLIENT_SECRET: optional(z.string().trim().min(1)),
    GOOGLE_OAUTH_REFRESH_TOKEN: optional(z.string().trim().min(1)),
    GOOGLE_BUSINESS_LOCATIONS: z.preprocess(
      (value) => (typeof value === "string" ? value.split(",").map((item) => item.trim()).filter(Boolean) : []),
      z.array(z.string().regex(/^accounts\/\d+\/locations\/\d+$/, "accounts/<id>/locations/<id>, as npm run google:business -- locations prints")),
    ),
  })
  .refine((env) => env.SUPPORTED_CURRENCIES.includes(env.DEFAULT_CURRENCY), {
    message: "DEFAULT_CURRENCY must be one of SUPPORTED_CURRENCIES",
    path: ["DEFAULT_CURRENCY"],
  })
  .superRefine((env, ctx) => {
    const google = ["GOOGLE_OAUTH_CLIENT_ID", "GOOGLE_OAUTH_CLIENT_SECRET", "GOOGLE_OAUTH_REFRESH_TOKEN"] as const;
    if (google.some((name) => env[name]) || env.GOOGLE_BUSINESS_LOCATIONS.length) {
      for (const name of google) if (!env[name]) ctx.addIssue({ code: "custom", path: [name], message: "required with the other GOOGLE_* variables" });
      if (!env.GOOGLE_BUSINESS_LOCATIONS.length) ctx.addIssue({ code: "custom", path: ["GOOGLE_BUSINESS_LOCATIONS"], message: "required with the other GOOGLE_* variables" });
    }
  })
  .superRefine((env, ctx) => {
    if (env.STORAGE_PROVIDER !== "cloudinary") return;
    for (const name of ["CLOUDINARY_CLOUD_NAME", "CLOUDINARY_API_KEY", "CLOUDINARY_API_SECRET", "CLOUDINARY_FOLDER"] as const) {
      if (!env[name]) ctx.addIssue({ code: "custom", path: [name], message: "required when STORAGE_PROVIDER=cloudinary" });
    }
  });

function load() {
  const parsed = schema.safeParse(process.env);
  if (!parsed.success) {
    const problems = parsed.error.issues.map((issue) => `  ${issue.path.join(".")}: ${issue.message}`).join("\n");
    console.error(`Invalid environment configuration:\n${problems}\nSee .env.example.`);
    process.exit(1);
  }
  const env = parsed.data;
  if (env.NODE_ENV === "production" && /change-me/i.test(env.AUTH_SECRET)) {
    console.error("AUTH_SECRET still has the example value. Generate one with: openssl rand -base64 48");
    process.exit(1);
  }
  if (env.NODE_ENV === "production" && !env.ADMIN_PROXY_SECRET) {
    console.warn("ADMIN_PROXY_SECRET is not set: admin sign-ins share one rate limit (the admin server's address).");
  }
  return env;
}

export const env = load();
export const isProduction = env.NODE_ENV === "production";
