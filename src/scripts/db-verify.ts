/**
 * `npm run db:verify`: confirms the live database matches src/db/models.ts (collections and indexes) and that no
 * reference points at a missing document. Read-only. Exits 1 on any difference.
 */
import { env } from "../config/env.ts";
import { connectDb, disconnectDb } from "../db/client.ts";
import { danglingReferences, indexStatus } from "../db/indexes.ts";
import { safeMessage } from "../lib/logger.ts";

try {
  await connectDb();
  const status = await indexStatus();
  const dangling = await danglingReferences();
  const defined = status.reduce((total, s) => total + s.defined, 0);
  const problems = [
    ...status.filter((s) => !s.exists).map((s) => `collection ${s.collection} does not exist (run npm run db:indexes)`),
    ...status.flatMap((s) => (s.exists ? s.missing.map((index) => `${s.collection}: missing index ${index}`) : [])),
    ...dangling.map((d) => `${d.from}.${d.path}: ${d.missing.length} value(s) point at missing ${d.to} (${d.missing.slice(0, 3).join(", ")}${d.missing.length > 3 ? ", ..." : ""})`),
  ];
  console.log(`Database "${env.MONGODB_DB_NAME}"`);
  console.log(`  Created:  ${status.length} collections and ${defined} index definitions in src/db/models.ts`);
  console.log(`  Applied:  ${status.filter((s) => s.exists && !s.missing.length).length} of ${status.length} collections exist with all their indexes`);
  const unmanaged = status.filter((s) => s.unmanaged.length);
  if (unmanaged.length) console.log(`  Unmanaged indexes (left untouched, review separately): ${unmanaged.map((s) => `${s.collection}: ${s.unmanaged.join(", ")}`).join("; ")}`);
  if (!problems.length) {
    console.log("  Verified: the database matches src/db/models.ts and every reference resolves.");
  } else {
    console.log(`  NOT verified. ${problems.length} problem(s):`);
    for (const problem of problems) console.log(`    - ${problem}`);
    process.exitCode = 1;
  }
} catch (error) {
  console.error("Verification failed:", safeMessage(error));
  process.exitCode = 1;
} finally {
  await disconnectDb();
}
