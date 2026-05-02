import { NextResponse } from "next/server";
import { checkCronAuth } from "@/lib/auth";
import { isKillSwitchActive, recordHeartbeat } from "@/lib/store";

export const maxDuration = 300;
export const dynamic = "force-dynamic";

/**
 * GET /api/cron/replies
 *
 * M1 stub: records heartbeat, respects kill switch, returns 501.
 * M3/M4 will wire up the actual reply engine.
 */
export async function GET(request: Request) {
  const unauthorized = checkCronAuth(request);
  if (unauthorized) return unauthorized;

  if (await isKillSwitchActive()) {
    return NextResponse.json({
      processed: 0,
      reason: "kill switch active",
      timestamp: new Date().toISOString(),
    });
  }

  await recordHeartbeat("cron:replies");

  return NextResponse.json(
    {
      processed: 0,
      reason: "M1 stub — reply engine lands in M3-M4",
      timestamp: new Date().toISOString(),
    },
    { status: 501 }
  );
}
