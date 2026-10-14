import { createHash, timingSafeEqual } from "node:crypto";
import { isIP } from "node:net";
import type { Context } from "hono";
import { getConnInfo } from "@hono/node-server/conninfo";
import { z } from "zod";
import { env } from "../config/env.ts";
import { AppError, badRequest, validationError } from "./errors.ts";
import { log } from "./logger.ts";

export type AdminRole = "SUPER_ADMIN" | "ADMIN" | "EDITOR";

export interface AdminContext {
  id: string;
  name: string;
  email: string;
  role: AdminRole;
  sessionId: string;
}

export type AppEnv = { Variables: { requestId: string; admin: AdminContext } };
export type AppContext = Context<AppEnv>;

/** Every success response: { success: true, data, meta? }. */
export function ok<T>(c: Context, data: T, meta?: Record<string, unknown>, status: 200 | 201 = 200) {
  return c.json({ success: true as const, data, ...(meta && { meta }) }, status);
}

export function parse<T extends z.ZodType>(schema: T, value: unknown): z.infer<T> {
  const result = schema.safeParse(value);
  if (!result.success) throw validationError(result.error);
  return result.data;
}

export async function readBody<T extends z.ZodType>(c: Context, schema: T): Promise<z.infer<T>> {
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    throw badRequest("INVALID_JSON", "The request body must be valid JSON");
  }
  return parse(schema, raw);
}

export const readQuery = <T extends z.ZodType>(c: Context, schema: T): z.infer<T> => parse(schema, c.req.query());

export function idParam(c: Context, name = "id"): string {
  const value = c.req.param(name);
  if (!z.uuid().safeParse(value).success) throw new AppError(404, "NOT_FOUND", "Not found");
  return value!;
}

export const pageQuery = z.object({
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});

export const pageMeta = (page: number, pageSize: number, total: number) => ({
  page,
  pageSize,
  total,
  totalPages: Math.max(1, Math.ceil(total / pageSize)),
});

/** "true"/"false" query flags. */
export const queryFlag = z.enum(["true", "false"]).transform((value) => value === "true");

/** How the admin's server passes on the visitor's address (Vercel gives it the real one); see ADMIN_PROXY_SECRET. */
export const FORWARDED_IP_HEADER = "x-getset-client-ip";
export const PROXY_SECRET_HEADER = "x-getset-proxy-secret";

const digest = (value: string) => createHash("sha256").update(value).digest();

/** The visitor's address as passed on by the admin's server, or null unless the request proves it with the secret. */
function forwardedByAdmin(c: Context): string | null {
  const given = c.req.header(PROXY_SECRET_HEADER);
  if (given === undefined) return null;
  // Comparing hashes keeps the comparison constant-time whatever the lengths. The secret is never logged.
  if (!env.ADMIN_PROXY_SECRET || !timingSafeEqual(digest(given), digest(env.ADMIN_PROXY_SECRET))) {
    log.warn("http.forwarded_ip_rejected", { reason: env.ADMIN_PROXY_SECRET ? "wrong_secret" : "secret_not_configured" });
    return null;
  }
  const ip = c.req.header(FORWARDED_IP_HEADER)?.trim();
  if (ip && isIP(ip)) return ip;
  log.warn("http.forwarded_ip_rejected", { reason: "invalid_address" });
  return null;
}

/**
 * Client address, for rate limits, in order of trust:
 * 1. the visitor's address passed on by the admin's server, only with a valid ADMIN_PROXY_SECRET;
 * 2. on Render (TRUST_PROXY=cloudflare), CF-Connecting-IP, which Render's Cloudflare edge overwrites on every request;
 * 3. the connection's address.
 * Invalid values fall through to the next. X-Forwarded-For is never read: the edge appends to it, so callers control
 * its first entry.
 */
export function clientIp(c: Context): string {
  const forwarded = forwardedByAdmin(c);
  if (forwarded) return forwarded;
  if (env.TRUST_PROXY === "cloudflare") {
    const ip = c.req.header("cf-connecting-ip")?.trim();
    if (ip && isIP(ip)) return ip;
  }
  try {
    return getConnInfo(c).remote.address ?? "unknown";
  } catch {
    return "unknown";
  }
}
