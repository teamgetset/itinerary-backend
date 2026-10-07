import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { and, count, desc, eq, ilike, isNull, or } from "drizzle-orm";
import { z } from "zod";
import { db } from "../../db/client.ts";
import { media } from "../../db/schema.ts";
import { AppError, badRequest, notFound } from "../../lib/errors.ts";
import { idParam, ok, pageMeta, pageQuery, readBody, readQuery, type AppEnv } from "../../lib/http.ts";
import { log } from "../../lib/logger.ts";
import { escapeLike } from "../../lib/text.ts";
import { requireRole } from "../auth/middleware.ts";
import { audit } from "../audit.ts";
import { IMAGE_MAX_BYTES, newKey, safeFileName, sniffImage, storage } from "../storage.ts";
import { mediaDto } from "./dto.ts";

/* The media library: upload once, reuse anywhere (packages, branches, hero slides...). */

const focalPoint = z
  .string()
  .trim()
  .regex(/^(left|center|right|\d{1,3}%)( (top|center|bottom|\d{1,3}%))?$/, "Use a CSS position such as \"center 25%\"")
  .nullish();

const listQuery = pageQuery.extend({
  q: z.string().trim().max(100).optional(),
  kind: z.enum(["IMAGE", "DOCUMENT"]).default("IMAGE"),
});

export const mediaAdminRoutes = new Hono<AppEnv>()
  .get("/", async (c) => {
    const query = readQuery(c, listQuery);
    const where = and(
      isNull(media.deletedAt),
      eq(media.kind, query.kind),
      query.q ? or(ilike(media.fileName, `%${escapeLike(query.q)}%`), ilike(media.altText, `%${escapeLike(query.q)}%`)) : undefined,
    );
    const [rows, [{ total }]] = await Promise.all([
      db
        .select()
        .from(media)
        .where(where)
        .orderBy(desc(media.createdAt))
        .limit(query.pageSize)
        .offset((query.page - 1) * query.pageSize),
      db.select({ total: count() }).from(media).where(where),
    ]);
    return ok(c, rows.map(mediaDto), pageMeta(query.page, query.pageSize, total));
  })
  .get("/:id", async (c) => {
    const [row] = await db.select().from(media).where(eq(media.id, idParam(c))).limit(1);
    if (!row) throw notFound("File");
    return ok(c, mediaDto(row));
  })
  .post(
    "/",
    requireRole("EDITOR"),
    bodyLimit({
      maxSize: IMAGE_MAX_BYTES + 512 * 1024,
      onError: () => {
        throw new AppError(413, "FILE_TOO_LARGE", "Images can be up to 10 MB");
      },
    }),
    async (c) => {
      const form = await c.req.parseBody().catch(() => {
        throw badRequest("INVALID_UPLOAD", "Send the image as multipart/form-data in a field named \"file\"");
      });
      const file = form.file;
      if (!(file instanceof File)) throw badRequest("INVALID_UPLOAD", "Choose an image to upload");
      if (file.size === 0) throw badRequest("INVALID_UPLOAD", "The file is empty");
      if (file.size > IMAGE_MAX_BYTES) throw new AppError(413, "FILE_TOO_LARGE", "Images can be up to 10 MB");

      const data = Buffer.from(await file.arrayBuffer());
      // The real type comes from the bytes; the name and the browser's claimed type are not trusted.
      const type = sniffImage(data);
      if (!type) {
        log.warn("media.upload_rejected", { reason: "type", claimed: file.type });
        throw badRequest("UNSUPPORTED_FILE", "Upload a JPEG, PNG, WebP or AVIF image");
      }
      const meta = z
        .object({ alt: z.string().trim().max(250).optional(), focalPoint })
        .parse({ alt: form.alt || undefined, focalPoint: form.focalPoint || undefined });

      const key = newKey("images", type.ext);
      try {
        await storage.put(key, data, type.mime);
      } catch (error) {
        log.error("media.upload_failed", { error });
        throw new AppError(502, "STORAGE_ERROR", "The file could not be stored. Please try again.");
      }
      const admin = c.get("admin");
      const fileName = safeFileName(file.name, type.ext).replace(/\.[a-z0-9]+$/i, "") + `.${type.ext}`;
      const [row] = await db
        .insert(media)
        .values({ kind: "IMAGE", storageKey: key, fileName, mimeType: type.mime, sizeBytes: data.length, altText: meta.alt ?? "", focalPoint: meta.focalPoint ?? null, uploadedById: admin.id })
        .returning();
      await audit(db, admin, "MEDIA_UPLOADED", "media", row!.id, { fileName });
      return ok(c, mediaDto(row!), undefined, 201);
    },
  )
  .patch("/:id", requireRole("EDITOR"), async (c) => {
    const id = idParam(c);
    const input = await readBody(c, z.object({ alt: z.string().trim().max(250).optional(), focalPoint }));
    const [row] = await db
      .update(media)
      .set({ ...(input.alt !== undefined && { altText: input.alt }), ...(input.focalPoint !== undefined && { focalPoint: input.focalPoint }) })
      .where(eq(media.id, id))
      .returning();
    if (!row) throw notFound("File");
    await audit(db, c.get("admin"), "MEDIA_UPDATED", "media", id);
    return ok(c, mediaDto(row));
  })
  /** Archive: the file stays reachable where it is already used, but leaves the library. */
  .delete("/:id", requireRole("ADMIN"), async (c) => {
    const id = idParam(c);
    const [row] = await db.update(media).set({ deletedAt: new Date() }).where(and(eq(media.id, id), isNull(media.deletedAt))).returning({ id: media.id });
    if (!row) throw notFound("File");
    await audit(db, c.get("admin"), "MEDIA_ARCHIVED", "media", id);
    return ok(c, { id, deleted: true });
  });
