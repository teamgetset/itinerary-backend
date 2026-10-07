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

const schema = z
  .object({
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
    PORT: z.coerce.number().int().positive().default(4000),
    LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),

    DATABASE_URL: z.string().regex(/^postgres(ql)?:\/\//, "must be a postgres:// connection string"),

    /** Public base URL of this API. Media and PDF links are built from it. */
    API_URL: z.url(),
    FRONTEND_URL: z.url(),
    ADMIN_URL: z.url(),

    /** Signs draft preview links. Long random string, server only. */
    AUTH_SECRET: z.string().min(32, "must be at least 32 characters"),
    /** Admin sessions expire this many hours after sign-in. */
    SESSION_TTL_HOURS: z.coerce.number().positive().max(24 * 30).default(12),
    /** Shared with the customer frontend so the API can ask it to refresh cached pages. */
    REVALIDATE_SECRET: optional(z.string().min(24)),
    /** Set when running behind a reverse proxy, so client IPs are read from X-Forwarded-For. */
    TRUST_PROXY: z.stringbool().default(false),

    STORAGE_PROVIDER: z.enum(["local"]).default("local"),
    STORAGE_LOCAL_DIR: z.string().default("./storage"),

    /** Chrome or Chromium used to print PDFs. Either a channel ("chrome") or an executable path. */
    PDF_BROWSER_CHANNEL: z.string().default("chrome"),
    PDF_BROWSER_PATH: optional(z.string()),

    DEFAULT_CURRENCY: z.string().length(3).toUpperCase().default("INR"),
    SUPPORTED_CURRENCIES: list.default(["INR", "AED"]),
    /** Fallback WhatsApp number (international format, digits only) when a branch has none. */
    WHATSAPP_NUMBER: optional(z.string().regex(/^\d{8,15}$/)),
  })
  .refine((env) => env.SUPPORTED_CURRENCIES.includes(env.DEFAULT_CURRENCY), {
    message: "DEFAULT_CURRENCY must be one of SUPPORTED_CURRENCIES",
    path: ["DEFAULT_CURRENCY"],
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
  return env;
}

export const env = load();
export const isProduction = env.NODE_ENV === "production";
