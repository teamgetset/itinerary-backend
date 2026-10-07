import type { MiddlewareHandler } from "hono";
import { forbidden, unauthorized } from "../../lib/errors.ts";
import type { AdminRole, AppEnv } from "../../lib/http.ts";
import { authenticate } from "./service.ts";

const RANK: Record<AdminRole, number> = { EDITOR: 1, ADMIN: 2, SUPER_ADMIN: 3 };

/** Every /api/admin route runs behind this: a valid, unexpired session of an active admin. */
export const requireAdmin: MiddlewareHandler<AppEnv> = async (c, next) => {
  const header = c.req.header("authorization");
  const token = header?.startsWith("Bearer ") ? header.slice(7).trim() : "";
  const admin = token ? await authenticate(token) : null;
  if (!admin) throw unauthorized(token ? "Your session has ended. Sign in again." : undefined);
  c.set("admin", admin);
  await next();
};

/** Allows `role` and anything above it (EDITOR < ADMIN < SUPER_ADMIN). Use after requireAdmin. */
export const requireRole =
  (role: AdminRole): MiddlewareHandler<AppEnv> =>
  async (c, next) => {
    if (RANK[c.get("admin").role] < RANK[role]) throw forbidden(`This needs the ${role.replace("_", " ").toLowerCase()} role`);
    await next();
  };

export const hasRole = (current: AdminRole, needed: AdminRole) => RANK[current] >= RANK[needed];
