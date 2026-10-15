/**
 * `npm run search:reindex`: rebuilds every package's search text, e.g. after what it covers has changed
 * (modules/packages/search-text.ts). Safe to run any time: it only rewrites searchText, never updatedAt.
 * On Render (no tsx in the image): `node dist/scripts/search-reindex.js` in the service's Shell.
 */
import { env } from "../config/env.ts";
import { connectDb, disconnectDb } from "../db/client.ts";
import { Package } from "../db/models.ts";
import { safeMessage } from "../lib/logger.ts";
import { refreshSearchText } from "../modules/packages/search-text.ts";

try {
  await connectDb();
  await refreshSearchText({});
  console.log(`Database "${env.MONGODB_DB_NAME}": search text rebuilt for ${await Package.countDocuments()} package(s).`);
} catch (error) {
  console.error("Re-indexing failed:", safeMessage(error));
  process.exitCode = 1;
} finally {
  await disconnectDb();
}
