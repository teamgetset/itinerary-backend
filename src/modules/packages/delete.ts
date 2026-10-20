import { Package } from "../../db/models.ts";
import type { AdminContext } from "../../lib/http.ts";
import { audit } from "../audit.ts";

/**
 * Soft-deletes one package: it leaves the admin and the website, its slug is released for reuse, and history
 * (enquiries, audit) keeps pointing at the document. Runs inside the caller's transaction; the caller refreshes the
 * website's catalogue when a published package was among them.
 */
export async function markPackageDeleted(pkg: { id: string; slug: string; status: string }, admin: AdminContext, metadata: Record<string, unknown> = {}) {
  await Package.updateOne(
    { _id: pkg.id },
    { $set: { deletedAt: new Date(), slug: `${pkg.slug}-deleted-${Date.now().toString(36)}`, updatedById: admin.id } },
  );
  await audit(admin, "PACKAGE_DELETED", "package", pkg.id, { slug: pkg.slug, from: pkg.status, ...metadata });
}
