import { NextResponse } from "next/server";
import { checkAdminAuth } from "@/lib/auth";
import { isKillSwitchActive, setKillSwitch } from "@/lib/store";

export const dynamic = "force-dynamic";

/**
 * GET /api/admin/kill-switch — read current state
 * POST /api/admin/kill-switch — body: { active: boolean }
 */
export async function GET(request: Request) {
  const unauthorized = checkAdminAuth(request);
  if (unauthorized) return unauthorized;
  const active = await isKillSwitchActive();
  return NextResponse.json({ active });
}

export async function POST(request: Request) {
  const unauthorized = checkAdminAuth(request);
  if (unauthorized) return unauthorized;

  let body: { active?: boolean };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  if (typeof body.active !== "boolean") {
    return NextResponse.json({ error: "body must include active: boolean" }, { status: 400 });
  }

  await setKillSwitch(body.active);
  return NextResponse.json({ active: body.active });
}
