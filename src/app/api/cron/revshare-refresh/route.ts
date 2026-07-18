import { NextResponse } from "next/server";
import { checkCronAuth } from "@/lib/auth";
import { runFullScan, jstr } from "@/lib/revshare-scan";
import {
  writeRevshareCache,
  acquireScanLock,
  releaseScanLock,
} from "@/lib/revshare-cache";
import { logEvent } from "@/lib/events";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * GET /api/cron/revshare-refresh
 *
 * Nightly warmer for da /revshare cache (vercel.json, 04:20 utc). Da
 * visitor path serves cache up 2 5 days old; widout dis, whoever lands
 * first after expiry eats a ~50s scan. Wit it, da cache iz never older
 * dan a day n visitors always get da instant path.
 *
 * Always returns 200 — a failed refresh jus means da old cache keeps
 * serving, which iz da normal degraded mode anyway.
 */
export async function GET(request: Request) {
  const unauthorized = checkCronAuth(request);
  if (unauthorized) return unauthorized;

  const gotLock = await acquireScanLock(300);
  if (!gotLock) {
    return NextResponse.json({
      refreshed: false,
      reason: "scan already in progress",
      timestamp: new Date().toISOString(),
    });
  }

  try {
    const t0 = Date.now();
    const data = await runFullScan();
    await writeRevshareCache(jstr(data));
    return NextResponse.json({
      refreshed: true,
      elapsedMs: Date.now() - t0,
      wallets: data.contribRows.length,
      locks: data.locks.length,
      timestamp: new Date().toISOString(),
    });
  } catch (e) {
    await logEvent("warn", "revshare-refresh: scan failed, old cache keeps serving", {
      error: e instanceof Error ? e.message : String(e),
    }).catch(() => undefined);
    return NextResponse.json({
      refreshed: false,
      error: String((e as Error)?.message || e),
      timestamp: new Date().toISOString(),
    });
  } finally {
    await releaseScanLock();
  }
}
