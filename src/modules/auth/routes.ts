import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "../../db/client.ts";
import { adminUsers } from "../../db/schema.ts";
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
    await audit(db, admin, "ADMIN_LOGOUT", "admin_user", admin.id);
    return ok(c, { signedOut: true });
  })
  .get("/me", requireAdmin, async (c) => {
    const user = await db.query.adminUsers.findFirst({ where: eq(adminUsers.id, c.get("admin").id) });
    return ok(c, publicAdminUser(user!));
  });
