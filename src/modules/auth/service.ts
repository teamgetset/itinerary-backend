import { env } from "../../config/env.ts";
import { transaction } from "../../db/client.ts";
import { AdminSession, AdminUser, type AdminUserDoc } from "../../db/models.ts";
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

export const publicAdminUser = (user: AdminUserDoc) => ({
  id: user._id,
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

  // Emails are stored lower-cased, so this is a case-insensitive match.
  const user = await AdminUser.findOne({ email: normalized }).lean<AdminUserDoc>();
  // Always run the hash, so a missing account takes as long as a wrong password.
  const valid = await verifyPassword(password, user?.passwordHash ?? DUMMY_PASSWORD_HASH);
  if (!user || !valid) {
    log.warn("auth.login_failed", { reason: user ? "wrong_password" : "unknown_email", ip: client.ip });
    throw new AppError(401, "INVALID_CREDENTIALS", "Email or password is incorrect");
  }
  if (!user.isActive) {
    log.warn("auth.login_blocked", { adminUserId: user._id });
    throw new AppError(403, "ACCOUNT_DISABLED", "This account has been deactivated. Ask a super admin to restore it.");
  }
  attemptsByEmail.reset(normalized);

  const token = randomToken();
  const expiresAt = new Date(Date.now() + env.SESSION_TTL_HOURS * 3_600_000);
  const lastLoginAt = new Date();
  await transaction(async () => {
    await AdminSession.deleteMany({ adminUserId: user._id, expiresAt: { $lt: new Date() } });
    await AdminSession.create({ adminUserId: user._id, tokenHash: sha256(token), expiresAt, userAgent: client.userAgent?.slice(0, 300) ?? null });
    await AdminUser.updateOne({ _id: user._id }, { $set: { lastLoginAt } });
    await audit({ id: user._id }, "ADMIN_LOGIN", "admin_user", user._id);
  });
  log.info("auth.login", { adminUserId: user._id });
  return { token, expiresAt, user: publicAdminUser({ ...user, lastLoginAt }) };
}

/** Resolves a bearer token to its admin, or null when the token is unknown, expired or the account is inactive. */
export async function authenticate(token: string): Promise<AdminContext | null> {
  const session = await AdminSession.findOne({ tokenHash: sha256(token) }).lean();
  if (!session || session.expiresAt <= new Date()) return null;
  const user = await AdminUser.findById(session.adminUserId).lean<AdminUserDoc>();
  if (!user?.isActive) return null;
  if (Date.now() - session.lastUsedAt.getTime() > TOUCH_AFTER_MS) {
    await AdminSession.updateOne({ _id: session._id }, { $set: { lastUsedAt: new Date() } });
  }
  return { id: user._id, name: user.name, email: user.email, role: user.role, sessionId: session._id };
}

export async function logout(sessionId: string) {
  await AdminSession.deleteOne({ _id: sessionId });
}

/** Signs out every session of a user, e.g. after a password change or deactivation. */
export async function revokeSessions(adminUserId: string, exceptSessionId?: string) {
  await AdminSession.deleteMany({ adminUserId, ...(exceptSessionId && { _id: { $ne: exceptSessionId } }) });
}
