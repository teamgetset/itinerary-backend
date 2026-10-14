import { AuditLog } from "../db/models.ts";
import type { AdminContext } from "../lib/http.ts";

/** Records an admin action, e.g. PACKAGE_PUBLISHED. Inside `transaction()` it is part of the same transaction. */
export async function audit(
  admin: Pick<AdminContext, "id"> | null,
  action: string,
  entity: string,
  entityId: string | null,
  metadata: Record<string, unknown> = {},
) {
  await AuditLog.create({ adminUserId: admin?.id ?? null, action, entity, entityId, metadata });
}
