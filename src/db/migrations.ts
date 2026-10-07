import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { sql } from "drizzle-orm";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import type { Db } from "./client.ts";

/*
 * Migration states, kept apart on purpose:
 *   Created  - a SQL file exists in /drizzle (from `npm run db:generate`)
 *   Applied  - the database has recorded it in drizzle.__drizzle_migrations (from `npm run db:migrate`)
 *   Verified - the live schema matches src/db/schema.ts (from `npm run db:verify`)
 */

export const migrationsFolder = fileURLToPath(new URL("../../drizzle", import.meta.url));

interface Journal {
  entries: { idx: number; tag: string; when: number }[];
}

export interface MigrationStatus {
  tag: string;
  applied: boolean;
}

export async function migrationStatus(db: Db): Promise<MigrationStatus[]> {
  const journal: Journal = JSON.parse(readFileSync(`${migrationsFolder}/meta/_journal.json`, "utf8"));
  const exists = await db.execute<{ found: boolean }>(
    sql`select to_regclass('drizzle.__drizzle_migrations') is not null as found`,
  );
  const applied = new Set<string>();
  if (exists.rows[0]?.found) {
    const rows = await db.execute<{ hash: string }>(sql`select hash from drizzle.__drizzle_migrations`);
    for (const row of rows.rows) applied.add(row.hash);
  }
  return journal.entries.map(({ tag }) => {
    // The migrator records the SHA-256 of each SQL file.
    const hash = createHash("sha256").update(readFileSync(`${migrationsFolder}/${tag}.sql`, "utf8")).digest("hex");
    return { tag, applied: applied.has(hash) };
  });
}

export async function applyMigrations(db: Db) {
  await migrate(db, { migrationsFolder });
}
