import pg from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { env } from "../config/env.ts";
import { log } from "../lib/logger.ts";
import * as schema from "./schema.ts";

// Prices are numeric(12,2): well inside a double, so raw queries return numbers too.
pg.types.setTypeParser(pg.types.builtins.NUMERIC, (value) => Number(value));

export const pool = new pg.Pool({ connectionString: env.DATABASE_URL, max: 10 });
pool.on("error", (error) => log.error("db.pool_error", { error }));

export const db = drizzle(pool, { schema });

export type Db = typeof db;
/** A transaction handle; has the same query API as `db`. */
export type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
