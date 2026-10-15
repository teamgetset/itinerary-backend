import { Category, Destination, Package, type CategoryDoc, type DestinationDoc, type PackageDoc } from "../../db/models.ts";
import { normalizeText } from "../../lib/text.ts";

/**
 * Rebuilds packages.searchText: title, pitch, keywords, destination, country, category, arrival city and highlights,
 * lower-cased without accents ("Malé" matches "male"). Called after any change to those, including renaming a
 * destination or category.
 *
 * The selling branch is left out on purpose: "Dubai" is both a branch and a destination, and a search for it must find
 * trips to Dubai, not everything the Dubai office sells (its branch page lists those). After changing what is covered
 * here, run `npm run search:reindex` once.
 */
export async function refreshSearchText(filter: Record<string, unknown>) {
  const rows = await Package.find(filter, {
    title: 1,
    shortDescription: 1,
    keywords: 1,
    arrivalCity: 1,
    arrivalAirportCode: 1,
    destinationId: 1,
    categoryId: 1,
    highlights: 1,
  }).lean<Pick<PackageDoc, "_id" | "title" | "shortDescription" | "keywords" | "arrivalCity" | "arrivalAirportCode" | "destinationId" | "categoryId" | "highlights">[]>();
  if (!rows.length) return;

  const ids = (field: "destinationId" | "categoryId") => [...new Set(rows.map((row) => row[field]).filter((id): id is string => !!id))];
  // Sequential on purpose: this can run inside a transaction, which allows no parallel operations.
  const destinations = new Map((await Destination.find({ _id: { $in: ids("destinationId") } }).lean<DestinationDoc[]>()).map((d) => [d._id, d]));
  const categories = new Map((await Category.find({ _id: { $in: ids("categoryId") } }).lean<CategoryDoc[]>()).map((c) => [c._id, c]));

  for (const row of rows) {
    const destination = destinations.get(row.destinationId);
    const text = normalizeText(
      [
        row.title,
        row.shortDescription,
        ...row.keywords,
        row.arrivalCity,
        row.arrivalAirportCode,
        destination?.name,
        destination?.countryName,
        destination?.region,
        row.categoryId ? categories.get(row.categoryId)?.name : null,
        ...row.highlights.map((highlight) => highlight.title),
      ]
        .filter(Boolean)
        .join(" "),
    );
    // Keep updatedAt as it was: re-indexing is not an edit.
    await Package.updateOne({ _id: row._id }, { $set: { searchText: text } }, { timestamps: false });
  }
}
