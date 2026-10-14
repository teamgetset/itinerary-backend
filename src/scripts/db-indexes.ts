/**
 * `npm run db:indexes`: creates the collections and indexes the models define, when missing. Never drops anything;
 * indexes the models no longer define are listed for review. Then reports each collection's state.
 */
import { env } from "../config/env.ts";
import { connectDb, disconnectDb } from "../db/client.ts";
import { ensureIndexes, indexStatus } from "../db/indexes.ts";
import { safeMessage } from "../lib/logger.ts";

try {
  await connectDb();
  console.log(`Database "${env.MONGODB_DB_NAME}": creating missing collections and indexes...`);
  await ensureIndexes();
  const status = await indexStatus();
  console.log("\nCollection            Indexes  Missing  Unmanaged");
  for (const s of status) console.log(`${s.collection.padEnd(22)}${String(s.defined).padEnd(9)}${String(s.missing.length).padEnd(9)}${s.unmanaged.join(", ") || "-"}`);
  const missing = status.reduce((total, s) => total + s.missing.length, 0);
  console.log(missing ? `\n${missing} index(es) could not be created.` : "\nAll indexes applied. Run `npm run db:verify` to check the database.");
  process.exitCode = missing ? 1 : 0;
} catch (error) {
  console.error("Index creation failed:", safeMessage(error));
  process.exitCode = 1;
} finally {
  await disconnectDb();
}
