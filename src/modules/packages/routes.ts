import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import { env } from "../../config/env.ts";
import { Package, type PackageDoc } from "../../db/models.ts";
import { signToken } from "../../lib/crypto.ts";
import { AppError, badRequest, notFound } from "../../lib/errors.ts";
import { idParam, ok, readBody, readQuery, type AppEnv } from "../../lib/http.ts";
import { requireRole } from "../auth/middleware.ts";
import { audit } from "../audit.ts";
import { PDF_MAX_BYTES, PDF_VERSIONS, pdfHeaders, pdfVersion, readItineraryPdf, removeItineraryPdf, uploadItineraryPdf } from "../pdf/itinerary-pdf.ts";
import {
  activitiesInput,
  adminPackageQuery,
  createPackageInput,
  galleryInput,
  highlightsInput,
  hotelsInput,
  importantInfoInput,
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
  saveImportantInfo,
  saveListSection,
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
  .put("/:id/inclusions", section(inclusionsInput, (id, input, admin) => saveListSection(id, input, admin, "inclusions")))
  .put("/:id/exclusions", section(inclusionsInput, (id, input, admin) => saveListSection(id, input, admin, "exclusions")))
  .put("/:id/good-to-know", section(inclusionsInput, (id, input, admin) => saveListSection(id, input, admin, "goodToKnow")))
  .put("/:id/important-info", section(importantInfoInput, saveImportantInfo))
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
    await audit(c.get("admin"), "PACKAGE_PREVIEWED", "package", id);
    return ok(c, {
      url: `${env.FRONTEND_URL}/preview/packages/${id}?token=${encodeURIComponent(token)}`,
      expiresAt: new Date(Date.now() + PREVIEW_TTL_SECONDS * 1000),
    });
  })

  /** One version of the uploaded itinerary PDF (with-logo when none is named), for checking in the admin. Never cached. */
  .get("/:id/itinerary-pdf/:version?", async (c) => {
    const field = PDF_VERSIONS[pdfVersion(c.req.param("version"))];
    const pkg = await Package.findOne({ _id: idParam(c), deletedAt: null }, { [field]: 1 }).lean<Pick<PackageDoc, typeof field>>();
    if (!pkg) throw notFound("Package");
    const file = await readItineraryPdf(pkg[field] ?? null);
    if (!file) throw notFound("Itinerary PDF");
    return c.body(new Uint8Array(file.data), 200, { ...pdfHeaders(file.row.fileName, file.data.length, "inline"), "Cache-Control": "private, no-store" });
  })
  /** Upload or replace one version of the itinerary PDF (multipart, field "file", up to 4 MB). */
  .put(
    "/:id/itinerary-pdf/:version?",
    requireRole("EDITOR"),
    bodyLimit({
      maxSize: PDF_MAX_BYTES + 64 * 1024,
      onError: () => {
        throw new AppError(413, "FILE_TOO_LARGE", "Itinerary PDFs can be up to 4 MB.");
      },
    }),
    async (c) => {
      const form = await c.req.parseBody().catch(() => {
        throw badRequest("INVALID_UPLOAD", 'Send the PDF as multipart/form-data in a field named "file"');
      });
      if (!(form.file instanceof File)) throw badRequest("INVALID_UPLOAD", "Choose a PDF file to upload.");
      return ok(c, await uploadItineraryPdf(idParam(c), form.file, c.get("admin"), pdfVersion(c.req.param("version"))));
    },
  )
  /** Remove one version of the itinerary PDF (the one with the logo only while the package is not published). */
  .delete("/:id/itinerary-pdf/:version?", requireRole("ADMIN"), async (c) =>
    ok(c, await removeItineraryPdf(idParam(c), c.get("admin"), pdfVersion(c.req.param("version")))),
  );

