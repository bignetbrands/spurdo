import { fal } from "@fal-ai/client";
import OpenAI, { toFile } from "openai";
import fs from "fs";
import path from "path";
import { loadConfig } from "./config";
import { buildImagePrompt } from "./prompts";
import { generateImageScene } from "./claude";
import { getActiveLoraUrl } from "./lora";
import { assertImageBudget, recordImageSpend } from "./budget";
import { retryWithBackoff } from "./retry";
import { pickMemeForPillar } from "./meme-bank";
import { resolveStyleLoras } from "./style-loras";
import type { PillarId, GenStack, StackConfig, StackedLora } from "@/types";

// ============================================================
// IMAGE GENERATION — stack dispatcher
// ============================================================
// Three image SOURCES (provider):
//   • bank   — pull from memedepot, free, on-canon, no API
//   • fal    — invoke the project's configured genStack (FLUX or SDXL)
//   • openai — gpt-image-1 fallback
//
// When provider=fal, the actual pipeline is decided by the project's
// `genStack` declaration in image-prompts.json:
//   • flux-photoreal  → fal-ai/flux-lora (single LoRA, natural prompt)
//                       Best for: photoreal, polished illustration
//                       (what ET uses; what Spurdo originally tried)
//
//   • sdxl-stylized   → fal-ai/lora (SDXL base + stacked LoRAs, tag prompt)
//                       Best for: amateur/cartoon/MS-Paint/doodle styles
//                       (what Spurdo NOW uses — FLUX was wrong base model)
//
//   • openai-only     → routes provider=fal to OpenAI (degenerate case)
//   • bank-only       → routes provider=fal to bank (degenerate case)
//
// The dispatcher means each new project just declares its style at
// character-bible time and the right pipeline is selected. No code
// changes per project.
// ============================================================

export type ImageProvider = "fal" | "openai" | "bank";

export interface GenerateImageOptions {
  pillarId: PillarId;
  tweetText?: string;
  sceneOverride?: string;
  provider?: ImageProvider;
  /**
   * Identity LoRA URL override. If unset, resolves from active LoRA in
   * KV registry → SPURDO_LORA_URL env → none. Used only when the active
   * gen stack supports LoRAs (flux-photoreal, sdxl-stylized).
   */
  loraUrl?: string;
  /** Identity LoRA scale (0-2). Default depends on stack. */
  loraScale?: number;
}

export interface GenerateImageResult {
  imageUrl: string;
  provider: ImageProvider;
  /** Full prompt actually sent to the model (for debugging/logging) */
  promptSent: string;
  /** Negative prompt sent (SDXL) or empty (FLUX/OpenAI) */
  negativePromptSent?: string;
  /** Which gen stack ran (only set when provider=fal) */
  stackUsed?: GenStack;
  /** LoRAs that ended up attached, with scales — for audit */
  lorasUsed?: StackedLora[];
  elapsedMs: number;
}

/**
 * Generate (or fetch) an image. Routes to the right pipeline based on
 * project config + caller's provider preference.
 *
 * Throws BudgetExceededError if daily image cap hit (not for bank).
 */
