import { NextResponse } from "next/server";
import { checkAdminAuth } from "@/lib/auth";
import { generateImage } from "@/lib/image-gen";
import type { PillarId } from "@/types";

export const dynamic = "force-dynamic";
export const maxDuration = 300; // up to 7 parallel SDXL calls, each ~30-60s

interface SweepRequest {
  /** "strength" → vary loraScale, hold guidance constant from config */
  /** "guidance" → vary guidance, hold loraScale at provided value */
  mode: "strength" | "guidance";
  /** Tweet text used to derive the scene (mimics real generation path) */
  tweetText: string;
  /** Pillar to use for scene resolution */
  pillarId: string;
  /** When mode=strength: leave undefined. When mode=guidance: pick a winning strength from prior sweep */
  fixedLoraScale?: number;
  /**
   * Seed to lock composition across variants. If unset, a random seed
   * is generated and reused for all variants. Returned in response so
   * operator can re-run with the same seed for repeatability.
   */
  seed?: number;
}

interface Variant {
  label: string;
  loraScale: number;
  guidanceScale: number;
}

const STRENGTH_SWEEP: number[] = [0.6, 0.7, 0.8, 0.9, 1.0, 1.1, 1.2];
const GUIDANCE_SWEEP: number[] = [4.5, 5.5, 6.5, 7.5];

/**
 * POST /api/admin/lora/calibrate
 *
 * Runs an N-variant sweep against the SDXL stack with the SAME prompt
 * and seed across variants — so the only thing that changes is the
 * tuning parameter. Operator picks the best variant by eye, then
 * locks the winning value into config/{project}/image-prompts.json.
 *
 * Costs: each variant is one Fal SDXL call (~$0.05-0.08). A 7-variant
 * strength sweep is ~$0.50. A 4-variant guidance sweep is ~$0.30.
 *
 * Run order:
 *   1. mode=strength (7 variants) → pick winning loraScale
 *   2. mode=guidance with fixedLoraScale=<winner> (4 variants) → pick winning guidance
 *   3. Lock both in image-prompts.json (defaultIdentityScale + guidanceScale)
 */
export async function POST(request: Request) {
  const unauthorized = checkAdminAuth(request);
  if (unauthorized) return unauthorized;

  let body: SweepRequest;
  try {
    body = (await request.json()) as SweepRequest;
  } catch {
    return NextResponse.json({ ok: false, error: "invalid JSON body" }, { status: 400 });
  }

  if (body.mode !== "strength" && body.mode !== "guidance") {
    return NextResponse.json(
      { ok: false, error: "mode must be 'strength' or 'guidance'" },
      { status: 400 }
    );
  }
  if (!body.tweetText?.trim() || !body.pillarId?.trim()) {
    return NextResponse.json(
      { ok: false, error: "tweetText and pillarId are required" },
      { status: 400 }
    );
  }
  if (body.mode === "guidance" && typeof body.fixedLoraScale !== "number") {
    return NextResponse.json(
      { ok: false, error: "guidance mode requires fixedLoraScale (the winning value from strength sweep)" },
      { status: 400 }
    );
  }

  // Lock seed across variants so we're comparing apples-to-apples
  const seed = body.seed ?? Math.floor(Math.random() * 1_000_000_000);

  // Build variant list
  const variants: Variant[] = [];
  if (body.mode === "strength") {
    for (const s of STRENGTH_SWEEP) {
      variants.push({ label: `strength=${s.toFixed(1)}`, loraScale: s, guidanceScale: 7.0 });
    }
  } else {
    for (const g of GUIDANCE_SWEEP) {
      variants.push({
        label: `guidance=${g.toFixed(1)}`,
        loraScale: body.fixedLoraScale!,
        guidanceScale: g,
      });
    }
  }

  // Run all variants in parallel — Fal handles concurrency, and the
  // route's maxDuration is 300s which is comfortable headroom.
  const startedAt = new Date().toISOString();
  const results = await Promise.allSettled(
    variants.map(async (v) => {
      const r = await generateImage({
        pillarId: body.pillarId as PillarId,
        tweetText: body.tweetText,
        provider: "fal",
        loraScale: v.loraScale,
        guidanceScaleOverride: v.guidanceScale,
        seed,
      });
      return {
        ...v,
        imageUrl: r.imageUrl,
        elapsedMs: r.elapsedMs,
        promptSent: r.promptSent,
      };
    })
  );

  const variantOutputs = results.map((r, i) => {
    if (r.status === "fulfilled") {
      return { ok: true as const, ...r.value };
    }
    return {
      ok: false as const,
      label: variants[i].label,
      loraScale: variants[i].loraScale,
      guidanceScale: variants[i].guidanceScale,
      error: r.reason instanceof Error ? r.reason.message : String(r.reason),
    };
  });

  return NextResponse.json({
    ok: true,
    mode: body.mode,
    seed,
    startedAt,
    finishedAt: new Date().toISOString(),
    variantCount: variants.length,
    successCount: variantOutputs.filter((v) => v.ok).length,
    variants: variantOutputs,
  });
}
