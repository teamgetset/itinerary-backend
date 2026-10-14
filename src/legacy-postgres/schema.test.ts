import assert from "node:assert/strict";
import { test } from "node:test";
import { db } from "./client.ts";
import { migrationStatus } from "./migrations.ts";
import { verifySchema } from "./verify.ts";

test("every migration is applied and the live schema matches src/db/schema.ts", async () => {
  const migrations = await migrationStatus(db);
  assert.ok(migrations.length > 0);
  assert.ok(migrations.every((m) => m.applied));
  const report = await verifySchema(db);
  assert.deepEqual(report.problems, []);
  assert.deepEqual(report.unmanaged, []);
  assert.equal(report.checked.tables, 27);
});
