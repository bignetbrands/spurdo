// GET /api/visits → global visitor counter, +1 per page visit.
// lives in da same upstash redis as da bot n da revshare cache.
// floor iz 10489 (da count when da real counter went live) — self-heals if
// da key ever resets.

import { NextResponse } from "next/server";
import { Redis } from "@upstash/redis";

export const dynamic = "force-dynamic";

const KEY = "landing:visits";
const FLOOR = 10489;

let _redis: Redis | null = null;
function r(): Redis | null {
  if (_redis) return _redis;
  const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;
  _redis = new Redis({ url, token, automaticDeserialization: false });
  return _redis;
}

export async function GET() {
  let n = FLOOR;
  const redis = r();
  if (redis) {
    try {
      n = Number(await redis.incr(KEY));
      if (n < FLOOR) {
        await redis.set(KEY, String(FLOOR));
        n = FLOOR;
      }
    } catch { /* redis down → show da floor, dont break da page */ }
  }
  return NextResponse.json({ n }, { headers: { "Cache-Control": "no-store" } });
}
