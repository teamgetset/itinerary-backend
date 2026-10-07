import { asc, eq, inArray, sql, type SQL } from "drizzle-orm";
import type { Db, Tx } from "../../db/client.ts";
import { branches, destinations, packageCategories, packageHighlights, packages } from "../../db/schema.ts";
import { normalizeText } from "../../lib/text.ts";

/**
 * Rebuilds packages.search_text: title, pitch, keywords, destination, country, branch, category, arrival city
 * and highlights, lower-cased without accents ("Malé" matches "male").
 * Called after any change to those, including renaming a destination, branch or category.
 */
export async function refreshSearchText(db: Db | Tx, where: SQL) {
  const rows = await db
    .select({
      id: packages.id,
      title: packages.title,
      shortDescription: packages.shortDescription,
      keywords: packages.keywords,
      arrivalCity: packages.arrivalCity,
      arrivalAirportCode: packages.arrivalAirportCode,
      destination: destinations.name,
      country: destinations.countryName,
      region: destinations.region,
      branch: branches.name,
      category: packageCategories.name,
    })
    .from(packages)
    .innerJoin(destinations, eq(destinations.id, packages.destinationId))
    .innerJoin(branches, eq(branches.id, packages.branchId))
    .leftJoin(packageCategories, eq(packageCategories.id, packages.categoryId))
    .where(where);
  if (!rows.length) return;

  const highlights = await db
    .select({ packageId: packageHighlights.packageId, title: packageHighlights.title })
    .from(packageHighlights)
    .where(inArray(packageHighlights.packageId, rows.map((row) => row.id)))
    .orderBy(asc(packageHighlights.displayOrder));

  for (const row of rows) {
    const text = normalizeText(
      [
        row.title,
        row.shortDescription,
        ...row.keywords,
        row.arrivalCity,
        row.arrivalAirportCode,
        row.destination,
        row.country,
        row.region,
        row.branch,
        row.category,
        ...highlights.filter((h) => h.packageId === row.id).map((h) => h.title),
      ]
        .filter(Boolean)
        .join(" "),
    );
    // Keep updated_at as it was: re-indexing is not an edit.
    await db.update(packages).set({ searchText: text, updatedAt: sql`${packages.updatedAt}` }).where(eq(packages.id, row.id));
  }
}
