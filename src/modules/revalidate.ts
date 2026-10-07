import { env } from "../config/env.ts";
import { log } from "../lib/logger.ts";

/**
 * Cache tags the customer frontend uses. After a change, the API asks the frontend to drop those tags,
 * so the next visitor gets fresh pages. Coarse on purpose: content changes are rare and pages are cheap to rebuild.
 */
export type CacheTag = "catalog" | "testimonials" | "hero" | "content";

const pending = new Set<CacheTag>();
let timer: NodeJS.Timeout | null = null;

/** Batches tags for 250 ms so a burst of saves sends one request. Never throws: the site falls back to its revalidate interval. */
export function revalidate(...tags: CacheTag[]) {
  if (!env.REVALIDATE_SECRET) return;
  for (const tag of tags) pending.add(tag);
  timer ??= setTimeout(flush, 250);
}

async function flush() {
  const tags = [...pending];
  pending.clear();
  timer = null;
  try {
    const response = await fetch(`${env.FRONTEND_URL}/api/revalidate`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-revalidate-secret": env.REVALIDATE_SECRET! },
      body: JSON.stringify({ tags }),
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) log.warn("revalidate.rejected", { tags, status: response.status });
    else log.info("revalidate.sent", { tags });
  } catch (error) {
    log.warn("revalidate.unreachable", { tags, error });
  }
}
