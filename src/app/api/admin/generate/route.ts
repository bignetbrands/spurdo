import { NextResponse } from "next/server";
import { checkAdminAuth } from "@/lib/auth";
import { loadConfig } from "@/lib/config";
import { generateTweet } from "@/lib/claude";
import { generateImage } from "@/lib/image-gen";
import type { PillarId } from "@/types";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

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
        // Don't fail the whole request — return tweet without image, log error
        result.imageError = imgErr instanceof Error ? imgErr.message : String(imgErr);
      }
    }

    result.totalElapsedMs = Date.now() - overallStart;
    return NextResponse.json(result);
  } catch (err) {
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
