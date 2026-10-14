import assert from "node:assert/strict";
import { test } from "node:test";
import { AdminSession, AdminUser } from "../../db/models.ts";
import { api, signIn } from "../../test/helpers.ts";
import { setCredentials } from "../admin-users.ts";

test("valid login returns a session token and the user, without the password hash", async () => {
  const { email, password } = await signIn("ADMIN");
  const result = await api("POST", "/api/auth/login", { body: { email: email.toUpperCase(), password } });
  assert.equal(result.status, 200);
  assert.ok(result.body.data.token.length >= 40);
  assert.equal(result.body.data.user.email, email);
  assert.equal(JSON.stringify(result.body).includes("scrypt"), false);
  const me = await api("GET", "/api/auth/me", { token: result.body.data.token });
  assert.equal(me.body.data.role, "ADMIN");
});

test("passwords are stored hashed and session tokens are stored only as hashes", async () => {
  const { user, password, token } = await signIn();
  assert.match(user.passwordHash, /^scrypt\$/);
  assert.equal(user.passwordHash.includes(password), false);
  const sessions = await AdminSession.find({ adminUserId: user.id }).lean();
  assert.equal(sessions.some((s) => s.tokenHash === token), false);
});

test("a wrong password and an unknown email give the same answer", async () => {
  const { email } = await signIn();
  const wrong = await api("POST", "/api/auth/login", { body: { email, password: "not-the-password-1" } });
  const unknown = await api("POST", "/api/auth/login", { body: { email: "nobody@test.local", password: "whatever-1234" } });
  assert.equal(wrong.status, 401);
  assert.deepEqual(wrong.body.error, unknown.body.error);
  assert.equal(wrong.body.error.code, "INVALID_CREDENTIALS");
});

test("an inactive admin cannot sign in, and their open sessions stop working", async () => {
  const { user, email, password, token } = await signIn("EDITOR");
  await AdminUser.updateOne({ _id: user.id }, { $set: { isActive: false } });
  const login = await api("POST", "/api/auth/login", { body: { email, password } });
  assert.equal(login.status, 403);
  assert.equal(login.body.error.code, "ACCOUNT_DISABLED");
  assert.equal((await api("GET", "/api/admin/dashboard", { token })).status, 401);
});

test("admin APIs reject missing, unknown and expired tokens", async () => {
  assert.equal((await api("GET", "/api/admin/packages")).status, 401);
  assert.equal((await api("POST", "/api/admin/packages", { body: {} })).status, 401);
  assert.equal((await api("GET", "/api/admin/packages", { token: "made-up-token" })).status, 401);
  const { user, token } = await signIn();
  await AdminSession.updateMany({ adminUserId: user.id }, { $set: { expiresAt: new Date(Date.now() - 1000) } });
  const expired = await api("GET", "/api/admin/dashboard", { token });
  assert.equal(expired.status, 401);
  assert.match(expired.body.error.message, /ended/);
});

test("logout ends the session", async () => {
  const { token } = await signIn();
  assert.equal((await api("POST", "/api/auth/logout", { token })).status, 200);
  assert.equal((await api("GET", "/api/auth/me", { token })).status, 401);
});

test("roles: editors edit content, admins publish, only super admins manage accounts", async () => {
  const editor = await signIn("EDITOR");
  const admin = await signIn("ADMIN");
  const superAdmin = await signIn("SUPER_ADMIN");
  assert.equal((await api("GET", "/api/admin/admin-users", { token: editor.token })).status, 403);
  assert.equal((await api("GET", "/api/admin/admin-users", { token: admin.token })).status, 403);
  assert.equal((await api("GET", "/api/admin/admin-users", { token: superAdmin.token })).status, 200);
  assert.equal((await api("POST", `/api/admin/packages/${crypto.randomUUID()}/publish`, { token: editor.token })).status, 403);
  assert.equal((await api("POST", "/api/admin/branches", { token: editor.token, body: {} })).status, 403);
  assert.equal((await api("GET", "/api/admin/audit-logs", { token: editor.token })).status, 403);
  assert.equal((await api("GET", "/api/admin/audit-logs", { token: admin.token })).status, 200);
});

test("super admins cannot lock the system out", async () => {
  const onlySuper = await AdminUser.findOne({ role: "SUPER_ADMIN" }).lean();
  await AdminUser.updateMany({ role: "SUPER_ADMIN" }, { $set: { isActive: false } });
  await AdminUser.updateOne({ _id: onlySuper!._id }, { $set: { isActive: true } });
  const me = await signIn("SUPER_ADMIN");
  await AdminUser.updateOne({ _id: onlySuper!._id }, { $set: { isActive: false } });
  const self = await api("PATCH", `/api/admin/admin-users/${me.user.id}`, { token: me.token, body: { isActive: false } });
  assert.equal(self.status, 409);
  assert.equal(self.body.error.code, "LAST_SUPER_ADMIN");
  const demote = await api("PATCH", `/api/admin/admin-users/${me.user.id}`, { token: me.token, body: { role: "EDITOR" } });
  assert.equal(demote.body.error.code, "LAST_SUPER_ADMIN");
});

test("creating an admin validates the password and hides the hash", async () => {
  const { token } = await signIn();
  const weak = await api("POST", "/api/admin/admin-users", { token, body: { name: "Ops", email: "ops@test.local", role: "EDITOR", password: "short" } });
  assert.equal(weak.status, 400);
  assert.equal(weak.body.error.details[0].path, "password");
  const created = await api("POST", "/api/admin/admin-users", {
    token,
    body: { name: "Ops", email: "Ops@Test.local", role: "EDITOR", password: "a-long-password-123" },
  });
  assert.equal(created.status, 201);
  assert.equal(created.body.data.email, "ops@test.local");
  assert.equal("passwordHash" in created.body.data, false);
  const duplicate = await api("POST", "/api/admin/admin-users", {
    token,
    body: { name: "Ops", email: "OPS@test.local", role: "EDITOR", password: "a-long-password-123" },
  });
  assert.equal(duplicate.status, 409);
  assert.equal(duplicate.body.error.details[0].path, "email");
});

test("changing an admin's email and password keeps the account, retires the old sign-in and ends sessions", async () => {
  const { user, email, password, token } = await signIn("SUPER_ADMIN");
  const updated = await setCredentials(email.toUpperCase(), "New.Owner@Test.local", "another-password-77");
  assert.equal(updated.id, user.id);
  assert.equal(updated.role, "SUPER_ADMIN");
  assert.equal(updated.email, "new.owner@test.local");
  assert.match(updated.passwordHash, /^scrypt\$/);
  assert.equal((await api("GET", "/api/auth/me", { token })).status, 401);
  assert.equal((await api("POST", "/api/auth/login", { body: { email, password } })).status, 401);
  const login = await api("POST", "/api/auth/login", { body: { email: "new.owner@test.local", password: "another-password-77" } });
  assert.equal(login.status, 200);
  assert.equal(login.body.data.user.id, user.id);
});

test("repeated wrong passwords for one account are rate limited", async () => {
  const { email } = await signIn();
  for (let i = 0; i < 5; i++) await api("POST", "/api/auth/login", { body: { email, password: `wrong-password-${i}` } });
  const blocked = await api("POST", "/api/auth/login", { body: { email, password: "wrong-password-x" } });
  assert.equal(blocked.status, 429);
  assert.equal(blocked.body.error.code, "TOO_MANY_REQUESTS");
});
