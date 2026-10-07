import { Hono } from "hono";
import { CONTENT_TYPES, storage } from "../storage.ts";

/**
 * Serves public images for the local storage provider. Keys are unique per upload, so files are cached for a year.
 * Documents (PDFs) are not served here; they go through access-checked API routes.
 */
export const mediaFileRoutes = new Hono().get("/images/*", async (c) => {
  const key = c.req.path.replace(/^\/media\//, "");
  const ext = key.split(".").pop() ?? "";
  const type = CONTENT_TYPES[ext];
  if (!type || type === "application/pdf") return c.notFound();
  const data = await storage.get(key).catch(() => null);
  if (!data) return c.notFound();
  return c.body(new Uint8Array(data), 200, {
    "Content-Type": type,
    "Cache-Control": "public, max-age=31536000, immutable",
    "X-Content-Type-Options": "nosniff",
  });
});
