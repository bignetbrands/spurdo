import { NextResponse } from "next/server";
import { checkAdminAuth } from "@/lib/auth";
import { loadConfig } from "@/lib/config";
import { generateTweet } from "@/lib/claude";
import { generateImage } from "@/lib/image-gen";
import { checkRateLimit } from "@/lib/rate-limit";
import { BudgetExceededError } from "@/lib/budget";
import type { PillarId } from "@/types";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

// Rate limit: 10 generates per minute, configurable via env
const GENERATE_PER_MINUTE = parseInt(process.env.GENERATE_RATE_PER_MINUTE || "10", 10);
const GENERATE_WINDOW_SECONDS = 60;

interface GenerateRequest {
  pillar: PillarId;
  generateImage?: boolean;
  imageProvider?: "fal" | "openai";
  sceneOverride?: string;
}

interface GenerateResponse {
  ok: true;
  tweet: {
    text: string;
    pillar: PillarId;
    model: string;
    tokensUsed: number;
    charCount: number;
  };
  image?: {
    url: string;
    provider: string;
    promptSent: string;
    elapsedMs: number;
  };
  imageError?: string;
  totalElapsedMs: number;
}

/**
 * POST /api/admin/generate
 *
 * Generate a tweet for a given pillar. Optionally also generate an image.
 *
 * Body:
 *   { pillar: "scene_vignettes", generateImage: true, imageProvider?: "fal" }
 *
 * Returns:
 *   { ok, tweet: { text, pillar, model, tokensUsed }, image?: { url, provider, ... } }
 */
export async function POST(request: Request) {
  const unauthorized = checkAdminAuth(request);
  if (unauthorized) return unauthorized;

  // Rate limit: prevent spend runaway from a stuck retry loop or leaked secret
  try {
    const limit = await checkRateLimit("generate:global", GENERATE_PER_MINUTE, GENERATE_WINDOW_SECONDS);
    if (!limit.allowed) {
      return NextResponse.json(
        {
          ok: false,
          error: `rate limit hit (${limit.count}/${limit.limit} per minute). retry in ${limit.retryAfterSeconds}s.`,
          retryAfterSeconds: limit.retryAfterSeconds,
        },
        { status: 429, headers: { "Retry-After": String(limit.retryAfterSeconds) } }
      );
    }
  } catch (err) {
    // Rate limit infra failure — fail open (better to allow than to lock out)
    console.warn("[generate] rate limit check failed, allowing through:", err);
  }

  let body: GenerateRequest;
  try {
    body = (await request.json()) as GenerateRequest;
  } catch {
    return NextResponse.json({ ok: false, error: "invalid JSON body" }, { status: 400 });
  }

  if (!body.pillar) {
    return NextResponse.json({ ok: false, error: "body.pillar is required" }, { status: 400 });
  }

  const cfg = loadConfig();
  if (!cfg.pillars.pillars[body.pillar]) {
    return NextResponse.json(
      { ok: false, error: `unknown pillar: ${body.pillar}. Valid: ${Object.keys(cfg.pillars.pillars).join(", ")}` },
      { status: 400 }
    );
  }

  const overallStart = Date.now();

  try {
    // 1) Generate tweet text
    const tweet = await generateTweet(body.pillar);

    const result: GenerateResponse = {
      ok: true,
      tweet: {
        text: tweet.text,
        pillar: tweet.pillar,
        model: tweet.model,
        tokensUsed: tweet.tokensUsed,
        charCount: tweet.text.length,
      },
      totalElapsedMs: 0,
    };

    // 2) Optionally generate image
    const pillarConfig = cfg.pillars.pillars[body.pillar];
    const shouldGenerateImage = body.generateImage ?? pillarConfig.generateImage;

    if (shouldGenerateImage) {
      try {
        const img = await generateImage({
          pillarId: body.pillar,
          tweetText: tweet.text,
          sceneOverride: body.sceneOverride,
          provider: body.imageProvider,
        });
        result.image = {
          url: img.imageUrl,
          provider: img.provider,
          promptSent: img.promptSent,
          elapsedMs: img.elapsedMs,
        };
      } catch (imgErr) {
        if (imgErr instanceof BudgetExceededError) {
          result.imageError = `image budget exceeded (${imgErr.used}/${imgErr.limit}). tweet text generated, image skipped.`;
        } else {
          result.imageError = imgErr instanceof Error ? imgErr.message : String(imgErr);
        }
      }
    }

    result.totalElapsedMs = Date.now() - overallStart;
    return NextResponse.json(result);
  } catch (err) {
    if (err instanceof BudgetExceededError) {
      return NextResponse.json(
        {
          ok: false,
          error: err.message,
          budgetExceeded: { resource: err.resource, used: err.used, limit: err.limit },
          totalElapsedMs: Date.now() - overallStart,
        },
        { status: 402 } // Payment Required
      );
    }
    console.error("[generate] error:", err);
    return NextResponse.json(
      {
        ok: false,
        error: err instanceof Error ? err.message : "unknown error",
        totalElapsedMs: Date.now() - overallStart,
      },
      { status: 500 }
    );
  }
}
