import type { Context } from "hono";
import { getConnInfo } from "@hono/node-server/conninfo";
import { z } from "zod";
import { env } from "../config/env.ts";
import { AppError, badRequest, validationError } from "./errors.ts";

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

/** Client address, for rate limits. Proxy headers are only trusted when TRUST_PROXY is set. */
export function clientIp(c: Context): string {
  if (env.TRUST_PROXY) {
    const forwarded = c.req.header("x-forwarded-for")?.split(",")[0]?.trim();
    if (forwarded) return forwarded;
  }
  try {
    return getConnInfo(c).remote.address ?? "unknown";
  } catch {
    return "unknown";
  }
}