export async function generateImage(opts: GenerateImageOptions): Promise<GenerateImageResult> {
  const cfg = loadConfig();
  const requested = opts.provider || (process.env.IMAGE_PROVIDER as ImageProvider) || "bank";

  // ── BANK: free, no budget, no API ──
  if (requested === "bank") {
    const startTime = Date.now();
    const meme = await pickMemeForPillar(opts.pillarId);
    if (!meme) {
      throw new Error(
        "meme bank is empty. upload memes at memedepot.com/d/spurdo (or set MEMEDEPOT_FALLBACK_IDS env), then click refresh in /bot."
      );
    }
    return {
      imageUrl: meme.rawUrl,
      provider: "bank",
      promptSent: `[bank] memedepot:${meme.id} (${meme.source}) · pillar=${opts.pillarId}`,
      elapsedMs: Date.now() - startTime,
    };
  }

  // ── OPENAI: direct route, no stack involvement ──
  if (requested === "openai") {
    await assertImageBudget();
    const sceneToUse = await resolveScene(opts);
    const built = buildImagePrompt(cfg, opts.pillarId, opts.tweetText || "", sceneToUse);
    const startTime = Date.now();
    const result = await generateViaOpenAI(built.prompt);
    await recordImageSpend(1).catch(() => undefined);
    return {
      ...result,
      promptSent: built.prompt,
      elapsedMs: Date.now() - startTime,
    };
  }

  // ── FAL: dispatch by configured gen stack ──
  await assertImageBudget();
  const sceneToUse = await resolveScene(opts);
  const built = buildImagePrompt(cfg, opts.pillarId, opts.tweetText || "", sceneToUse);
  const startTime = Date.now();

  // Resolve identity LoRA: explicit > registry > env > none
  let identityLoraUrl: string | null | undefined = opts.loraUrl;
  if (!identityLoraUrl) {
    try {
      identityLoraUrl = await getActiveLoraUrl();
    } catch {
      // KV unavailable — fall through to env
    }
  }
  if (!identityLoraUrl) identityLoraUrl = process.env.SPURDO_LORA_URL || null;

  const stack = cfg.imagePrompts.genStack;
  const stackConfig = cfg.imagePrompts.stackConfig;

  let result: { imageUrl: string; provider: ImageProvider; lorasUsed?: StackedLora[] };

  switch (stack) {
    case "flux-photoreal": {
      const cfgFlux = stackConfig?.stack === "flux-photoreal" ? stackConfig : null;
      result = await generateViaFlux({
        prompt: built.prompt,
        identityLoraUrl,
        identityScale: opts.loraScale ?? cfgFlux?.defaultLoraScale ?? 1.0,
        endpoint: cfgFlux?.inferenceEndpoint || "fal-ai/flux-lora",
        numInferenceSteps: cfgFlux?.numInferenceSteps ?? 28,
        guidanceScale: cfgFlux?.guidanceScale ?? 3.5,
      });
      break;
    }
    case "sdxl-stylized": {
      const cfgSdxl = stackConfig?.stack === "sdxl-stylized" ? stackConfig : null;
      // Style LoRAs: KV runtime override (if set) > config defaults > none
      const { loras: styleLoras } = await resolveStyleLoras();
      result = await generateViaSdxlStack({
        prompt: built.prompt,
        negativePrompt: built.negativePrompt,
        identityLoraUrl,
        identityScale: opts.loraScale ?? cfgSdxl?.defaultIdentityScale ?? 1.1,
        styleLoras,
        endpoint: cfgSdxl?.inferenceEndpoint || "fal-ai/lora",
        numInferenceSteps: cfgSdxl?.numInferenceSteps ?? 30,
        guidanceScale: cfgSdxl?.guidanceScale ?? 7.0,
      });
      break;
    }
    case "openai-only": {
      result = await generateViaOpenAI(built.prompt);
      break;
    }
    case "bank-only": {
      // Project disallows generation entirely. Re-route to bank.
      const meme = await pickMemeForPillar(opts.pillarId);
      if (!meme) throw new Error("project genStack is bank-only and the meme bank is empty.");
      result = { imageUrl: meme.rawUrl, provider: "bank" };
      break;
    }
    default: {
      const exhaustive: never = stack;
      throw new Error(`unsupported genStack: ${exhaustive}`);
    }
  }

  await recordImageSpend(1).catch(() => undefined);

  return {
    ...result,
    promptSent: built.prompt,
    negativePromptSent: built.negativePrompt || undefined,
    stackUsed: stack,
    elapsedMs: Date.now() - startTime,
  };
}

// ============================================================
// FAL CLIENT
// ============================================================

let _falConfigured = false;

function ensureFalConfigured() {
  if (_falConfigured) return;
  const key = process.env.FAL_KEY;
  if (!key) throw new Error("FAL_KEY not set");
  fal.config({ credentials: key });
  _falConfigured = true;
}

function isHttpsLoraUrl(u: string | null | undefined): u is string {
  return typeof u === "string" && /^https?:\/\//.test(u);
}

