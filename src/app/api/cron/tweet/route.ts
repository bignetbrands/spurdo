import { NextResponse } from "next/server";
import { checkCronAuth } from "@/lib/auth";
import { isKillSwitchActive, recordHeartbeat } from "@/lib/store";

export const maxDuration = 60;
export const dynamic = "force-dynamic";

/**
 * GET /api/cron/tweet
 *
 * M1 stub: records heartbeat, respects kill switch, returns 501 (not implemented).
 * M2/M3 will wire up the actual scheduler + executeTweet pipeline.
 */
export async function GET(request: Request) {
  const unauthorized = checkCronAuth(request);
  if (unauthorized) return unauthorized;

  if (await isKillSwitchActive()) {
    return NextResponse.json({
      posted: false,
      reason: "kill switch active",
      timestamp: new Date().toISOString(),
    });
  }

  await recordHeartbeat("cron:tweet");

  return NextResponse.json(
    {
      posted: false,
      reason: "M1 stub — posting pipeline lands in M2",
      timestamp: new Date().toISOString(),
    },
    { status: 501 }
  );
}
