import { Hono } from "hono";
import { cors } from "hono/cors";
import { secureHeaders } from "hono/secure-headers";
import { bodyLimit } from "hono/body-limit";
import { env } from "./config/env.ts";
import { pingDb } from "./db/client.ts";
import { AppError } from "./lib/errors.ts";
import type { AppEnv } from "./lib/http.ts";
import { log } from "./lib/logger.ts";
import { authRoutes } from "./modules/auth/routes.ts";
import { adminRoutes } from "./modules/admin-routes.ts";
import { publicRoutes } from "./modules/public-routes.ts";
import { mediaFileRoutes } from "./modules/media/files.ts";

/** Friendly field names for unique indexes, so forms can point at the right input. */
function uniqueField(field = "") {
  if (field === "slug") return { path: "slug", message: "This slug is already in use" };
  if (field === "email") return { path: "email", message: "This email is already in use" };
  // Currencies are keyed by their code.
  if (field === "_id") return { path: "code", message: "This currency already exists" };
  return { path: "", message: "This already exists" };
}

/** Database errors worth turning into client errors (references and IN_USE are checked by the services). */
function toAppError(error: unknown): AppError | null {
  if (error instanceof AppError) return error;
  const e = error as { name?: string; code?: unknown; keyPattern?: Record<string, unknown>; errors?: Record<string, { path: string; message: string }> };
  if (e?.code === 11000) {
    const field = uniqueField(Object.keys(e.keyPattern ?? {})[0]);
    return new AppError(409, "CONFLICT", field.message, [field]);
  }
  if (e?.name === "ValidationError") {
    return new AppError(400, "CONSTRAINT_VIOLATION", "A value is outside the allowed range", Object.values(e.errors ?? {}).map(({ path, message }) => ({ path, message })));
  }
  if (e?.name === "CastError") return new AppError(400, "INVALID_VALUE", "A value has the wrong format");
  return null;
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
      // Exact origins only. The website's apex and www addresses are both listed when it uses both (CORS_EXTRA_ORIGINS).
      origin: [env.FRONTEND_URL, env.ADMIN_URL, ...env.CORS_EXTRA_ORIGINS],
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
    await pingDb();
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
