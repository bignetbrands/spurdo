import { fal } from "@fal-ai/client";
import OpenAI, { toFile } from "openai";
import fs from "fs";
import path from "path";
import { loadConfig } from "./config";
import { buildImagePrompt } from "./prompts";
import { getActiveLoraUrl } from "./lora";
import type { PillarId } from "@/types";

// ============================================================
// IMAGE GENERATION
// ============================================================
// Two providers, abstracted behind a single interface:
//
//   FAL (primary) — FLUX.1 [dev] with optional LoRA
//     • Cheap (~$0.025-0.05/image)
//     • Once we train the Spurdo LoRA in M2.5, character consistency
//       comes from the weights — no reference image needed
//     • Until LoRA is trained, falls back to FLUX base + visual canon
//       in the prompt (works but drifts)
//
//   OPENAI (fallback) — gpt-image-1 with reference image
//     • More expensive, slightly more flexible scene generation
//     • Used when Fal is down, or for special cases
//
// Provider selection:
//   IMAGE_PROVIDER env var: "fal" | "openai" | "auto" (default: auto = fal first)
// ============================================================

export type ImageProvider = "fal" | "openai";

export interface GenerateImageOptions {
  pillarId: PillarId;
  tweetText?: string;
  sceneOverride?: string;
  provider?: ImageProvider;
  /** When using Fal, a trained LoRA URL. Falls back to base FLUX if not given. */
  loraUrl?: string;
  /** Scale of the LoRA effect (0-2, default 1.0). Higher = stronger character lock. */
  loraScale?: number;
}

export interface GenerateImageResult {
  /** Either a public HTTPS URL (Fal) or a data URL (OpenAI gpt-image-1) */
  imageUrl: string;
  /** Provider that generated the image */
  provider: ImageProvider;
  /** Full prompt sent to the model (for debugging/logging) */
  promptSent: string;
  /** Approx generation time in ms */
  elapsedMs: number;
}

/**
 * Generate an image. Routes to the configured provider.
 */
export async function generateImage(
  opts: GenerateImageOptions
): Promise<GenerateImageResult> {
  const cfg = loadConfig();
  const requested = opts.provider || (process.env.IMAGE_PROVIDER as ImageProvider) || "fal";

  const fullPrompt = buildImagePrompt(cfg, opts.pillarId, opts.tweetText || "", opts.sceneOverride);
  const startTime = Date.now();

  if (requested === "fal") {
    // LoRA URL resolution priority:
    //   1. Explicit option passed in (caller override)
    //   2. Active LoRA from KV registry (set via /bot dashboard)
    //   3. SPURDO_LORA_URL env var (manual override)
    //   4. None — runs on FLUX base
    let loraUrl: string | null | undefined = opts.loraUrl;
    if (!loraUrl) {
      try {
        loraUrl = await getActiveLoraUrl();
      } catch {
        // KV unavailable — fall through to env var
      }
    }
    if (!loraUrl) loraUrl = process.env.SPURDO_LORA_URL || null;

    const result = await generateViaFal(fullPrompt, loraUrl, opts.loraScale ?? 1.0);
    return { ...result, promptSent: fullPrompt, elapsedMs: Date.now() - startTime };
  }

  // OpenAI fallback
  const result = await generateViaOpenAI(fullPrompt, cfg.imagePrompts.referenceImage);
  return { ...result, promptSent: fullPrompt, elapsedMs: Date.now() - startTime };
}

// ============================================================
// FAL — FLUX.1 [dev] with LoRA
// ============================================================

let _falConfigured = false;

function ensureFalConfigured() {
  if (_falConfigured) return;
  const key = process.env.FAL_KEY;
  if (!key) throw new Error("FAL_KEY not set");
  fal.config({ credentials: key });
  _falConfigured = true;
}

async function generateViaFal(
  prompt: string,
  loraUrl: string | null | undefined,
  loraScale: number
): Promise<{ imageUrl: string; provider: ImageProvider }> {
  ensureFalConfigured();

  // Only attach LoRA if it's a real URL (not just the reference image path placeholder)
  const looksLikeLoraUrl =
    typeof loraUrl === "string" && /^https?:\/\//.test(loraUrl) && /\.safetensors|\.bin|\/lora\//i.test(loraUrl);

  const input: Record<string, unknown> = {
    prompt,
    image_size: "square_hd", // 1024x1024
    num_inference_steps: 28,
    guidance_scale: 3.5,
    num_images: 1,
    enable_safety_checker: true,
    output_format: "png",
  };
  if (looksLikeLoraUrl) {
    input.loras = [{ path: loraUrl, scale: loraScale }];
  }

  const result = await fal.subscribe("fal-ai/flux-lora", {
    input: input as Parameters<typeof fal.subscribe<"fal-ai/flux-lora">>[1]["input"],
    logs: false,
  });
  const data = result.data as { images?: Array<{ url: string }> };
  const url = data.images?.[0]?.url;
  if (!url) throw new Error("Fal returned no image URL");
  return { imageUrl: url, provider: "fal" };
}

// ============================================================
// OPENAI — gpt-image-1 with reference image
// ============================================================

let _openai: OpenAI | null = null;

function getOpenAI(): OpenAI {
  if (!_openai) {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) throw new Error("OPENAI_API_KEY not set");
    _openai = new OpenAI({ apiKey });
  }
  return _openai;
}

async function generateViaOpenAI(
  prompt: string,
  referenceImageName: string
): Promise<{ imageUrl: string; provider: ImageProvider }> {
  // Try to read the reference image from /public — if it doesn't exist,
  // fall back to images.generate without a reference (DALL-E style).
  let refBuffer: Buffer | null = null;
  try {
    const refPath = path.join(process.cwd(), "public", referenceImageName);
    refBuffer = fs.readFileSync(refPath);
  } catch {
    // Reference image missing — generate without one
  }

  if (refBuffer) {
    const refFile = await toFile(refBuffer, referenceImageName, { type: "image/png" });
    const response = await (getOpenAI().images.edit as unknown as (args: unknown) => Promise<{
      data?: Array<{ b64_json?: string; url?: string }>;
    }>)({
      model: "gpt-image-1",
      image: refFile,
      prompt,
      n: 1,
      size: "1024x1024",
      quality: "medium",
    });
    const b64 = response.data?.[0]?.b64_json;
    const url = response.data?.[0]?.url;
    if (b64) return { imageUrl: `data:image/png;base64,${b64}`, provider: "openai" };
    if (url) return { imageUrl: url, provider: "openai" };
    throw new Error("OpenAI gpt-image-1 returned no image data");
  }

  // No reference: fall back to plain generation
  const response = await getOpenAI().images.generate({
    model: "gpt-image-1",
    prompt,
    n: 1,
    size: "1024x1024",
    quality: "medium",
  });
  const data = response.data as Array<{ b64_json?: string; url?: string }> | undefined;
  const b64 = data?.[0]?.b64_json;
  const url = data?.[0]?.url;
  if (b64) return { imageUrl: `data:image/png;base64,${b64}`, provider: "openai" };
  if (url) return { imageUrl: url, provider: "openai" };
  throw new Error("OpenAI gpt-image-1 returned no image data");
}
