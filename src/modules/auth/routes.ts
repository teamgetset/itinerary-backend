import { Hono } from "hono";
import { z } from "zod";
import { AdminUser, type AdminUserDoc } from "../../db/models.ts";
import { audit } from "../audit.ts";
import { clientIp, ok, readBody, type AppEnv } from "../../lib/http.ts";
import { requireAdmin } from "./middleware.ts";
import { login, logout, publicAdminUser } from "./service.ts";

const credentials = z.object({
  email: z.email().max(254),
  password: z.string().min(1).max(200),
});

export const authRoutes = new Hono<AppEnv>()
  .post("/login", async (c) => {
    const { email, password } = await readBody(c, credentials);
    const session = await login(email, password, { ip: clientIp(c), userAgent: c.req.header("user-agent") });
    return ok(c, session);
  })
  .post("/logout", requireAdmin, async (c) => {
    const admin = c.get("admin");
    await logout(admin.sessionId);
    await audit(admin, "ADMIN_LOGOUT", "admin_user", admin.id);
    return ok(c, { signedOut: true });
  })
  .get("/me", requireAdmin, async (c) => {
    const user = await AdminUser.findById(c.get("admin").id).lean<AdminUserDoc>();
    return ok(c, publicAdminUser(user!));
  });
