/**
 * Changes an existing admin's sign-in email and password. Same account: id, role, status and history are kept.
 *   ADMIN_PASSWORD=... npm run admin:credentials -- --current-email old@example.com --email new@example.com
 * The password must meet the admin password rules; --allow-weak-password accepts a weaker one outside production.
 */
import { parseArgs } from "node:util";
import { z } from "zod";
import { isProduction } from "../config/env.ts";
import { connectDb, disconnectDb } from "../db/client.ts";
import { safeMessage } from "../lib/logger.ts";
import { passwordInput, setCredentials } from "../modules/admin-users.ts";

const { values } = parseArgs({
  options: {
    "current-email": { type: "string" },
    email: { type: "string" },
    "allow-weak-password": { type: "boolean", default: false },
  },
});
const currentEmail = values["current-email"];
const email = z.email().max(254).safeParse(values.email);
const password = process.env.ADMIN_PASSWORD ?? "";
if (!currentEmail || !email.success || !password) {
  console.error("Usage: ADMIN_PASSWORD=... npm run admin:credentials -- --current-email old@example.com --email new@example.com");
  process.exit(1);
}

const check = passwordInput.safeParse(password);
if (!check.success) {
  const problem = check.error.issues[0]?.message;
  if (!values["allow-weak-password"] || isProduction) {
    console.error(`ADMIN_PASSWORD: ${problem}${isProduction ? "" : " (--allow-weak-password accepts it outside production)"}`);
    process.exit(1);
  }
  console.warn(`Warning: the password does not meet the admin password rules (${problem}). Change it before any shared or production use.`);
}

try {
  await connectDb();
  const user = await setCredentials(currentEmail, email.data, password);
  console.log(`Updated ${user.role} ${user.email} (same account, id ${user.id}). Its open sessions were signed out.`);
} catch (error) {
  const duplicate = (error as { code?: number }).code === 11000;
  console.error("Could not update the admin:", duplicate ? "another account already uses that email" : safeMessage(error));
  process.exitCode = 1;
} finally {
  await disconnectDb();
}
