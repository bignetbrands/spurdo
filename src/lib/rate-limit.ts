import { Redis } from "@upstash/redis";
import { kvKey } from "./config";

// ============================================================
// SLIDING-WINDOW RATE LIMIT
// ============================================================
// Token-bucket-ish: tracks per-bucket request timestamps in a
// Redis sorted set, drops everything older than the window,
// then counts what's left.
//
// Each "bucket" is identified by a string — could be an IP,
// a user, an admin secret hash, or just a global key like "generate".
//
// Used by the admin generate route to prevent runaway calls.
// ============================================================

let _redis: Redis | null = null;
function r(): Redis {
  if (_redis) return _redis;
  const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) throw new Error("KV not configured");
  _redis = new Redis({ url, token });
  return _redis;
}

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  /** Seconds until the oldest request in the window expires (when next slot opens) */
  retryAfterSeconds: number;
  /** Total requests in this window */
  count: number;
  limit: number;
}

/**
 * Check + record a hit against the rate limit.
 *
 * @param bucket  unique identifier (e.g. "generate:global", "generate:ip:1.2.3.4")
 * @param limit   max requests allowed in the window
 * @param windowSeconds  size of the sliding window in seconds
 *
 * @returns { allowed, remaining, retryAfterSeconds, count, limit }
 *
 * Note: this is best-effort. Under very high concurrency you might
 * get a few extra requests through — that's fine for our use case.
 */
export async function checkRateLimit(
  bucket: string,
  limit: number,
  windowSeconds: number
): Promise<RateLimitResult> {
  const key = kvKey(`ratelimit:${bucket}`);
  const now = Date.now();
  const windowMs = windowSeconds * 1000;
  const cutoff = now - windowMs;

  // Drop expired entries, count remaining, add this hit, set TTL
  const redis = r();
  await redis.zremrangebyscore(key, 0, cutoff);
  const count = await redis.zcard(key);

  if (count >= limit) {
    // Find when the oldest one in the window will expire — next slot opens then
    const oldest = await redis.zrange<(string | number)[]>(key, 0, 0, { withScores: true });
    let retryAfterSeconds = windowSeconds;
    if (oldest.length >= 2) {
      const oldestScore = Number(oldest[1]);
      retryAfterSeconds = Math.max(1, Math.ceil((oldestScore + windowMs - now) / 1000));
    }
    return {
      allowed: false,
      remaining: 0,
      retryAfterSeconds,
      count,
      limit,
    };
  }

  // Record this hit
  // Member must be unique; use timestamp + random suffix
  const member = `${now}-${Math.random().toString(36).slice(2, 8)}`;
  await redis.zadd(key, { score: now, member });
  await redis.expire(key, windowSeconds + 60);

  return {
    allowed: true,
    remaining: limit - count - 1,
    retryAfterSeconds: 0,
    count: count + 1,
    limit,
  };
}
