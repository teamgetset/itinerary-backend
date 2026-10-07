import { Hono, type Context } from "hono";
import { z } from "zod";
import { env } from "../../config/env.ts";
import { signToken } from "../../lib/crypto.ts";
import { idParam, ok, parse, readBody, readQuery, type AppEnv } from "../../lib/http.ts";
import { requireRole } from "../auth/middleware.ts";
import { audit } from "../audit.ts";
import { db } from "../../db/client.ts";
import { findPdfVersion, ensureCurrentPdf, pdfHeaders, pdfStatus, readPdf } from "../pdf/service.ts";
import {
  activitiesInput,
  adminPackageQuery,
  createPackageInput,
  galleryInput,
  highlightsInput,
  hotelsInput,
  inclusionsInput,
  itineraryInput,
  pricesInput,
  updatePackageInput,
} from "./input.ts";
import {
  createPackage,
  deletePackage,
  duplicatePackage,
  listAdminPackages,
  loadEditorGraph,
  packageEditorDto,
  publishChecklist,
  publishPackage,
  saveActivities,
  saveGallery,
  saveHighlights,
  saveHotels,
  saveInclusions,
  saveItinerary,
  savePrices,
  setPackageStatus,
  updatePackage,
} from "./service.ts";

/** Draft preview links last an hour. */
const PREVIEW_TTL_SECONDS = 3600;

const editor = async (id: string) => packageEditorDto(await loadEditorGraph(id));

/** PUT /:id/<section> routes: replace one section of the editor, return the whole package again. */
function section<T extends z.ZodType>(schema: T, save: (id: string, input: z.infer<T>, admin: AppEnv["Variables"]["admin"]) => Promise<void>) {
  return async (c: Context<AppEnv>) => {
    const id = idParam(c);
    await save(id, await readBody(c, schema), c.get("admin"));
    return ok(c, await editor(id));
  };
}

export const packageAdminRoutes = new Hono<AppEnv>()
  .get("/", async (c) => {
    const { items, meta } = await listAdminPackages(readQuery(c, adminPackageQuery));
    return ok(c, items, meta);
  })
  .post("/", async (c) => {
    const id = await createPackage(await readBody(c, createPackageInput), c.get("admin"));
    return ok(c, await editor(id), undefined, 201);
  })
  .get("/:id", async (c) => ok(c, await editor(idParam(c))))
  .patch("/:id", async (c) => {
    const id = idParam(c);
    await updatePackage(id, await readBody(c, updatePackageInput), c.get("admin"));
    return ok(c, await editor(id));
  })
  .delete("/:id", requireRole("ADMIN"), async (c) => {
    const id = idParam(c);
    await deletePackage(id, c.get("admin"));
    return ok(c, { id, deleted: true });
  })
  .post("/:id/duplicate", async (c) => ok(c, await editor(await duplicatePackage(idParam(c), c.get("admin"))), undefined, 201))

  .put("/:id/highlights", section(highlightsInput, saveHighlights))
  .put("/:id/inclusions", section(inclusionsInput, (id, input, admin) => saveInclusions(id, input, admin, "inclusions")))
  .put("/:id/exclusions", section(inclusionsInput, (id, input, admin) => saveInclusions(id, input, admin, "exclusions")))
  .put("/:id/itinerary", section(itineraryInput, saveItinerary))
  .put("/:id/prices", section(pricesInput, savePrices))
  .put("/:id/hotels", section(hotelsInput, saveHotels))
  .put("/:id/activities", section(activitiesInput, saveActivities))
  .put("/:id/gallery", section(galleryInput, saveGallery))

  .get("/:id/publish-check", async (c) => {
    const checklist = await publishChecklist(await loadEditorGraph(idParam(c)));
    return ok(c, { ready: checklist.every((item) => item.ok), checklist });
  })
  .post("/:id/publish", requireRole("ADMIN"), async (c) => {
    const id = idParam(c);
    await publishPackage(id, c.get("admin"));
    return ok(c, await editor(id));
  })
  .post("/:id/unpublish", requireRole("ADMIN"), async (c) => {
    const id = idParam(c);
    await setPackageStatus(id, "DRAFT", c.get("admin"));
    return ok(c, await editor(id));
  })
  .post("/:id/archive", requireRole("ADMIN"), async (c) => {
    const id = idParam(c);
    await setPackageStatus(id, "ARCHIVED", c.get("admin"));
    return ok(c, await editor(id));
  })

  /** A link to the customer-style page for this package, valid for an hour, whatever its status. */
  .post("/:id/preview", async (c) => {
    const id = idParam(c);
    await loadEditorGraph(id);
    const token = signToken(`package:${id}`, env.AUTH_SECRET, PREVIEW_TTL_SECONDS);
    await audit(db, c.get("admin"), "PACKAGE_PREVIEWED", "package", id);
    return ok(c, {
      url: `${env.FRONTEND_URL}/preview/packages/${id}?token=${encodeURIComponent(token)}`,
      expiresAt: new Date(Date.now() + PREVIEW_TTL_SECONDS * 1000),
    });
  })

  .get("/:id/pdf", async (c) => ok(c, await pdfStatus(idParam(c))))
  /** Generate now (no-op when the current content already has a PDF). */
  .post("/:id/pdf", async (c) => ok(c, await ensureCurrentPdf(idParam(c), c.get("admin"))))
  .get("/:id/pdf/:version/:branding", async (c) => {
    const id = idParam(c);
    const version = parse(z.coerce.number().int().min(1), c.req.param("version"));
    const branding = parse(z.enum(["with-logo", "without-logo"]), c.req.param("branding"));
    const found = await findPdfVersion(id, version);
    const file = branding === "with-logo" ? found.withLogo : found.withoutLogo;
    return c.body(new Uint8Array(await readPdf(file)), 200, { ...pdfHeaders(file, "inline"), "Cache-Control": "private, no-store" });
  });

