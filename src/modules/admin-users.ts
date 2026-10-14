import { Hono } from "hono";
import { z } from "zod";
import { AdminUser, defined, withId, type AdminUserDoc } from "../db/models.ts";
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

/**
 * Changes an account's sign-in email and password, keeping its id, role and status (`npm run admin:credentials`).
 * Like a password change in the admin, it ends the account's open sessions.
 */
export async function setCredentials(currentEmail: string, email: string, password: string) {
  const existing = await AdminUser.findOne({ email: currentEmail.trim().toLowerCase() }, { _id: 1 }).lean();
  if (!existing) throw notFound("Admin user");
  const row = await AdminUser.findOneAndUpdate(
    { _id: existing._id },
    { $set: { email: email.trim().toLowerCase(), passwordHash: await hashPassword(password) } },
    { returnDocument: "after" },
  ).lean<AdminUserDoc>();
  await revokeSessions(existing._id);
  await audit(null, "ADMIN_USER_UPDATED", "admin_user", existing._id, { fields: ["email"], passwordChanged: true });
  return withId(row!);
}

const activeSuperAdmins = (exceptId: string) => AdminUser.countDocuments({ role: "SUPER_ADMIN", isActive: true, _id: { $ne: exceptId } });

export const adminUserRoutes = new Hono<AppEnv>()
  .get("/", async (c) => {
    const rows = await AdminUser.find().sort({ name: 1 }).lean<AdminUserDoc[]>();
    return ok(c, rows.map(publicAdminUser));
  })
  .get("/:id", async (c) => {
    const row = await AdminUser.findById(idParam(c)).lean<AdminUserDoc>();
    if (!row) throw notFound("Admin user");
    return ok(c, publicAdminUser(row));
  })
  .post("/", async (c) => {
    const input = await readBody(c, createInput);
    const created = await AdminUser.create({ name: input.name, email: input.email, role: input.role, passwordHash: await hashPassword(input.password) });
    const row = created.toObject() as AdminUserDoc;
    await audit(c.get("admin"), "ADMIN_USER_CREATED", "admin_user", row._id, { role: input.role });
    return ok(c, publicAdminUser(row), undefined, 201);
  })
  .patch("/:id", async (c) => {
    const id = idParam(c);
    const input = await readBody(c, updateInput);
    const admin = c.get("admin");
    const existing = await AdminUser.findById(id).lean<AdminUserDoc>();
    if (!existing) throw notFound("Admin user");

    // Never leave the system without an active super admin, and never lock yourself out.
    const losingSuperAdmin = existing.role === "SUPER_ADMIN" && existing.isActive && (input.isActive === false || (input.role && input.role !== "SUPER_ADMIN"));
    if (losingSuperAdmin && (await activeSuperAdmins(id)) === 0) {
      throw new AppError(409, "LAST_SUPER_ADMIN", "There must be at least one active super admin.");
    }
    if (id === admin.id && input.isActive === false) throw new AppError(409, "SELF_DEACTIVATION", "You cannot deactivate your own account.");

    const row = await AdminUser.findOneAndUpdate(
      { _id: id },
      {
        $set: defined({
          name: input.name,
          role: input.role,
          isActive: input.isActive,
          passwordHash: input.password ? await hashPassword(input.password) : undefined,
        }),
      },
      { returnDocument: "after" },
    ).lean<AdminUserDoc>();
    // A new password or a deactivated account ends the user's other sessions straight away.
    if (input.password || input.isActive === false) await revokeSessions(id, id === admin.id ? admin.sessionId : undefined);
    await audit(admin, "ADMIN_USER_UPDATED", "admin_user", id, {
      fields: Object.keys(input).filter((key) => key !== "password"),
      passwordChanged: !!input.password,
    });
    return ok(c, publicAdminUser(row!));
  });
