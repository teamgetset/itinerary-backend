import { Hono } from "hono";
import { and, count, eq, ilike, inArray, isNull, or, type SQL } from "drizzle-orm";
import type { PgColumn, PgTable } from "drizzle-orm/pg-core";
import { z } from "zod";
import { db, type Tx } from "../db/client.ts";
import { notFound } from "../lib/errors.ts";
import { idParam, ok, pageMeta, pageQuery, readBody, readQuery, type AdminRole, type AppEnv } from "../lib/http.ts";
import { escapeLike } from "../lib/text.ts";
import { requireRole } from "./auth/middleware.ts";
import { audit } from "./audit.ts";
import { revalidate, type CacheTag } from "./revalidate.ts";

/* eslint-disable @typescript-eslint/no-explicit-any */
type Row = Record<string, any>;

export interface CrudConfig<Create extends z.ZodType, Update extends z.ZodType> {
  /** Audit entity and error label, e.g. "hotel" / "Hotel". */
  entity: string;
  label: string;
  table: PgTable & { id: PgColumn };
  create: Create;
  update: Update;
  /** Columns matched (case-insensitive, contains) by ?q=. */
  search?: PgColumn[];
  orderBy: (SQL | PgColumn)[];
  /** Extra list filters from the query string. */
  filters?: (query: Record<string, string>) => (SQL | undefined)[];
  /** Turns a page of rows into API objects (loads images, child rows...). */
  toDto: (rows: Row[]) => Promise<unknown[]>;
  /** Soft delete column. Without it, DELETE removes the row (and fails with IN_USE if still referenced). */
  deletedAt?: PgColumn;
  /** Adjusts input before it is written (slugs, normalisation). Child rows are written in afterSave. */
  prepare?: (data: Row, existing: Row | null) => Row | Promise<Row>;
  afterSave?: (tx: Tx, id: string, data: Row) => Promise<void>;
  /** Fields handled by afterSave, kept out of the main insert/update. */
  childFields?: string[];
  tags: CacheTag[];
  roles?: { write?: AdminRole; delete?: AdminRole };
  /** Adds PUT /order to save a drag-and-drop order. Needs a displayOrder column. */
  orderable?: PgColumn;
}

const omit = (data: Row, keys: string[] = []) => Object.fromEntries(Object.entries(data).filter(([key]) => !keys.includes(key)));

