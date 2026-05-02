import { NextResponse } from "next/server";
import { checkAdminAuth } from "@/lib/auth";
import { getEvents } from "@/lib/events";

export const dynamic = "force-dynamic";

/**
 * GET /api/admin/events?limit=50
 *
 * Returns recent events from the persistent KV-backed log.
 * Newest first. Default limit 50, max 200.
 */
export async function GET(request: Request) {
  const unauthorized = checkAdminAuth(request);
  if (unauthorized) return unauthorized;

  const url = new URL(request.url);
  const limitParam = url.searchParams.get("limit");
  const limit = limitParam ? Math.min(200, Math.max(1, parseInt(limitParam, 10) || 50)) : 50;

  const events = await getEvents(limit);
  return NextResponse.json({ events, limit });
}
