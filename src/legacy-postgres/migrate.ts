/**
 * `npm run pg:migrate`          applies pending migrations, then lists every migration's state.
 * `npm run pg:migrate -- --status` (or `npm run pg:status`) only lists them.
 */
import { db, pool } from "./client.ts";
import { applyMigrations, migrationStatus } from "./migrations.ts";

const statusOnly = process.argv.includes("--status");

try {
  const before = await migrationStatus(db);
  if (!statusOnly) {
    const pending = before.filter((m) => !m.applied);
    if (pending.length) {
      console.log(`Applying ${pending.length} migration(s): ${pending.map((m) => m.tag).join(", ")}`);
      await applyMigrations(db);
    } else {
      console.log("No pending migrations.");
    }
  }
  const after = await migrationStatus(db);
  console.log("\nMigration                          Created  Applied");
  for (const m of after) console.log(`${m.tag.padEnd(34)} yes      ${m.applied ? "yes" : "NO"}`);
  const pending = after.filter((m) => !m.applied).length;
  console.log(pending ? `\n${pending} migration(s) not applied.` : "\nAll migrations applied. Run `npm run pg:verify` to check the schema.");
  process.exitCode = statusOnly && pending ? 1 : 0;
} catch (error) {
  console.error("Migration failed:", error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally {
  await pool.end();
}
