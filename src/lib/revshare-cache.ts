// shared revshare cache plumbing — used by /api/revshare-data (visitor path)
// and /api/cron/revshare-refresh (nightly warmer). one place 4 da cache key
// so a version bump cant drift between da two.

import { Redis } from "@upstash/redis";

export const REVSHARE_CACHE_KEY = "revshare:data:v5";
export const REVSHARE_LOCK_KEY = "revshare:scan-lock";
export const REVSHARE_MAX_AGE_MS = 5 * 24 * 3600 * 1000;

let _redis: Redis | null = null;
export function revshareRedis(): Redis | null {
  if (_redis) return _redis;
  const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null; // degrade: scan evry call, no shared cache
  // automaticDeserialization iz ON by default: upstash stores our json string raw,
  // den JSON.parses it on read n hands back an OBJECT. dat made jparse throw (so da
  // cache never hit n evry request rescanned) n made respond() emit "[object Object]",
  // which da page reads as a bad payload n falls back 2 da pruned browser rpc.
  _redis = new Redis({ url, token, automaticDeserialization: false });
  return _redis;
}

export async function readRevshareCache(): Promise<string | null> {
  try {
    const v = await revshareRedis()?.get<unknown>(REVSHARE_CACHE_KEY);
    if (v === null || v === undefined) return null;
    // belt n braces: if anyding ever hands back a parsed object, re-stringify it.
    // da {$b:"…"} bigint markers r plain objects, so dey survive da round trip.
    return typeof v === "string" ? v : JSON.stringify(v);
  } catch { return null; }
}

export async function writeRevshareCache(payload: string): Promise<void> {
  try { await revshareRedis()?.set(REVSHARE_CACHE_KEY, payload); } catch { /* cacheless iz fine */ }
}

/** SET NX scan lock. Returns true if acquired. */
export async function acquireScanLock(ttlSeconds: number): Promise<boolean> {
  const redis = revshareRedis();
  if (!redis) return true;
  try { return (await redis.set(REVSHARE_LOCK_KEY, "1", { nx: true, ex: ttlSeconds })) !== null; }
  catch { return true; }
}

export async function releaseScanLock(): Promise<void> {
  try { await revshareRedis()?.del(REVSHARE_LOCK_KEY); } catch { }
}
