import { NextResponse } from "next/server";
import { checkAdminAuth } from "@/lib/auth";
import { executeTweet } from "@/lib/orchestrator";
import { loadConfig } from "@/lib/config";
import { checkRateLimit } from "@/lib/rate-limit";
import type { PillarId } from "@/types";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

// Tighter rate limit on posting than on generating —
// you should be deliberate about pushing live tweets.
const POST_NOW_PER_MINUTE = 5;

interface PostNowRequest {
  pillar: PillarId;
  text: string;
  imageUrl?: string;
  imageProvider?: string; // recorded for log purposes
}

/**
 * POST /api/admin/post-now
 *
 * Manual override that posts an already-composed tweet directly.
 * Used by the COMPOSE panel's "post this" button after operator
 * has reviewed a generated preview.
 *
 * Skips Claude (text provided) and image gen (URL provided).
 * Still goes through the full orchestrator → record + log path.
 */
export async function POST(request: Request) {
  const unauthorized = checkAdminAuth(request);
  if (unauthorized) return unauthorized;

  // Rate limit (per minute) — fail open if KV down
  try {
    const rl = await checkRateLimit("post-now:global", POST_NOW_PER_MINUTE, 60);
    if (!rl.allowed) {
      return NextResponse.json(
        {
          ok: false,
          error: `rate limit hit (${rl.count}/${rl.limit} per minute). retry in ${rl.retryAfterSeconds}s.`,
          retryAfterSeconds: rl.retryAfterSeconds,
        },
        { status: 429, headers: { "Retry-After": String(rl.retryAfterSeconds) } }
      );
    }
  } catch (err) {
    console.warn("[post-now] rate limit check failed, allowing through:", err);
  }

  let body: PostNowRequest;
  try {
    body = (await request.json()) as PostNowRequest;
  } catch {
    return NextResponse.json({ ok: false, error: "invalid JSON body" }, { status: 400 });
  }

  if (!body.pillar) {
    return NextResponse.json({ ok: false, error: "body.pillar is required" }, { status: 400 });
  }
  if (!body.text || !body.text.trim()) {
    return NextResponse.json({ ok: false, error: "body.text is required and non-empty" }, { status: 400 });
  }

  const cfg = loadConfig();
  if (!cfg.pillars.pillars[body.pillar]) {
    return NextResponse.json({ ok: false, error: `unknown pillar: ${body.pillar}` }, { status: 400 });
  }

  const result = await executeTweet({
    pillar: body.pillar,
    textOverride: body.text,
    imageUrlOverride: body.imageUrl,
    trigger: "manual",
  });

  if (!result.ok) {
    return NextResponse.json(result, { status: result.budgetExceeded ? 402 : 500 });
  }

  return NextResponse.json(result);
}