export function crudRoutes<Create extends z.ZodType, Update extends z.ZodType>(config: CrudConfig<Create, Update>) {
  const { table, entity, label } = config;
  const t = table as any;
  const write = requireRole(config.roles?.write ?? "EDITOR");
  const remove = requireRole(config.roles?.delete ?? "ADMIN");
  const listQuery = pageQuery.extend({ q: z.string().trim().max(100).optional() }).loose();
  const ACTION = entity.toUpperCase();

  async function findRow(id: string): Promise<Row> {
    const where = config.deletedAt ? and(eq(table.id, id), isNull(config.deletedAt)) : eq(table.id, id);
    const [row] = await db.select().from(t).where(where).limit(1);
    if (!row) throw notFound(label);
    return row;
  }

  const one = async (row: Row) => (await config.toDto([row]))[0];

  const router = new Hono<AppEnv>()
    .get("/", async (c) => {
      const query = readQuery(c, listQuery);
      const conditions: (SQL | undefined)[] = [
        config.deletedAt ? isNull(config.deletedAt) : undefined,
        query.q && config.search?.length ? or(...config.search.map((column) => ilike(column, `%${escapeLike(query.q!)}%`))) : undefined,
        ...(config.filters?.(c.req.query()) ?? []),
      ];
      const where = and(...conditions.filter(Boolean));
      // Generic over tables, so Drizzle's row types are not available here.
      const select: any = db.select().from(t);
      const rows: Row[] = await select
        .where(where)
        .orderBy(...(config.orderBy as any[]))
        .limit(query.pageSize)
        .offset((query.page - 1) * query.pageSize);
      const counter: any = db.select({ total: count() }).from(t);
      const [{ total }] = await counter.where(where);
      return ok(c, await config.toDto(rows), pageMeta(query.page, query.pageSize, total));
    })
    .get("/:id", async (c) => ok(c, await one(await findRow(idParam(c)))))
    .post("/", write, async (c) => {
      const input = (await readBody(c, config.create)) as Row;
      const data = config.prepare ? await config.prepare(input, null) : input;
      const admin = c.get("admin");
      const row = await db.transaction(async (tx) => {
        const [created]: Row[] = await (tx.insert(t).values(omit(data, config.childFields)) as any).returning();
        await config.afterSave?.(tx, created.id, data);
        await audit(tx, admin, `${ACTION}_CREATED`, entity, created.id);
        return created as Row;
      });
      revalidate(...config.tags);
      return ok(c, await one(row), undefined, 201);
    })
    .patch("/:id", write, async (c) => {
      const id = idParam(c);
      const existing = await findRow(id);
      const input = (await readBody(c, config.update)) as Row;
      const data = config.prepare ? await config.prepare(input, existing) : input;
      const admin = c.get("admin");
      const row = await db.transaction(async (tx) => {
        const fields = omit(data, config.childFields);
        const [updated] = Object.keys(fields).length
          ? await tx.update(t).set(fields).where(eq(table.id, id)).returning()
          : [existing];
        await config.afterSave?.(tx, id, data);
        // Publishing is its own audit event (TESTIMONIAL_PUBLISHED), other edits are *_UPDATED.
        const change = typeof input.isPublished === "boolean" ? (input.isPublished ? "PUBLISHED" : "UNPUBLISHED") : "UPDATED";
        await audit(tx, admin, `${ACTION}_${change}`, entity, id, { fields: Object.keys(input) });
        return updated as Row;
      });
      revalidate(...config.tags);
      return ok(c, await one(row));
    })
    .delete("/:id", remove, async (c) => {
      const id = idParam(c);
      await findRow(id);
      const admin = c.get("admin");
      await db.transaction(async (tx) => {
        if (config.deletedAt) await tx.update(t).set({ [propertyOf(table, config.deletedAt)]: new Date() }).where(eq(table.id, id));
        else await tx.delete(t).where(eq(table.id, id));
        await audit(tx, admin, `${ACTION}_DELETED`, entity, id);
      });
      revalidate(...config.tags);
      return ok(c, { id, deleted: true });
    });

  if (config.orderable) {
    const orderColumn = config.orderable;
    router.put("/order", write, async (c) => {
      const { ids } = await readBody(c, z.object({ ids: z.array(z.uuid()).min(1).max(500) }));
      const admin = c.get("admin");
      await db.transaction(async (tx) => {
        const found = await tx.select({ id: table.id }).from(t).where(inArray(table.id, ids));
        if (found.length !== new Set(ids).size) throw notFound(label);
        for (const [index, id] of ids.entries()) {
          await tx.update(t).set({ [propertyOf(table, orderColumn)]: index }).where(eq(table.id, id));
        }
        await audit(tx, admin, `${ACTION}_REORDERED`, entity, null, { ids });
      });
      revalidate(...config.tags);
      return ok(c, { ids });
    });
  }

  return router;
}

/** The property name Drizzle uses for a column object. */
function propertyOf(table: PgTable, column: PgColumn) {
  const key = Object.entries(table).find(([, value]) => value === column)?.[0];
  if (!key) throw new Error(`Column ${column.name} is not on this table`);
  return key;
}

/*
 * Zod helpers shared by admin schemas. Input schemas carry no defaults: in PATCH requests a missing field
 * must stay missing (unchanged), and on create the database defaults apply.
 */

/** Optional text; an empty string clears it (null), a missing field leaves it unchanged. */
export const nullableText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .nullish()
    .transform((value) => (value === "" ? null : value));

export const optionalId = z.uuid().nullish();

/** Links an admin can set: a site path (/packages), an anchor (#branches) or a full http(s) URL. Never javascript: etc. */
export const safeHref = z
  .string()
  .trim()
  .max(500)
  .refine((value) => /^(\/(?!\/)|#|https?:\/\/)/.test(value), "Use a site path like /packages, or a full https:// link");
