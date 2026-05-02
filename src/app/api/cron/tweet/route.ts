import { NextResponse } from "next/server";
import { checkCronAuth } from "@/lib/auth";
import { recordHeartbeat } from "@/lib/store";
import { decideNext } from "@/lib/scheduler";
import { executeTweet } from "@/lib/orchestrator";
import { logEvent } from "@/lib/events";

export const maxDuration = 60;
export const dynamic = "force-dynamic";

/**
 * GET /api/cron/tweet
 *
 * Vercel Cron hits this every 30 minutes. Flow:
 *   1. Auth check (CRON_SECRET)
 *   2. Heartbeat to KV (so dashboard knows cron is alive)
 *   3. Ask scheduler: should we post right now?
 *      - If no: log skip with reason, return 200
 *      - If yes: call executeTweet → post → record
 *   4. Return JSON result
 *
 * Always returns 200 with a structured payload — even on errors.
 * Vercel retries 5xx responses, which we don't want for posts
 * (would risk double-posting the same content).
 */
export async function GET(request: Request) {
  const unauthorized = checkCronAuth(request);
  if (unauthorized) return unauthorized;

  await recordHeartbeat("cron:tweet");

  // ── Decide ──
  const decision = await decideNext();

  if (!decision.shouldPost) {
    await logEvent("cron", `skip: ${decision.reason}`, { meta: decision.meta });
    return NextResponse.json({
      posted: false,
      reason: decision.reason,
      meta: decision.meta,
      timestamp: new Date().toISOString(),
    });
  }

  // ── Execute ──
  if (!decision.pillar) {
    // Should be impossible given the scheduler contract, but guard anyway
    await logEvent("error", "scheduler said shouldPost but provided no pillar");
    return NextResponse.json({
      posted: false,
      reason: "scheduler error: shouldPost but no pillar",
      timestamp: new Date().toISOString(),
    });
  }

  const result = await executeTweet({ pillar: decision.pillar, trigger: "cron" });

  return NextResponse.json({
    posted: result.ok,
    tweetId: result.tweetId,
    url: result.url,
    text: result.text,
    hasImage: result.hasImage,
    pillar: result.pillar,
    dryRun: result.dryRun,
    error: result.error,
    elapsedMs: result.elapsedMs,
    timestamp: new Date().toISOString(),
  });
}
