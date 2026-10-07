import { Hono } from "hono";
import { and, count, desc, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import { db } from "../db/client.ts";
import { adminUsers, auditLogs, branches, destinations, enquiries, packages, testimonials } from "../db/schema.ts";
import { ok, pageMeta, pageQuery, readQuery, type AppEnv } from "../lib/http.ts";

const tally = async (query: Promise<{ total: number }[]>) => (await query)[0]!.total;

export const dashboardRoutes = new Hono<AppEnv>().get("/", async (c) => {
  const livePackages = isNull(packages.deletedAt);
  const [totalPackages, publishedPackages, draftPackages, branchCount, destinationCount, testimonialCount, newEnquiries, recentEnquiries, recentPackages, activity] =
    await Promise.all([
      tally(db.select({ total: count() }).from(packages).where(livePackages)),
      tally(db.select({ total: count() }).from(packages).where(and(livePackages, eq(packages.status, "PUBLISHED")))),
      tally(db.select({ total: count() }).from(packages).where(and(livePackages, eq(packages.status, "DRAFT")))),
      tally(db.select({ total: count() }).from(branches)),
      tally(db.select({ total: count() }).from(destinations)),
      tally(db.select({ total: count() }).from(testimonials).where(and(isNull(testimonials.deletedAt), eq(testimonials.isPublished, true)))),
      tally(db.select({ total: count() }).from(enquiries).where(eq(enquiries.status, "NEW"))),
      db
        .select({ id: enquiries.id, name: enquiries.name, status: enquiries.status, createdAt: enquiries.createdAt, packageTitle: packages.title, adults: enquiries.adults, children: enquiries.children, infants: enquiries.infants })
        .from(enquiries)
        .leftJoin(packages, eq(packages.id, enquiries.packageId))
        .orderBy(desc(enquiries.createdAt))
        .limit(5),
      db
        .select({ id: packages.id, title: packages.title, status: packages.status, updatedAt: packages.updatedAt })
        .from(packages)
        .where(livePackages)
        .orderBy(desc(packages.updatedAt))
        .limit(5),
      db
        .select({ action: auditLogs.action, entity: auditLogs.entity, entityId: auditLogs.entityId, createdAt: auditLogs.createdAt, admin: adminUsers.name })
        .from(auditLogs)
        .leftJoin(adminUsers, eq(adminUsers.id, auditLogs.adminUserId))
        .orderBy(desc(auditLogs.createdAt))
        .limit(8),
    ]);
  return ok(c, {
    counts: { totalPackages, publishedPackages, draftPackages, branches: branchCount, destinations: destinationCount, testimonials: testimonialCount, newEnquiries },
    recentEnquiries,
    recentPackages,
    activity,
  });
});

const auditQuery = pageQuery.extend({ entity: z.string().max(40).optional(), entityId: z.string().max(64).optional() });

export const auditLogRoutes = new Hono<AppEnv>().get("/", async (c) => {
  const query = readQuery(c, auditQuery);
  const where = and(
    query.entity ? eq(auditLogs.entity, query.entity) : undefined,
    query.entityId ? eq(auditLogs.entityId, query.entityId) : undefined,
  );
  const [rows, [{ total }]] = await Promise.all([
    db
      .select({ id: auditLogs.id, action: auditLogs.action, entity: auditLogs.entity, entityId: auditLogs.entityId, metadata: auditLogs.metadata, createdAt: auditLogs.createdAt, admin: adminUsers.name })
      .from(auditLogs)
      .leftJoin(adminUsers, eq(adminUsers.id, auditLogs.adminUserId))
      .where(where)
      .orderBy(desc(auditLogs.createdAt))
      .limit(query.pageSize)
      .offset((query.page - 1) * query.pageSize),
    db.select({ total: count() }).from(auditLogs).where(where),
  ]);
  return ok(c, rows, pageMeta(query.page, query.pageSize, total));
});
