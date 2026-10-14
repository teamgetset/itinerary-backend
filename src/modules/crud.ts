import { Hono } from "hono";
import type { Model } from "mongoose";
import { z } from "zod";
import { transaction } from "../db/client.ts";
import { defined, withId } from "../db/models.ts";
import { inUse, invalidReference, notFound } from "../lib/errors.ts";
import { idParam, ok, pageMeta, pageQuery, readBody, readQuery, type AdminRole, type AppEnv } from "../lib/http.ts";
import { contains } from "../lib/text.ts";
import { requireRole } from "./auth/middleware.ts";
import { audit } from "./audit.ts";
import { revalidate, type CacheTag } from "./revalidate.ts";

/* eslint-disable @typescript-eslint/no-explicit-any */
type Row = Record<string, any>;
type Filter = Record<string, unknown>;

export interface CrudConfig<Create extends z.ZodType, Update extends z.ZodType> {
  /** Audit entity and error label, e.g. "hotel" / "Hotel". */
  entity: string;
  label: string;
  model: Model<any>;
  create: Create;
  update: Update;
  /** Fields matched (case-insensitive, contains) by ?q=. */
  search?: string[];
  sort: Record<string, 1 | -1>;
  /** Extra list filters from the query string. */
  filters?: (query: Record<string, string>) => (Filter | undefined)[];
  /** Turns a page of rows into API objects (loads images, child rows...). */
  toDto: (rows: Row[]) => Promise<unknown[]>;
  /** Soft delete: DELETE sets deletedAt and hides the row. Without it, DELETE removes the document. */
  softDelete?: boolean;
  /** Adjusts input before it is written (slugs, normalisation). */
  prepare?: (data: Row, existing: Row | null) => Row | Promise<Row>;
  /** Runs inside the write's transaction (re-indexing packages after a rename...). */
  afterSave?: (id: string, data: Row) => Promise<void>;
  /** Fields holding another document's id. Each one sent must exist (what foreign keys checked): 400 INVALID_REFERENCE. */
  refs?: Record<string, Model<any>>;
  /** True while other documents point at this one: DELETE answers 409 IN_USE (what ON DELETE RESTRICT did). */
  inUse?: (id: string) => Promise<boolean>;
  /** Clears links to a deleted document (what ON DELETE SET NULL did). Runs inside the delete's transaction. */
  onDelete?: (id: string) => Promise<void>;
  tags: CacheTag[];
  roles?: { write?: AdminRole; delete?: AdminRole };
  /** Adds PUT /order to save a drag-and-drop order into displayOrder. */
  orderable?: boolean;
}

export function crudRoutes<Create extends z.ZodType, Update extends z.ZodType>(config: CrudConfig<Create, Update>) {
  const { model, entity, label } = config;
  const write = requireRole(config.roles?.write ?? "EDITOR");
  const remove = requireRole(config.roles?.delete ?? "ADMIN");
  const listQuery = pageQuery.extend({ q: z.string().trim().max(100).optional() }).loose();
  const ACTION = entity.toUpperCase();
  const live: Filter = config.softDelete ? { deletedAt: null } : {};

  async function findRow(id: string): Promise<Row> {
    const row = await model.findOne({ _id: id, ...live }).lean<Row>();
    if (!row) throw notFound(label);
    return withId(row as Row & { _id: string });
  }

  async function checkReferences(data: Row) {
    for (const [field, target] of Object.entries(config.refs ?? {})) {
      if (data[field] && !(await target.exists({ _id: data[field] }))) throw invalidReference(field);
    }
  }

  const one = async (row: Row) => (await config.toDto([row]))[0];

  const router = new Hono<AppEnv>()
    .get("/", async (c) => {
      const query = readQuery(c, listQuery);
      const filter = {
        $and: [
          live,
          query.q && config.search?.length ? { $or: config.search.map((field) => ({ [field]: contains(query.q!) })) } : {},
          ...(config.filters?.(c.req.query()) ?? []).filter((condition): condition is Filter => !!condition),
        ],
      };
      const [rows, total] = await Promise.all([
        model
          .find(filter)
          .sort(config.sort)
          .skip((query.page - 1) * query.pageSize)
          .limit(query.pageSize)
          .lean<(Row & { _id: string })[]>(),
        model.countDocuments(filter),
      ]);
      return ok(c, await config.toDto(rows.map(withId)), pageMeta(query.page, query.pageSize, total));
    })
    .get("/:id", async (c) => ok(c, await one(await findRow(idParam(c)))))
    .post("/", write, async (c) => {
      const input = (await readBody(c, config.create)) as Row;
      const data = config.prepare ? await config.prepare(input, null) : input;
      await checkReferences(data);
      const admin = c.get("admin");
      const row = await transaction(async () => {
        const [created] = await model.create([defined(data)]);
        const id = created!._id as string;
        await config.afterSave?.(id, data);
        await audit(admin, `${ACTION}_CREATED`, entity, id);
        return withId(created!.toObject() as Row & { _id: string });
      });
      revalidate(...config.tags);
      return ok(c, await one(row), undefined, 201);
    })
    .patch("/:id", write, async (c) => {
      const id = idParam(c);
      const existing = await findRow(id);
      const input = (await readBody(c, config.update)) as Row;
      const data = config.prepare ? await config.prepare(input, existing) : input;
      await checkReferences(data);
      const admin = c.get("admin");
      const row = await transaction(async () => {
        const fields = defined(data);
        const updated = Object.keys(fields).length
          ? await model.findOneAndUpdate({ _id: id }, { $set: fields }, { returnDocument: "after" }).lean<Row & { _id: string }>()
          : null;
        await config.afterSave?.(id, data);
        // Publishing is its own audit event (TESTIMONIAL_PUBLISHED), other edits are *_UPDATED.
        const change = typeof input.isPublished === "boolean" ? (input.isPublished ? "PUBLISHED" : "UNPUBLISHED") : "UPDATED";
        await audit(admin, `${ACTION}_${change}`, entity, id, { fields: Object.keys(input) });
        return updated ? withId(updated) : existing;
      });
      revalidate(...config.tags);
      return ok(c, await one(row));
    })
    .delete("/:id", remove, async (c) => {
      const id = idParam(c);
      await findRow(id);
      const admin = c.get("admin");
      await transaction(async () => {
        if (config.softDelete) {
          await model.updateOne({ _id: id }, { $set: { deletedAt: new Date() } });
        } else {
          if (await config.inUse?.(id)) throw inUse();
          await config.onDelete?.(id);
          await model.deleteOne({ _id: id });
        }
        await audit(admin, `${ACTION}_DELETED`, entity, id);
      });
      revalidate(...config.tags);
      return ok(c, { id, deleted: true });
    });

  if (config.orderable) {
    router.put("/order", write, async (c) => {
      const { ids } = await readBody(c, z.object({ ids: z.array(z.uuid()).min(1).max(500) }));
      const admin = c.get("admin");
      await transaction(async () => {
        if ((await model.countDocuments({ _id: { $in: ids } })) !== new Set(ids).size) throw notFound(label);
        for (const [index, id] of ids.entries()) await model.updateOne({ _id: id }, { $set: { displayOrder: index } });
        await audit(admin, `${ACTION}_REORDERED`, entity, null, { ids });
      });
      revalidate(...config.tags);
      return ok(c, { ids });
    });
  }

  return router;
}

/*
 * Zod helpers shared by admin schemas. Input schemas carry no defaults: in PATCH requests a missing field
 * must stay missing (unchanged), and on create the model defaults apply.
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
