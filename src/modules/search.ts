import { and, asc, eq, ilike, or, sql } from "drizzle-orm";
import { db } from "../db/client.ts";
import { activities, destinations } from "../db/schema.ts";
import { escapeLike, normalizeText } from "../lib/text.ts";
import { loadImages } from "./media/dto.ts";
import { listPublicPackages } from "./packages/read.ts";

/**
 * Site search across packages, destinations and activities. Each entity type is one section of the result,
 * so adding hotels or blog posts later is another section, not a new endpoint.
 */
export async function search(q: string, limit: number) {
  const words = normalizeText(q);
  if (!words) return { query: q, packages: [], destinations: [], activities: [] };
  const like = `%${escapeLike(q.trim())}%`;

  const [packageResults, destinationRows, activityRows] = await Promise.all([
    listPublicPackages({ q, page: 1, pageSize: limit }),
    db
      .select()
      .from(destinations)
      .where(
        and(
          eq(destinations.isActive, true),
          or(ilike(destinations.name, like), ilike(destinations.countryName, like), ilike(destinations.region, like)),
        ),
      )
      .orderBy(asc(destinations.displayOrder))
      .limit(limit),
    db
      .select({ activity: activities, destination: destinations })
      .from(activities)
      .leftJoin(destinations, eq(destinations.id, activities.destinationId))
      .where(and(eq(activities.isActive, true), or(ilike(activities.name, like), ilike(activities.location, like))))
      .orderBy(asc(sql`lower(${activities.name})`))
      .limit(limit),
  ]);

  const image = await loadImages(db, [...destinationRows.map((d) => d.heroImageId), ...activityRows.map((a) => a.activity.imageId)]);
  return {
    query: q,
    packages: packageResults.items,
    destinations: destinationRows.map((d) => ({
      slug: d.slug,
      name: d.name,
      country: { code: d.countryCode, name: d.countryName },
      heroImage: image(d.heroImageId),
    })),
    activities: activityRows.map(({ activity, destination }) => ({
      slug: activity.slug,
      name: activity.name,
      location: activity.location,
      image: image(activity.imageId),
      destination: destination ? { slug: destination.slug, name: destination.name } : null,
    })),
  };
}
