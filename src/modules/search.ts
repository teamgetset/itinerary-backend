import { Activity, Destination, type ActivityDoc, type DestinationDoc } from "../db/models.ts";
import { contains, normalizeText } from "../lib/text.ts";
import { loadImages } from "./media/dto.ts";
import { listPublicPackages } from "./packages/read.ts";

/**
 * Site search across packages, destinations and activities. Each entity type is one section of the result,
 * so adding hotels or blog posts later is another section, not a new endpoint.
 */
export async function search(q: string, limit: number) {
  const words = normalizeText(q);
  if (!words) return { query: q, packages: [], destinations: [], activities: [] };
  const text = contains(q.trim());

  const [packageResults, destinationRows, activityMatches] = await Promise.all([
    listPublicPackages({ q, page: 1, pageSize: limit }),
    Destination.find({ isActive: true, $or: [{ name: text }, { countryName: text }, { region: text }] })
      .sort({ displayOrder: 1 })
      .limit(limit)
      .lean<DestinationDoc[]>(),
    Activity.find({ isActive: true, $or: [{ name: text }, { location: text }] }).lean<ActivityDoc[]>(),
  ]);
  // Ordered by lower-cased name, as before. ponytail: sorts every match in memory; fine for a few hundred activities.
  const activityRows = activityMatches
    .sort((a, b) => (a.name.toLowerCase() < b.name.toLowerCase() ? -1 : a.name.toLowerCase() > b.name.toLowerCase() ? 1 : 0))
    .slice(0, limit);
  const destinationIds = [...new Set(activityRows.map((a) => a.destinationId).filter((id): id is string => !!id))];
  const activityDestinations = destinationIds.length ? await Destination.find({ _id: { $in: destinationIds } }, { slug: 1, name: 1 }).lean<DestinationDoc[]>() : [];

  const image = await loadImages([...destinationRows.map((d) => d.heroImageId), ...activityRows.map((a) => a.imageId)]);
  return {
    query: q,
    packages: packageResults.items,
    destinations: destinationRows.map((d) => ({
      slug: d.slug,
      name: d.name,
      country: { code: d.countryCode, name: d.countryName },
      heroImage: image(d.heroImageId),
    })),
    activities: activityRows.map((activity) => {
      const destination = activityDestinations.find((d) => d._id === activity.destinationId);
      return {
        slug: activity.slug,
        name: activity.name,
        location: activity.location,
        image: image(activity.imageId),
        destination: destination ? { slug: destination.slug, name: destination.name } : null,
      };
    }),
  };
}
