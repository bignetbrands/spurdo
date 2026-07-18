import { NextResponse } from "next/server";
import { timingSafeEqual } from "crypto";

/** Constant-time string compare — length leak only, never content. */
function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

/**
 * Check the Authorization header against ADMIN_SECRET env var.
 * Returns null if authorized, or a 401 NextResponse if not.
 *
 * Pattern (matches ET):
 *   const unauthorized = checkAdminAuth(request);
 *   if (unauthorized) return unauthorized;
 */
export function checkAdminAuth(request: Request): NextResponse | null {
  const secret = process.env.ADMIN_SECRET;
  if (!secret) {
    return NextResponse.json(
      { error: "ADMIN_SECRET not configured on the server" },
      { status: 500 }
    );
  }
  const header = request.headers.get("authorization");
  if (!header || !safeEqual(header, `Bearer ${secret}`)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  return null;
}

/**
 * Same idea but for cron routes — checks CRON_SECRET.
 * Vercel sends this header automatically for scheduled invocations.
 */
export function checkCronAuth(request: Request): NextResponse | null {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    return NextResponse.json(
      { error: "CRON_SECRET not configured on the server" },
      { status: 500 }
    );
  }
  const header = request.headers.get("authorization");
  if (!header || !safeEqual(header, `Bearer ${secret}`)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  return null;
}
