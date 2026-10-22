import { Hono } from "hono";
import { z } from "zod";
import { AdminUser, AuditLog, Branch, Destination, Enquiry, Package, Testimonial, defined, type AuditLogDoc, type EnquiryDoc } from "../db/models.ts";
import { ok, pageMeta, pageQuery, readQuery, type AppEnv } from "../lib/http.ts";
import { googleReviewsStatus } from "./google-reviews.ts";

/** Admin names by id, for "who did this" columns. */
async function adminNames(ids: (string | null)[]) {
  const unique = [...new Set(ids.filter((id): id is string => !!id))];
  const rows = unique.length ? await AdminUser.find({ _id: { $in: unique } }, { name: 1 }).lean<{ _id: string; name: string }[]>() : [];
  return (id: string | null) => rows.find((row) => row._id === id)?.name ?? null;
}

export const dashboardRoutes = new Hono<AppEnv>().get("/", async (c) => {
  const livePackages = { deletedAt: null };
  const [totalPackages, publishedPackages, draftPackages, branchCount, destinationCount, testimonialCount, newEnquiries, enquiries, recentPackages, logs] =
    await Promise.all([
      Package.countDocuments(livePackages),
      Package.countDocuments({ ...livePackages, status: "PUBLISHED" }),
      Package.countDocuments({ ...livePackages, status: "DRAFT" }),
      Branch.countDocuments(),
      Destination.countDocuments({ deletedAt: null }),
      Testimonial.countDocuments({ deletedAt: null, isPublished: true }),
      Enquiry.countDocuments({ status: "NEW" }),
      Enquiry.find({}, { name: 1, status: 1, createdAt: 1, packageId: 1, adults: 1, children: 1, infants: 1 }).sort({ createdAt: -1 }).limit(5).lean<EnquiryDoc[]>(),
      Package.find(livePackages, { title: 1, status: 1, updatedAt: 1 }).sort({ updatedAt: -1 }).limit(5).lean<{ _id: string; title: string; status: string; updatedAt: Date }[]>(),
      AuditLog.find().sort({ createdAt: -1 }).limit(8).lean<AuditLogDoc[]>(),
    ]);
  const packageIds = [...new Set(enquiries.map((e) => e.packageId).filter((id): id is string => !!id))];
  const [titles, admin] = await Promise.all([
    Package.find({ _id: { $in: packageIds } }, { title: 1 }).lean<{ _id: string; title: string }[]>(),
    adminNames(logs.map((log) => log.adminUserId)),
  ]);
  return ok(c, {
    counts: { totalPackages, publishedPackages, draftPackages, branches: branchCount, destinations: destinationCount, testimonials: testimonialCount, newEnquiries },
    recentEnquiries: enquiries.map((e) => ({
      id: e._id,
      name: e.name,
      status: e.status,
      createdAt: e.createdAt,
      packageTitle: titles.find((t) => t._id === e.packageId)?.title ?? null,
      adults: e.adults,
      children: e.children,
      infants: e.infants,
    })),
    recentPackages: recentPackages.map((p) => ({ id: p._id, title: p.title, status: p.status, updatedAt: p.updatedAt })),
    activity: logs.map((log) => ({ action: log.action, entity: log.entity, entityId: log.entityId, createdAt: log.createdAt, admin: admin(log.adminUserId) })),
    googleReviews: await googleReviewsStatus(),
  });
});

const auditQuery = pageQuery.extend({ entity: z.string().max(40).optional(), entityId: z.string().max(64).optional() });

export const auditLogRoutes = new Hono<AppEnv>().get("/", async (c) => {
  const query = readQuery(c, auditQuery);
  const filter = defined({ entity: query.entity, entityId: query.entityId });
  const [rows, total] = await Promise.all([
    AuditLog.find(filter)
      .sort({ createdAt: -1 })
      .skip((query.page - 1) * query.pageSize)
      .limit(query.pageSize)
      .lean<AuditLogDoc[]>(),
    AuditLog.countDocuments(filter),
  ]);
  const admin = await adminNames(rows.map((row) => row.adminUserId));
  return ok(
    c,
    rows.map((row) => ({ id: row._id, action: row.action, entity: row.entity, entityId: row.entityId, metadata: row.metadata, createdAt: row.createdAt, admin: admin(row.adminUserId) })),
    pageMeta(query.page, query.pageSize, total),
  );
});
