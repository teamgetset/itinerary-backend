import { Hono } from "hono";
import { and, asc, count, eq, ne } from "drizzle-orm";
import { z } from "zod";
import { db } from "../db/client.ts";
import { adminUsers } from "../db/schema.ts";
import { hashPassword } from "../lib/crypto.ts";
import { AppError, notFound } from "../lib/errors.ts";
import { idParam, ok, readBody, type AppEnv } from "../lib/http.ts";
import { audit } from "./audit.ts";
import { publicAdminUser, revokeSessions } from "./auth/service.ts";

/* Staff accounts. Only super admins manage them (enforced where these routes are mounted). */

export const passwordInput = z
  .string()
  .min(12, "Use at least 12 characters.")
  .max(200)
  .refine((value) => /[a-zA-Z]/.test(value) && /\d/.test(value), "Mix letters and numbers.");

const roles = z.enum(["SUPER_ADMIN", "ADMIN", "EDITOR"]);

const createInput = z.object({
  name: z.string().trim().min(1).max(80),
  email: z.email().max(254).transform((value) => value.toLowerCase()),
  role: roles,
  password: passwordInput,
});

const updateInput = z.object({
  name: z.string().trim().min(1).max(80).optional(),
  role: roles.optional(),
  isActive: z.boolean().optional(),
  password: passwordInput.optional(),
});

async function activeSuperAdmins(exceptId: string) {
  const [{ total }] = await db
    .select({ total: count() })
    .from(adminUsers)
    .where(and(eq(adminUsers.role, "SUPER_ADMIN"), eq(adminUsers.isActive, true), ne(adminUsers.id, exceptId)));
  return total;
}

export const adminUserRoutes = new Hono<AppEnv>()
  .get("/", async (c) => {
    const rows = await db.select().from(adminUsers).orderBy(asc(adminUsers.name));
    return ok(c, rows.map(publicAdminUser));
  })
  .get("/:id", async (c) => {
    const [row] = await db.select().from(adminUsers).where(eq(adminUsers.id, idParam(c))).limit(1);
    if (!row) throw notFound("Admin user");
    return ok(c, publicAdminUser(row));
  })
  .post("/", async (c) => {
    const input = await readBody(c, createInput);
    const [row] = await db
      .insert(adminUsers)
      .values({ name: input.name, email: input.email, role: input.role, passwordHash: await hashPassword(input.password) })
      .returning();
    await audit(db, c.get("admin"), "ADMIN_USER_CREATED", "admin_user", row!.id, { role: input.role });
    return ok(c, publicAdminUser(row!), undefined, 201);
  })
  .patch("/:id", async (c) => {
    const id = idParam(c);
    const input = await readBody(c, updateInput);
    const admin = c.get("admin");
    const [existing] = await db.select().from(adminUsers).where(eq(adminUsers.id, id)).limit(1);
    if (!existing) throw notFound("Admin user");

    // Never leave the system without an active super admin, and never lock yourself out.
    const losingSuperAdmin = existing.role === "SUPER_ADMIN" && existing.isActive && (input.isActive === false || (input.role && input.role !== "SUPER_ADMIN"));
    if (losingSuperAdmin && (await activeSuperAdmins(id)) === 0) {
      throw new AppError(409, "LAST_SUPER_ADMIN", "There must be at least one active super admin.");
    }
    if (id === admin.id && input.isActive === false) throw new AppError(409, "SELF_DEACTIVATION", "You cannot deactivate your own account.");

    const [row] = await db
      .update(adminUsers)
      .set({
        name: input.name,
        role: input.role,
        isActive: input.isActive,
        ...(input.password && { passwordHash: await hashPassword(input.password) }),
      })
      .where(eq(adminUsers.id, id))
      .returning();
    // A new password or a deactivated account ends the user's other sessions straight away.
    if (input.password || input.isActive === false) await revokeSessions(id, id === admin.id ? admin.sessionId : undefined);
    await audit(db, admin, "ADMIN_USER_UPDATED", "admin_user", id, {
      fields: Object.keys(input).filter((key) => key !== "password"),
      passwordChanged: !!input.password,
    });
    return ok(c, publicAdminUser(row!));
  });
