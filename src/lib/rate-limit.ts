import { AppError } from "./errors.ts";

/**
 * Fixed-window counter per key, held in memory.
 * ponytail: per process. Behind several API instances, move the counters to Redis or the database.
 */
export function rateLimiter({ limit, windowMs }: { limit: number; windowMs: number }) {
  const hits = new Map<string, { count: number; resetAt: number }>();

  return {
    /** Counts one attempt; throws 429 once `limit` is passed within the window. */
    hit(key: string) {
      const now = Date.now();
      if (hits.size > 10_000) {
        for (const [k, v] of hits) if (v.resetAt <= now) hits.delete(k);
      }
      const entry = hits.get(key);
      if (!entry || entry.resetAt <= now) {
        hits.set(key, { count: 1, resetAt: now + windowMs });
        return;
      }
      entry.count++;
      if (entry.count > limit) {
        const minutes = Math.ceil((entry.resetAt - now) / 60_000);
        throw new AppError(429, "TOO_MANY_REQUESTS", `Too many attempts. Try again in ${minutes} minute${minutes === 1 ? "" : "s"}.`);
      }
    },
    reset(key: string) {
      hits.delete(key);
    },
  };
}
