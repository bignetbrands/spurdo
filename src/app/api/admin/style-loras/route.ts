import { NextResponse } from "next/server";
import { checkAdminAuth } from "@/lib/auth";
import {
  getRuntimeStyleLoras,
  setRuntimeStyleLoras,
  clearRuntimeStyleLoras,
  resolveStyleLoras,
} from "@/lib/style-loras";
import { loadConfig } from "@/lib/config";
import type { StackedLora } from "@/types";

export const dynamic = "force-dynamic";

/**
 * GET /api/admin/style-loras
 *
 * Returns:
 *   {
 *     ok: true,
 *     active: StackedLora[],
 *     source: "runtime" | "config",
 *     hasRuntimeOverride: boolean,
 *     configDefaults: StackedLora[],
 *     stackSupportsStyle: boolean,
 *     genStack: string
 *   }
 */
export async function GET(request: Request) {
  const unauthorized = checkAdminAuth(request);
  if (unauthorized) return unauthorized;

  try {
    const cfg = loadConfig();
    const sc = cfg.imagePrompts.stackConfig;
    const stackSupportsStyle = sc?.stack === "sdxl-stylized";
    const configDefaults = sc?.stack === "sdxl-stylized" ? sc.defaultStyleLoras ?? [] : [];

    const { loras: active, source } = await resolveStyleLoras();
    const runtime = await getRuntimeStyleLoras();

    return NextResponse.json({
      ok: true,
      active,
      source,
      hasRuntimeOverride: runtime !== null,
      configDefaults,
      stackSupportsStyle,
      genStack: cfg.imagePrompts.genStack,
    });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : String(err) },
      { status: 500 }
    );
  }
}

/**
 * POST /api/admin/style-loras
 * Body: { loras: StackedLora[] } — replaces the runtime override list
 *
 * Pass an empty array to disable all style LoRAs at runtime
 * (different from clearing the override which falls back to config defaults).
 */
export async function POST(request: Request) {
  const unauthorized = checkAdminAuth(request);
  if (unauthorized) return unauthorized;

  let body: { loras?: StackedLora[] };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ ok: false, error: "expected JSON body" }, { status: 400 });
  }

  if (!Array.isArray(body.loras)) {
    return NextResponse.json({ ok: false, error: "body must contain a 'loras' array" }, { status: 400 });
  }

  // Validate each entry
  const errors: string[] = [];
  for (let i = 0; i < body.loras.length; i++) {
    const l = body.loras[i];
    if (!l || typeof l.url !== "string" || !/^https?:\/\//.test(l.url)) {
      errors.push(`#${i}: missing or invalid 'url' (must start with https://)`);
    }
    if (l && l.role && l.role !== "style" && l.role !== "identity") {
      errors.push(`#${i}: 'role' must be 'style' or 'identity'`);
    }
    if (l && l.scale !== undefined && (typeof l.scale !== "number" || l.scale < 0 || l.scale > 2)) {
      errors.push(`#${i}: 'scale' must be a number between 0 and 2`);
    }
  }
  if (errors.length > 0) {
    return NextResponse.json({ ok: false, error: errors.join("; ") }, { status: 400 });
  }

  const normalized: StackedLora[] = body.loras.map((l) => ({
    url: l.url,
    role: l.role || "style",
    scale: l.scale ?? 0.9,
    label: l.label,
    triggerWord: l.triggerWord,
  }));

  try {
    await setRuntimeStyleLoras(normalized);
    return NextResponse.json({ ok: true, active: normalized, source: "runtime" });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : String(err) },
      { status: 500 }
    );
  }
}

/**
 * DELETE /api/admin/style-loras
 * Clears the runtime override entirely. Falls back to config defaults.
 */
export async function DELETE(request: Request) {
  const unauthorized = checkAdminAuth(request);
  if (unauthorized) return unauthorized;

  try {
    await clearRuntimeStyleLoras();
    const { loras, source } = await resolveStyleLoras();
    return NextResponse.json({ ok: true, active: loras, source });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : String(err) },
      { status: 500 }
    );
  }
}