// ============================================================
// SCENE RESOLUTION
// ============================================================
// Materializes a scene description for the image prompt. Order of
// preference:
//   1. Explicit sceneOverride from caller (e.g. operator-supplied)
//   2. Claude haiku scene-from-tweet (when tweetText is provided)
//   3. undefined → buildImagePrompt falls back to scenesByPillar list
//      or generic flat background
//
// We call Claude here (not in buildImagePrompt) so the cost shows up in
// the image-gen path and gets tracked under image budget proxy via the
// token spend recorded in claude.ts.
// ============================================================

async function resolveScene(opts: { tweetText?: string; pillarId: PillarId; sceneOverride?: string }): Promise<string | undefined> {
  if (opts.sceneOverride && opts.sceneOverride.trim()) return opts.sceneOverride;
  if (!opts.tweetText || !opts.tweetText.trim()) return undefined; // let buildImagePrompt fall back to pillar list
  try {
    const scene = await generateImageScene({
      tweetText: opts.tweetText,
      pillarHint: opts.pillarId,
    });
    return scene;
  } catch (err) {
    console.warn("[image-gen] scene resolution failed, falling back to pillar list:", err);
    return undefined; // buildImagePrompt will pick from scenesByPillar
  }
}

// ============================================================
// FLUX-PHOTOREAL stack — fal-ai/flux-lora
// ============================================================

async function generateViaFlux(args: {
  prompt: string;
  identityLoraUrl: string | null | undefined;
  identityScale: number;
  endpoint: string;
  numInferenceSteps: number;
  guidanceScale: number;
}): Promise<{ imageUrl: string; provider: ImageProvider; lorasUsed: StackedLora[] }> {
  ensureFalConfigured();

  const lorasUsed: StackedLora[] = [];
  const input: Record<string, unknown> = {
    prompt: args.prompt,
    image_size: "square_hd",
    num_inference_steps: args.numInferenceSteps,
    guidance_scale: args.guidanceScale,
    num_images: 1,
    enable_safety_checker: true,
    output_format: "png",
  };

  if (isHttpsLoraUrl(args.identityLoraUrl)) {
    const lora: StackedLora = {
      url: args.identityLoraUrl,
      role: "identity",
      scale: args.identityScale,
      label: "active-identity",
    };
    input.loras = [{ path: lora.url, scale: lora.scale }];
    lorasUsed.push(lora);
  }

  const { result } = await retryWithBackoff(
    () =>
      // The endpoint identifier is configurable but fal's typed client uses
      // string-literal keys for its model registry. Cast via `as never` to
      // accept arbitrary endpoints (some projects override to alt FLUX hosts).
      fal.subscribe(args.endpoint as never, {
        input: input as never,
        logs: false,
      }),
    {
      maxAttempts: 3,
      initialDelayMs: 1500,
      onRetry: (attempt, err) =>
        console.warn(
          `[image-gen/flux] retry ${attempt} after:`,
          err instanceof Error ? err.message : err
        ),
    }
  );

  const data = (result as { data?: { images?: Array<{ url: string }> } }).data;
  const url = data?.images?.[0]?.url;
  if (!url) throw new Error("FLUX endpoint returned no image URL");
  return { imageUrl: url, provider: "fal", lorasUsed };
}

// ============================================================
// SDXL-STYLIZED stack — fal-ai/lora (SDXL base) with stacked LoRAs
// ============================================================

