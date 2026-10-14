/** `npm run pg:verify`: confirms the live database matches src/legacy-postgres/schema.ts. Exits 1 on any difference. */
import { db, pool } from "./client.ts";
import { migrationStatus } from "./migrations.ts";
import { verifySchema } from "./verify.ts";

try {
  const migrations = await migrationStatus(db);
  const pending = migrations.filter((m) => !m.applied);
  console.log(`Migrations: ${migrations.length} created, ${migrations.length - pending.length} applied.`);
  if (pending.length) console.log(`  Not applied: ${pending.map((m) => m.tag).join(", ")}`);

  const report = await verifySchema(db);
  console.log("\nChecked in the live database:");
  for (const [what, count] of Object.entries(report.checked)) console.log(`  ${what.padEnd(18)} ${count}`);

  if (report.unmanaged.length) {
    console.log(`\nTables not defined by this schema (left untouched, review separately): ${report.unmanaged.join(", ")}`);
  }
  if (report.ok && !pending.length) {
    console.log("\nVerified: the database matches src/legacy-postgres/schema.ts.");
  } else {
    console.log(`\nNOT verified. ${report.problems.length} problem(s):`);
    for (const problem of report.problems) console.log(`  - ${problem}`);
    process.exitCode = 1;
  }
} catch (error) {
  console.error("Verification failed:", error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally {
  await pool.end();
}
