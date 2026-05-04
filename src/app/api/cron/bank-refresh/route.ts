import { NextResponse } from "next/server";
import { checkCronAuth } from "@/lib/auth";
import { refreshBank, getManifest } from "@/lib/meme-bank";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * GET /api/cron/bank-refresh
 *
 * Weekly job: re-scrapes memedepot to pick up newly-added memes.
 * Runs Mondays 06:00 UTC. Compares before/after counts so we know
 * if new memes landed.
 *
 * Returns 200 even on partial failure so Vercel doesn't auto-retry —
 * if the scrape failed, the next week's run will catch up.
 */
export async function GET(request: Request) {
  const unauthorized = checkCronAuth(request);
  if (unauthorized) return unauthorized;

  const startedAt = new Date().toISOString();

  try {
    // Capture current count before refresh so we know what changed
    const before = await getManifest().catch(() => null);
    const beforeCount = before?.scrapedCount ?? 0;

    const refreshed = await refreshBank();
    const delta = refreshed.scrapedCount - beforeCount;

    return NextResponse.json({
      ok: true,
      startedAt,
      finishedAt: new Date().toISOString(),
      beforeCount,
      afterCount: refreshed.scrapedCount,
      newMemes: delta,
      source: refreshed.source,
      hadError: !!refreshed.error,
      error: refreshed.error,
    });
  } catch (err) {
    return NextResponse.json(
      {
        ok: false,
        startedAt,
        finishedAt: new Date().toISOString(),
        error: err instanceof Error ? err.message : String(err),
      },
      { status: 200 } // 200 to prevent Vercel auto-retry; logged for ops review
    );
  }
}
