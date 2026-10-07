import { and, eq, lt, sql } from "drizzle-orm";
import { env } from "../../config/env.ts";
import { db } from "../../db/client.ts";
import { adminSessions, adminUsers } from "../../db/schema.ts";
import { DUMMY_PASSWORD_HASH, randomToken, sha256, verifyPassword } from "../../lib/crypto.ts";
import { AppError } from "../../lib/errors.ts";
import type { AdminContext } from "../../lib/http.ts";
import { log } from "../../lib/logger.ts";
import { rateLimiter } from "../../lib/rate-limit.ts";
import { audit } from "../audit.ts";

// Brute-force protection: per address, and per account so one email cannot be guessed at from many addresses.
const attemptsByIp = rateLimiter({ limit: 20, windowMs: 15 * 60_000 });
const attemptsByEmail = rateLimiter({ limit: 5, windowMs: 15 * 60_000 });

/** Sessions are touched at most this often, so reads do not write on every request. */
const TOUCH_AFTER_MS = 5 * 60_000;

export const publicAdminUser = (user: typeof adminUsers.$inferSelect) => ({
  id: user.id,
  name: user.name,
  email: user.email,
  role: user.role,
  isActive: user.isActive,
  lastLoginAt: user.lastLoginAt,
});

export async function login(email: string, password: string, client: { ip: string; userAgent?: string }) {
  const normalized = email.trim().toLowerCase();
  attemptsByIp.hit(client.ip);
  attemptsByEmail.hit(normalized);

  const user = await db.query.adminUsers.findFirst({ where: eq(sql`lower(${adminUsers.email})`, normalized) });
  // Always run the hash, so a missing account takes as long as a wrong password.
  const valid = await verifyPassword(password, user?.passwordHash ?? DUMMY_PASSWORD_HASH);
  if (!user || !valid) {
    log.warn("auth.login_failed", { reason: user ? "wrong_password" : "unknown_email", ip: client.ip });
    throw new AppError(401, "INVALID_CREDENTIALS", "Email or password is incorrect");
  }
  if (!user.isActive) {
    log.warn("auth.login_blocked", { adminUserId: user.id });
    throw new AppError(403, "ACCOUNT_DISABLED", "This account has been deactivated. Ask a super admin to restore it.");
  }
  attemptsByEmail.reset(normalized);

  const token = randomToken();
  const expiresAt = new Date(Date.now() + env.SESSION_TTL_HOURS * 3_600_000);
  await db.transaction(async (tx) => {
    await tx.delete(adminSessions).where(and(eq(adminSessions.adminUserId, user.id), lt(adminSessions.expiresAt, new Date())));
    await tx.insert(adminSessions).values({
      adminUserId: user.id,
      tokenHash: sha256(token),
      expiresAt,
      userAgent: client.userAgent?.slice(0, 300),
    });
    await tx.update(adminUsers).set({ lastLoginAt: new Date() }).where(eq(adminUsers.id, user.id));
    await audit(tx, user, "ADMIN_LOGIN", "admin_user", user.id);
  });
  log.info("auth.login", { adminUserId: user.id });
  return { token, expiresAt, user: publicAdminUser({ ...user, lastLoginAt: new Date() }) };
}

/** Resolves a bearer token to its admin, or null when the token is unknown, expired or the account is inactive. */
export async function authenticate(token: string): Promise<AdminContext | null> {
  const [row] = await db
    .select({
      sessionId: adminSessions.id,
      expiresAt: adminSessions.expiresAt,
      lastUsedAt: adminSessions.lastUsedAt,
      id: adminUsers.id,
      name: adminUsers.name,
      email: adminUsers.email,
      role: adminUsers.role,
      isActive: adminUsers.isActive,
    })
    .from(adminSessions)
    .innerJoin(adminUsers, eq(adminUsers.id, adminSessions.adminUserId))
    .where(eq(adminSessions.tokenHash, sha256(token)))
    .limit(1);

  if (!row || row.expiresAt <= new Date() || !row.isActive) return null;
  if (Date.now() - row.lastUsedAt.getTime() > TOUCH_AFTER_MS) {
    await db.update(adminSessions).set({ lastUsedAt: new Date() }).where(eq(adminSessions.id, row.sessionId));
  }
  return { id: row.id, name: row.name, email: row.email, role: row.role, sessionId: row.sessionId };
}

export async function logout(sessionId: string) {
  await db.delete(adminSessions).where(eq(adminSessions.id, sessionId));
}

/** Signs out every session of a user, e.g. after a password change or deactivation. */
export async function revokeSessions(adminUserId: string, exceptSessionId?: string) {
  const sessions = await db.select({ id: adminSessions.id }).from(adminSessions).where(eq(adminSessions.adminUserId, adminUserId));
  for (const session of sessions) if (session.id !== exceptSessionId) await logout(session.id);
}
