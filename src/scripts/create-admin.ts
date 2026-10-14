/**
 * Creates an admin account.
 *   npm run admin:create -- --email ops@teamgetset.com --name "Ops Team" --role SUPER_ADMIN
 * The password comes from ADMIN_PASSWORD, or a strong one is generated and printed once.
 */
import { parseArgs } from "node:util";
import { randomBytes } from "node:crypto";
import { connectDb, disconnectDb } from "../db/client.ts";
import { AdminUser } from "../db/models.ts";
import { hashPassword } from "../lib/crypto.ts";
import { safeMessage } from "../lib/logger.ts";
import { passwordInput } from "../modules/admin-users.ts";

const { values } = parseArgs({
  options: { email: { type: "string" }, name: { type: "string" }, role: { type: "string", default: "SUPER_ADMIN" } },
});
const role = values.role as "SUPER_ADMIN" | "ADMIN" | "EDITOR";
if (!values.email || !values.name || !["SUPER_ADMIN", "ADMIN", "EDITOR"].includes(role)) {
  console.error('Usage: npm run admin:create -- --email you@example.com --name "Your Name" [--role SUPER_ADMIN|ADMIN|EDITOR]');
  process.exit(1);
}
const generated = !process.env.ADMIN_PASSWORD;
const password = process.env.ADMIN_PASSWORD ?? `${randomBytes(12).toString("base64url")}7a`;
const check = passwordInput.safeParse(password);
if (!check.success) {
  console.error(`ADMIN_PASSWORD: ${check.error.issues[0]?.message}`);
  process.exit(1);
}
try {
  await connectDb();
  await AdminUser.create({ email: values.email.toLowerCase(), name: values.name, role, passwordHash: await hashPassword(password) });
  console.log(`Created ${role} ${values.email}.`);
  if (generated) console.log(`Password (shown once, store it safely): ${password}`);
} catch (error) {
  const duplicate = (error as { code?: number }).code === 11000;
  console.error("Could not create the admin:", duplicate ? "an account with this email already exists" : safeMessage(error));
  process.exitCode = 1;
} finally {
  await disconnectDb();
}
