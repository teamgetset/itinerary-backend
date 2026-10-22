import { Hono } from "hono";
import type { AppEnv } from "../lib/http.ts";
import { adminUserRoutes } from "./admin-users.ts";
import { requireAdmin, requireRole } from "./auth/middleware.ts";
import { branchAdminRoutes } from "./branches.ts";
import { activityAdminRoutes, categoryAdminRoutes, hotelAdminRoutes } from "./catalog.ts";
import { contentAdminRoutes } from "./content.ts";
import { currencyAdminRoutes } from "./currencies.ts";
import { auditLogRoutes, dashboardRoutes } from "./dashboard.ts";
import { destinationAdminRoutes } from "./destinations.ts";
import { enquiryAdminRoutes } from "./enquiries.ts";
import { googleReviewAdminRoutes } from "./google-reviews.ts";
import { heroSlideAdminRoutes } from "./hero-slides.ts";
import { mediaAdminRoutes } from "./media/routes.ts";
import { packageAdminRoutes } from "./packages/routes.ts";
import { testimonialAdminRoutes } from "./testimonials.ts";

/**
 * Everything under /api/admin needs a signed-in, active admin (checked on every request, server side).
 * Individual routes add role checks: EDITOR < ADMIN < SUPER_ADMIN. See docs/API.md for the matrix.
 */
export const adminRoutes = new Hono<AppEnv>()
  .use("*", requireAdmin)
  .route("/dashboard", dashboardRoutes)
  .route("/packages", packageAdminRoutes)
  .route("/branches", branchAdminRoutes)
  .route("/destinations", destinationAdminRoutes)
  .route("/categories", categoryAdminRoutes)
  .route("/hotels", hotelAdminRoutes)
  .route("/activities", activityAdminRoutes)
  .route("/currencies", currencyAdminRoutes)
  .route("/testimonials", testimonialAdminRoutes)
  .route("/google-reviews", googleReviewAdminRoutes)
  .route("/hero-slides", heroSlideAdminRoutes)
  .route("/content", contentAdminRoutes)
  .route("/media", mediaAdminRoutes)
  .route("/enquiries", enquiryAdminRoutes)
  .route("/audit-logs", new Hono<AppEnv>().use("*", requireRole("ADMIN")).route("/", auditLogRoutes))
  .route("/admin-users", new Hono<AppEnv>().use("*", requireRole("SUPER_ADMIN")).route("/", adminUserRoutes));
