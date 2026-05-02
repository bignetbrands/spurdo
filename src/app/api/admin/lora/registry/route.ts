import { NextResponse } from "next/server";
import { checkAdminAuth } from "@/lib/auth";
import {
  getRegistry,
  setActiveLora,
  removeFromRegistry,
  updateNotes,
  getActiveLoraUrl,
} from "@/lib/lora";

export const dynamic = "force-dynamic";

/**
 * GET /api/admin/lora/registry
 *   → returns the full registry + active URL
 *
 * POST /api/admin/lora/registry
 *   body: { action: "set_active", loraId: string }
 *       — promote a registry entry to active. image-gen.ts will pick this
 *         up on the very next image generation (no redeploy needed)
 *   body: { action: "clear_active" }
 *       — fall back to env var / no LoRA
 *   body: { action: "delete", loraId: string }
 *       — remove from registry. If it was active, also clears active.
 *   body: { action: "update_notes", loraId: string, notes: string }
 *       — change a registry entry's notes
 */
export async function GET(request: Request) {
  const unauthorized = checkAdminAuth(request);
  if (unauthorized) return unauthorized;

  const [registry, activeUrl] = await Promise.all([getRegistry(), getActiveLoraUrl()]);
  return NextResponse.json({ registry, activeUrl });
}

interface RegistryAction {
  action: "set_active" | "clear_active" | "delete" | "update_notes";
  loraId?: string;
  notes?: string;
}

export async function POST(request: Request) {
  const unauthorized = checkAdminAuth(request);
  if (unauthorized) return unauthorized;

  let body: RegistryAction;
  try {
    body = (await request.json()) as RegistryAction;
  } catch {
    return NextResponse.json({ ok: false, error: "invalid JSON body" }, { status: 400 });
  }

  try {
    switch (body.action) {
      case "set_active": {
        if (!body.loraId) return NextResponse.json({ ok: false, error: "loraId required" }, { status: 400 });
        const result = await setActiveLora(body.loraId);
        return NextResponse.json({ ok: true, active: result });
      }
      case "clear_active": {
        await setActiveLora(null);
        return NextResponse.json({ ok: true, active: null });
      }
      case "delete": {
        if (!body.loraId) return NextResponse.json({ ok: false, error: "loraId required" }, { status: 400 });
        await removeFromRegistry(body.loraId);
        return NextResponse.json({ ok: true, deleted: body.loraId });
      }
      case "update_notes": {
        if (!body.loraId || typeof body.notes !== "string") {
          return NextResponse.json({ ok: false, error: "loraId and notes required" }, { status: 400 });
        }
        const result = await updateNotes(body.loraId, body.notes);
        return NextResponse.json({ ok: true, entry: result });
      }
      default:
        return NextResponse.json({ ok: false, error: `unknown action: ${body.action}` }, { status: 400 });
    }
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : "unknown error" },
      { status: 500 }
    );
  }
}