async function generateViaSdxlStack(args: {
  prompt: string;
  negativePrompt: string;
  identityLoraUrl: string | null | undefined;
  identityScale: number;
  styleLoras: StackedLora[];
  endpoint: string;
  numInferenceSteps: number;
  guidanceScale: number;
}): Promise<{ imageUrl: string; provider: ImageProvider; lorasUsed: StackedLora[] }> {
  ensureFalConfigured();

  // Build the LoRA stack: style LoRAs first (set the aesthetic), then identity
  // LoRA on top (locks the character). Order matters less than scales but
  // keeping a consistent order helps debugging.
  const lorasUsed: StackedLora[] = [];
  const triggerWords: string[] = [];

  for (const sl of args.styleLoras) {
    if (isHttpsLoraUrl(sl.url)) {
      lorasUsed.push({
        url: sl.url,
        role: "style",
        scale: sl.scale ?? 0.9,
        label: sl.label || "style",
        triggerWord: sl.triggerWord,
      });
      // Some LoRAs require a specific trigger token in the prompt. We
      // prepend any configured trigger words so the operator doesn't have
      // to remember to add them by hand.
      if (sl.triggerWord && !args.prompt.toLowerCase().includes(sl.triggerWord.toLowerCase())) {
        triggerWords.push(sl.triggerWord);
      }
    }
  }
  if (isHttpsLoraUrl(args.identityLoraUrl)) {
    lorasUsed.push({
      url: args.identityLoraUrl,
      role: "identity",
      scale: args.identityScale,
      label: "active-identity",
    });
  }

  // Construct final prompt: [trigger words], [original prompt]
  const finalPrompt =
    triggerWords.length > 0 ? `${triggerWords.join(", ")}, ${args.prompt}` : args.prompt;

  // If we have NO LoRAs at all on an SDXL stack, the output is going to be
  // generic SDXL — illustrated/anime by default. Still a meaningful step
  // up from FLUX for "amateur drawing" prompts but operator should know.
  if (lorasUsed.length === 0) {
    console.warn(
      "[image-gen/sdxl] no LoRAs attached — output will be base SDXL. Add a style LoRA via /bot or stackConfig.defaultStyleLoras + train an identity LoRA for best results."
    );
  }

  // fal-ai/lora payload shape: { model_name, prompt, loras: [{path, scale}], ... }
  // model_name is the base SDXL checkpoint. We default to base SDXL 1.0;
  // operators can override by setting SDXL_BASE_MODEL env (e.g., to point
  // at Pony Diffusion V6, JuggernautXL, etc).
  const baseModel = process.env.SDXL_BASE_MODEL || "stabilityai/stable-diffusion-xl-base-1.0";

  const input: Record<string, unknown> = {
    model_name: baseModel,
    prompt: finalPrompt,
    negative_prompt: args.negativePrompt,
    image_size: "square_hd",
    num_inference_steps: args.numInferenceSteps,
    guidance_scale: args.guidanceScale,
    num_images: 1,
    enable_safety_checker: true,
    output_format: "png",
    loras: lorasUsed.map((l) => ({ path: l.url, scale: l.scale ?? 1.0 })),
  };

  const { result } = await retryWithBackoff(
    () =>
      fal.subscribe(args.endpoint as never, {
        input: input as never,
        logs: false,
      }),
    {
      maxAttempts: 3,
      initialDelayMs: 1500,
      onRetry: (attempt, err) =>
        console.warn(
          `[image-gen/sdxl] retry ${attempt} after:`,
          err instanceof Error ? err.message : err
        ),
    }
  );

  const data = (result as { data?: { images?: Array<{ url: string }> } }).data;
  const url = data?.images?.[0]?.url;
  if (!url) throw new Error("SDXL endpoint returned no image URL");
  return { imageUrl: url, provider: "fal", lorasUsed };
}

// ============================================================
// OPENAI gpt-image-1
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

async function generateViaOpenAI(prompt: string): Promise<{ imageUrl: string; provider: ImageProvider }> {
  // Try to read the project's primary character image as a reference
  const referenceCandidates = ["character-reference.png", "spurdo.png"];
  let refBuffer: Buffer | null = null;
  let refName: string | null = null;
  for (const candidate of referenceCandidates) {
    try {
      const refPath = path.join(process.cwd(), "public", candidate);
      refBuffer = fs.readFileSync(refPath);
      refName = candidate;
      break;
    } catch {
      // try next
    }
  }

  if (refBuffer && refName) {
    const refFile = await toFile(refBuffer, refName, { type: "image/png" });
    const response = await (
      getOpenAI().images.edit as unknown as (args: unknown) => Promise<{
        data?: Array<{ b64_json?: string; url?: string }>;
      }>
    )({
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

  // No reference: plain generation
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

// Re-export types used by callers
export type { GenStack, StackConfig, StackedLora };
