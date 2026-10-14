import { Hono } from "hono";
import { Media, type MediaDoc } from "../../db/models.ts";
import { CONTENT_TYPES, storage } from "../storage.ts";

/**
 * Serves public images stored on this server. Keys are unique per upload, so files are cached for a year.
 * Images moved to Cloudinary keep their old address working: it redirects (301) to the Cloudinary URL.
 * Documents (PDFs) are not served here; they go through access-checked API routes.
 */
export const mediaFileRoutes = new Hono().get("/images/*", async (c) => {
  const key = c.req.path.replace(/^\/media\//, "");
  const ext = key.split(".").pop() ?? "";
  const type = CONTENT_TYPES[ext];
  if (!type || type === "application/pdf") return c.notFound();
  const moved = await Media.findOne({ storageKey: key, kind: "IMAGE" }, { cloudinary: 1 }).lean<Pick<MediaDoc, "cloudinary">>();
  if (moved?.cloudinary) {
    c.header("Cache-Control", "public, max-age=86400");
    return c.redirect(moved.cloudinary.secureUrl, 301);
  }
  const data = await storage.get(key).catch(() => null);
  if (!data) return c.notFound();
  return c.body(new Uint8Array(data), 200, {
    "Content-Type": type,
    "Cache-Control": "public, max-age=31536000, immutable",
    "X-Content-Type-Options": "nosniff",
  });
});
