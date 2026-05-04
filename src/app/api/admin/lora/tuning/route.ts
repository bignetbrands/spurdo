import { NextResponse } from "next/server";
import { checkAdminAuth } from "@/lib/auth";
import {
  getSdxlTuning,
  setSdxlTuning,
  clearSdxlTuning,
} from "@/lib/sdxl-tuning";

export const dynamic = "force-dynamic";

/**
 * GET  /api/admin/lora/tuning  → current tuning (or null)
 * POST /api/admin/lora/tuning  → set { loraScale, guidanceScale, notes? }
 * DEL  /api/admin/lora/tuning  → clear (revert to config defaults)
 *
 * Lock in the winners from the calibration sweep here. Once saved,
 * every SDXL generation (autonomous + COMPOSE) uses these values.
 */
export async function GET(request: Request) {
  const unauthorized = checkAdminAuth(request);
  if (unauthorized) return unauthorized;
  const tuning = await getSdxlTuning();
  return NextResponse.json({ ok: true, tuning });
}

export async function POST(request: Request) {
  const unauthorized = checkAdminAuth(request);
  if (unauthorized) return unauthorized;

  let body: { loraScale?: number; guidanceScale?: number; notes?: string; autoRefine?: boolean };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ ok: false, error: "invalid JSON" }, { status: 400 });
  }
  const { loraScale, guidanceScale, notes, autoRefine } = body;
  if (typeof loraScale !== "number" || loraScale < 0 || loraScale > 2) {
    return NextResponse.json(
      { ok: false, error: "loraScale must be a number between 0 and 2" },
      { status: 400 }
    );
  }
  if (typeof guidanceScale !== "number" || guidanceScale < 0 || guidanceScale > 20) {
    return NextResponse.json(
      { ok: false, error: "guidanceScale must be a number between 0 and 20" },
      { status: 400 }
    );
  }

  const tuning = {
    loraScale,
    guidanceScale,
    setAt: new Date().toISOString(),
    notes: notes?.trim() || undefined,
    autoRefine: autoRefine === true,
  };
  await setSdxlTuning(tuning);
  return NextResponse.json({ ok: true, tuning });
}

export async function DELETE(request: Request) {
  const unauthorized = checkAdminAuth(request);
  if (unauthorized) return unauthorized;
  await clearSdxlTuning();
  return NextResponse.json({ ok: true, cleared: true });
}
