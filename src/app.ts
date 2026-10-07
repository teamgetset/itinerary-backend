import { Hono } from "hono";
import { cors } from "hono/cors";
import { secureHeaders } from "hono/secure-headers";
import { bodyLimit } from "hono/body-limit";
import { sql } from "drizzle-orm";
import { env } from "./config/env.ts";
import { db } from "./db/client.ts";
import { AppError } from "./lib/errors.ts";
import type { AppEnv } from "./lib/http.ts";
import { log } from "./lib/logger.ts";
import { authRoutes } from "./modules/auth/routes.ts";
import { adminRoutes } from "./modules/admin-routes.ts";
import { publicRoutes } from "./modules/public-routes.ts";
import { mediaFileRoutes } from "./modules/media/files.ts";

/** PostgreSQL error codes worth turning into client errors. */
const PG = {
  uniqueViolation: "23505",
  foreignKeyViolation: "23503",
  /** Deleting a row that an ON DELETE RESTRICT key still points at. */
  restrictViolation: "23001",
  checkViolation: "23514",
  invalidText: "22P02",
};

const IN_USE = () => new AppError(409, "IN_USE", "This is still used elsewhere. Remove those links first, or switch it off instead.");

/** Friendly field names for unique constraints, so forms can point at the right input. */
function uniqueField(constraint = "") {
  if (constraint.includes("slug")) return { path: "slug", message: "This slug is already in use" };
  if (constraint.includes("email")) return { path: "email", message: "This email is already in use" };
  if (constraint.startsWith("currencies_pkey")) return { path: "code", message: "This currency already exists" };
  return { path: "", message: "This already exists" };
}

function toAppError(error: unknown): AppError | null {
  if (error instanceof AppError) return error;
  // Drizzle wraps driver errors (twice inside transactions): find the PostgreSQL error in the cause chain.
  let pg = error as { code?: unknown; constraint?: string; detail?: string; cause?: unknown } | undefined;
  for (let depth = 0; pg && !(typeof pg.code === "string" && /^[0-9A-Z]{5}$/.test(pg.code)) && depth < 4; depth++) {
    pg = pg.cause as typeof pg;
  }
  switch (pg?.code) {
    case PG.uniqueViolation: {
      const field = uniqueField(pg.constraint);
      return new AppError(409, "CONFLICT", field.message, [field]);
    }
    case PG.restrictViolation:
      return IN_USE();
    case PG.foreignKeyViolation:
      return pg.detail?.includes("referenced from")
        ? IN_USE()
        : new AppError(400, "INVALID_REFERENCE", "A linked record does not exist");
    case PG.checkViolation:
      return new AppError(400, "CONSTRAINT_VIOLATION", "A value is outside the allowed range", [{ path: "", message: pg.constraint }]);
    case PG.invalidText:
      return new AppError(400, "INVALID_VALUE", "A value has the wrong format");
    default:
      return null;
  }
}

export function createApp() {
  const app = new Hono<AppEnv>();

  app.use("*", async (c, next) => {
    const requestId = c.req.header("x-request-id")?.slice(0, 64) || crypto.randomUUID();
    c.set("requestId", requestId);
    c.header("x-request-id", requestId);
    const started = performance.now();
    await next();
    const fields = { requestId, method: c.req.method, path: c.req.path, status: c.res.status, ms: Math.round(performance.now() - started) };
    if (c.res.status >= 500) log.error("http.request", fields);
    else if (c.req.method !== "GET" || c.res.status >= 400) log.info("http.request", fields);
    else log.debug("http.request", fields);
  });

  app.use("*", secureHeaders({ crossOriginResourcePolicy: "cross-origin" }));
  app.use(
    "/api/*",
    cors({
      origin: [env.FRONTEND_URL, env.ADMIN_URL],
      allowMethods: ["GET", "POST", "PUT", "PATCH", "DELETE"],
      allowHeaders: ["Content-Type", "Authorization", "X-Request-Id"],
      maxAge: 600,
    }),
  );
  // JSON bodies are small. Uploads (multipart) get their own, larger limit on the upload route.
  app.use("/api/*", async (c, next) => {
    if (c.req.header("content-type")?.startsWith("multipart/form-data")) return next();
    return bodyLimit({
      maxSize: 1024 * 1024,
      onError: () => {
        throw new AppError(413, "PAYLOAD_TOO_LARGE", "The request is too large");
      },
    })(c, next);
  });

  app.get("/health", async (c) => {
    await db.execute(sql`select 1`);
    return c.json({ success: true, data: { status: "ok" } });
  });

  app.route("/api/auth", authRoutes);
  app.route("/api/public", publicRoutes);
  app.route("/api/admin", adminRoutes);
  app.route("/media", mediaFileRoutes);

  app.notFound((c) => c.json({ success: false, error: { code: "NOT_FOUND", message: "Not found" } }, 404));

  app.onError((error, c) => {
    const known = toAppError(error);
    if (known) {
      return c.json(
        { success: false, error: { code: known.code, message: known.message, ...(known.details !== undefined && { details: known.details }) } },
        known.status,
      );
    }
    log.error("http.unhandled_error", { requestId: c.get("requestId"), path: c.req.path, error });
    return c.json(
      { success: false, error: { code: "INTERNAL_ERROR", message: "Something went wrong. Please try again." } },
      500,
    );
  });

  return app;
}
