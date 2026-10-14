import { existsSync } from "node:fs";
import pg from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import * as schema from "./schema.ts";

/*
 * LEGACY: the PostgreSQL connection of the pre-MongoDB backend. The application no longer uses it; it stays for the
 * `pg:*` scripts (start, inspect and verify the old database) until the migration is signed off. Reads DATABASE_URL
 * directly so the application's configuration does not have to require it.
 */
if (process.env.NODE_ENV !== "test" && existsSync(".env")) process.loadEnvFile(".env");
if (!/^postgres(ql)?:\/\//.test(process.env.DATABASE_URL ?? "")) {
  console.error("DATABASE_URL must be a postgres:// connection string (see .env.example).");
  process.exit(1);
}

// Prices are numeric(12,2): well inside a double, so raw queries return numbers too.
pg.types.setTypeParser(pg.types.builtins.NUMERIC, (value) => Number(value));

export const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 10 });
pool.on("error", (error) => console.error("db.pool_error", error.message));

export const db = drizzle(pool, { schema });

export type Db = typeof db;
/** A transaction handle; has the same query API as `db`. */
export type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
