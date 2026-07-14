// GET /api/revshare-data          → cached scan (shared across all visitors, ≤5 days old)
// GET /api/revshare-data?force=1  → run a fresh scan now
//
// cache lives in da same upstash redis da bot uses. a scan lock stops
// stampedes; while someone else's scan runs, stale data keeps serving.

import { NextRequest, NextResponse } from "next/server";
import { Redis } from "@upstash/redis";
import { runFullScan, jstr, jparse } from "@/lib/revshare-scan";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

const CACHE_KEY = "revshare:data:v2";
const LOCK_KEY = "revshare:scan-lock";
const MAX_AGE_MS = 5 * 24 * 3600 * 1000;

let _redis: Redis | null = null;
function r(): Redis | null {
  if (_redis) return _redis;
  const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null; // degrade: scan evry call, no shared cache
  _redis = new Redis({ url, token });
  return _redis;
}

async function readCache(): Promise<string | null> {
  try { return (await r()?.get<string>(CACHE_KEY)) ?? null; } catch { return null; }
}
async function writeCache(payload: string) {
  try { await r()?.set(CACHE_KEY, payload); } catch { /* cacheless iz fine */ }
}

const respond = (payload: string, extra: Record<string, string> = {}) =>
  new NextResponse(payload, {
    status: 200,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...extra },
  });

export async function GET(req: NextRequest) {
  const force = req.nextUrl.searchParams.get("force") === "1";
  const cached = await readCache();
  if (cached && !force) {
    try {
      const age = Date.now() - (jparse(cached).savedAt || 0);
      if (age < MAX_AGE_MS) return respond(cached, { "X-Revshare-Source": "cache" });
    } catch { /* fall thru 2 rescan */ }
  }

  // scan lock — one scan at a time, stale-while-scanning
  const redis = r();
  let gotLock = true;
  if (redis) {
    try { gotLock = (await redis.set(LOCK_KEY, "1", { nx: true, ex: 300 })) !== null; } catch { gotLock = true; }
  }
  if (!gotLock) {
    if (cached) return respond(cached, { "X-Revshare-Source": "stale-scan-running" });
    return NextResponse.json({ error: "scan in progress, try again in a minute :D" }, { status: 503 });
  }

  try {
    const data = await runFullScan();
    const payload = jstr(data);
    await writeCache(payload);
    return respond(payload, { "X-Revshare-Source": "fresh" });
  } catch (e) {
    console.error("revshare scan failed:", e);
    if (cached) return respond(cached, { "X-Revshare-Source": "stale-scan-failed" });
    return NextResponse.json({ error: String((e as Error)?.message || e) }, { status: 502 });
  } finally {
    if (redis) { try { await redis.del(LOCK_KEY); } catch { } }
  }
}
