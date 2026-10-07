import { is, sql } from "drizzle-orm";
import { PgTable, getTableConfig, isPgEnum } from "drizzle-orm/pg-core";
import type { Db } from "./client.ts";
import * as schema from "./schema.ts";

/**
 * Compares the live database with src/db/schema.ts: tables, columns (type and nullability), enums,
 * primary keys, unique constraints, foreign keys, check constraints and indexes.
 * Objects in the database that the schema does not define are reported separately, never changed.
 */

export interface VerifyReport {
  ok: boolean;
  checked: Record<string, number>;
  problems: string[];
  /** Tables in the public schema that src/db/schema.ts does not define. */
  unmanaged: string[];
}

/** Drizzle and PostgreSQL spell some types differently. */
function normalizeType(type: string) {
  return type
    .toLowerCase()
    .replace(/,\s+/g, ",")
    .replace(/^char\(/, "character(")
    .replace(/^varchar\(/, "character varying(")
    .replace(/^time$/, "time without time zone")
    .replace(/^timestamp$/, "timestamp without time zone");
}

export async function verifySchema(db: Db): Promise<VerifyReport> {
  const exported: unknown[] = Object.values(schema);
  const tables = exported.filter((value): value is PgTable => is(value, PgTable));
  const enums = exported.filter(isPgEnum);

  const [columnRows, enumRows, constraintRows, indexRows, tableRows] = await Promise.all([
    db.execute<{ table: string; column: string; type: string; not_null: boolean }>(sql`
      select c.relname as table, a.attname as column, format_type(a.atttypid, a.atttypmod) as type, a.attnotnull as not_null
      from pg_attribute a
      join pg_class c on c.oid = a.attrelid
      join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relkind = 'r' and a.attnum > 0 and not a.attisdropped`),
    db.execute<{ name: string; labels: string[] }>(sql`
      select t.typname as name, array_agg(e.enumlabel order by e.enumsortorder)::text[] as labels
      from pg_type t join pg_enum e on e.enumtypid = t.oid
      join pg_namespace n on n.oid = t.typnamespace
      where n.nspname = 'public' group by t.typname`),
    db.execute<{ name: string; type: string }>(sql`
      select con.conname as name, con.contype as type
      from pg_constraint con join pg_namespace n on n.oid = con.connamespace
      where n.nspname = 'public'`),
    db.execute<{ name: string }>(sql`select indexname as name from pg_indexes where schemaname = 'public'`),
    db.execute<{ name: string }>(sql`select table_name as name from information_schema.tables
      where table_schema = 'public' and table_type = 'BASE TABLE'`),
  ]);

  const columns = new Map(columnRows.rows.map((row) => [`${row.table}.${row.column}`, row]));
  const liveEnums = new Map(enumRows.rows.map((row) => [row.name, row.labels]));
  const constraints = new Map(constraintRows.rows.map((row) => [row.name, row.type]));
  const indexes = new Set(indexRows.rows.map((row) => row.name));
  const liveTables = new Set(tableRows.rows.map((row) => row.name));

  const problems: string[] = [];
  const checked: Record<string, number> = {
    tables: 0,
    columns: 0,
    enums: 0,
    primaryKeys: 0,
    uniqueConstraints: 0,
    foreignKeys: 0,
    checks: 0,
    indexes: 0,
  };
  const expectConstraint = (name: string, type: "p" | "u" | "f" | "c", what: string, counter: string) => {
    checked[counter]++;
    if (constraints.get(name) !== type) problems.push(`missing ${what}: ${name}`);
  };

  for (const pgEnum of enums) {
    checked.enums++;
    const live = liveEnums.get(pgEnum.enumName);
    if (!live) problems.push(`missing enum: ${pgEnum.enumName}`);
    else if (live.join(",") !== pgEnum.enumValues.join(",")) {
      problems.push(`enum ${pgEnum.enumName} has values (${live.join(", ")}), expected (${pgEnum.enumValues.join(", ")})`);
    }
  }

  for (const table of tables) {
    const config = getTableConfig(table);
    checked.tables++;
    if (!liveTables.has(config.name)) {
      problems.push(`missing table: ${config.name}`);
      continue;
    }
    for (const column of config.columns) {
      checked.columns++;
      const live = columns.get(`${config.name}.${column.name}`);
      if (!live) {
        problems.push(`missing column: ${config.name}.${column.name}`);
        continue;
      }
      const expected = normalizeType(column.getSQLType());
      if (normalizeType(live.type) !== expected) {
        problems.push(`column ${config.name}.${column.name} is ${live.type}, expected ${expected}`);
      }
      if (live.not_null !== column.notNull) {
        problems.push(`column ${config.name}.${column.name} is ${live.not_null ? "NOT NULL" : "nullable"}, expected the opposite`);
      }
      if (column.primary) expectConstraint(`${config.name}_pkey`, "p", "primary key", "primaryKeys");
      if (column.isUnique) {
        expectConstraint(column.uniqueName ?? `${config.name}_${column.name}_unique`, "u", "unique constraint", "uniqueConstraints");
      }
    }
    for (const pk of config.primaryKeys) expectConstraint(pk.getName(), "p", "primary key", "primaryKeys");
    for (const uc of config.uniqueConstraints) expectConstraint(uc.getName()!, "u", "unique constraint", "uniqueConstraints");
    for (const fk of config.foreignKeys) expectConstraint(fk.getName(), "f", "foreign key", "foreignKeys");
    for (const ck of config.checks) expectConstraint(ck.name, "c", "check constraint", "checks");
    for (const index of config.indexes) {
      checked.indexes++;
      if (!indexes.has(index.config.name!)) problems.push(`missing index: ${index.config.name}`);
    }
  }

  const managed = new Set(tables.map((table) => getTableConfig(table).name));
  const unmanaged = [...liveTables].filter((name) => !managed.has(name)).sort();

  return { ok: problems.length === 0, checked, problems, unmanaged };
}
