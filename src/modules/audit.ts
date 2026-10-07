import { auditLogs } from "../db/schema.ts";
import type { Db, Tx } from "../db/client.ts";
import type { AdminContext } from "../lib/http.ts";

/** Records an admin action, e.g. PACKAGE_PUBLISHED. Call inside the same transaction as the change. */
export async function audit(
  db: Db | Tx,
  admin: Pick<AdminContext, "id"> | null,
  action: string,
  entity: string,
  entityId: string | null,
  metadata: Record<string, unknown> = {},
) {
  await db.insert(auditLogs).values({ adminUserId: admin?.id ?? null, action, entity, entityId, metadata });
}
