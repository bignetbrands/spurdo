import { NextResponse } from "next/server";
import { checkAdminAuth } from "@/lib/auth";
import { executeTweet } from "@/lib/orchestrator";
import { loadConfig } from "@/lib/config";
import { checkRateLimit } from "@/lib/rate-limit";
import type { PillarId } from "@/types";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

// Tighter rate limit on posting than on generating —
// you should be deliberate about pushing live tweets.
const POST_NOW_PER_MINUTE = 5;

interface PostNowRequest {
  pillar: PillarId;
  text: string;
  imageUrl?: string;
  imageProvider?: string; // recorded for log purposes
}

// X / Twitter image size cap is 5 MB. Data URLs encode in base64 which adds
// ~33% overhead — so 5 MB of raw bytes is ~6.7 MB of data URL string.
// We reject anything over 5 MB raw to be safe.
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

function dataUrlByteLength(dataUrl: string): number {
  const commaIdx = dataUrl.indexOf(",");
  if (commaIdx === -1) return dataUrl.length;
  const b64 = dataUrl.slice(commaIdx + 1);
  // base64 decoded length: every 4 chars → 3 bytes (minus padding)
  const padding = (b64.endsWith("==") ? 2 : b64.endsWith("=") ? 1 : 0);
  return Math.floor((b64.length * 3) / 4) - padding;
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

  // For uploaded custom images (data URLs), enforce X's 5MB raw size cap.
  // Reject early — uploading a 20 MB photo to X just gets it rejected by their API
  // with a confusing error; better to fail fast here with a clear message.
  if (body.imageUrl && body.imageUrl.startsWith("data:")) {
    const bytes = dataUrlByteLength(body.imageUrl);
    if (bytes > MAX_IMAGE_BYTES) {
      const mb = (bytes / 1024 / 1024).toFixed(1);
      return NextResponse.json(
        {
          ok: false,
          error: `uploaded image is ${mb} MB — X's max is 5 MB. resize/compress before uploading (jpg quality 85 usually fits, or 1024x1024 png).`,
        },
        { status: 413 }
      );
    }
    // Validate it's a known image type
    if (!/^data:image\/(png|jpeg|jpg|gif|webp);base64,/i.test(body.imageUrl)) {
      return NextResponse.json(
        { ok: false, error: "uploaded image must be png, jpg, gif, or webp (base64 data URL)" },
        { status: 400 }
      );
    }
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
