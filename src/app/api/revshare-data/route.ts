// GET /api/revshare-data          → cached scan (shared across all visitors, ≤5 days old)
// GET /api/revshare-data?force=1  → run a fresh scan now
//
// cache lives in da same upstash redis da bot uses. a scan lock stops
// stampedes; while someone else's scan runs, stale data keeps serving.
// da nightly warmer (/api/cron/revshare-refresh) shares da same plumbing
// via src/lib/revshare-cache.ts, so visitors normally never wait on a scan.

import { NextRequest, NextResponse } from "next/server";
import { runFullScan, jstr, jparse } from "@/lib/revshare-scan";
import {
  readRevshareCache,
  writeRevshareCache,
  acquireScanLock,
  releaseScanLock,
  REVSHARE_MAX_AGE_MS,
} from "@/lib/revshare-cache";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

const respond = (payload: string, extra: Record<string, string> = {}) =>
  new NextResponse(payload, {
    status: 200,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...extra },
  });

export async function GET(req: NextRequest) {
  const force = req.nextUrl.searchParams.get("force") === "1";
  const cached = await readRevshareCache();
  if (cached && !force) {
    try {
      const age = Date.now() - (jparse(cached).savedAt || 0);
      if (age < REVSHARE_MAX_AGE_MS) return respond(cached, { "X-Revshare-Source": "cache" });
    } catch { /* fall thru 2 rescan */ }
  }

  // scan lock — one scan at a time, stale-while-scanning
  const gotLock = await acquireScanLock(300);
  if (!gotLock) {
    if (cached) return respond(cached, { "X-Revshare-Source": "stale-scan-running" });
    return NextResponse.json({ error: "scan in progress, try again in a minute :D" }, { status: 503 });
  }

  try {
    const data = await runFullScan();
    const payload = jstr(data);
    await writeRevshareCache(payload);
    return respond(payload, { "X-Revshare-Source": "fresh" });
  } catch (e) {
    console.error("revshare scan failed:", e);
    if (cached) return respond(cached, { "X-Revshare-Source": "stale-scan-failed" });
    return NextResponse.json({ error: String((e as Error)?.message || e) }, { status: 502 });
  } finally {
    await releaseScanLock();
  }
}
