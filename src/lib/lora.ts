import { fal } from "@fal-ai/client";
import { Redis } from "@upstash/redis";
import { kvKey, loadConfig } from "./config";

// ============================================================
// LORA REGISTRY + TRAINING
// ============================================================
// Manages the lifecycle of trained character/style LoRAs:
//   1. Submit a training job to Fal with a zipped image set
//   2. Track the job until it completes
//   3. Store the resulting LoRA URL in the registry
//   4. Pick one as "active" — image-gen.ts reads this at inference time
//
// Stack-aware: training endpoint is resolved from the project's
// genStack + stackConfig, so flux-photoreal projects train on FLUX
// and sdxl-stylized projects train on SDXL. Same UI, different
// endpoint, different LoRA artifact.
//
// All state lives in Upstash Redis (project-scoped):
//   ${PROJECT}:lora:active        → string (URL of active LoRA)
//   ${PROJECT}:lora:registry      → JSON array of LoraEntry
//   ${PROJECT}:lora:job:${id}     → JSON ActiveJob (in-flight or recent)
// ============================================================

export interface LoraEntry {
  id: string;
  url: string;
  trainedAt: string;
  notes?: string;
  trainingSetFilename?: string;
  trainingSteps?: number;
  /** Which gen stack produced this LoRA. Used to detect mismatches. */
  trainedForStack?: "flux-photoreal" | "sdxl-stylized";
  /** Which art style was selected at training time. Affects how the
   *  resulting LoRA behaves at inference (style preservation vs character). */
  artStyle?: "photorealistic" | "mspaint";
  active: boolean;
}

export interface ActiveJob {
  id: string;
  requestId: string;
  status: "submitting" | "queued" | "in_progress" | "completed" | "failed";
  submittedAt: string;
  completedAt?: string;
  imagesDataUrl?: string;
  trainingSteps: number;
  notes?: string;
  trainingSetFilename?: string;
  loraUrl?: string;
  error?: string;
  /** Which Fal endpoint this job was submitted to */
  trainingEndpoint?: string;
  /** Which gen stack the resulting LoRA is for */
  trainedForStack?: "flux-photoreal" | "sdxl-stylized";
  /** Art style picked for training */
  artStyle?: "photorealistic" | "mspaint";
  /**
   * Which trainer service handled this job. Affects how status polling
   * works (Fal has its own polling, Replicate has another). 'fal' is
   * the default for backward compatibility with existing jobs in KV.
   */
  trainer?: "fal" | "replicate";
}

// ────────── KV helpers ──────────

let _redis: Redis | null = null;
function r(): Redis {
  if (_redis) return _redis;
  const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) throw new Error("KV not configured");
  _redis = new Redis({ url, token });
  return _redis;
}

export async function getActiveLoraUrl(): Promise<string | null> {
  const v = await r().get<string>(kvKey("lora:active"));
  return v || null;
}

export async function setActiveLora(loraId: string | null): Promise<LoraEntry | null> {
  const reg = await getRegistry();
  const cleared = reg.map((e) => ({ ...e, active: false }));
  if (loraId === null) {
    await r().set(kvKey("lora:registry"), JSON.stringify(cleared));
    await r().del(kvKey("lora:active"));
    return null;
  }
  const target = cleared.find((e) => e.id === loraId);
  if (!target) throw new Error(`LoRA not found in registry: ${loraId}`);
  target.active = true;
  await r().set(kvKey("lora:registry"), JSON.stringify(cleared));
  await r().set(kvKey("lora:active"), target.url);
  return target;
}

export async function getRegistry(): Promise<LoraEntry[]> {
  const raw = await r().get<string | LoraEntry[]>(kvKey("lora:registry"));
  if (!raw) return [];
  if (typeof raw === "string") {
    try {
      return JSON.parse(raw) as LoraEntry[];
    } catch {
      return [];
    }
  }
  return raw;
}

export async function addToRegistry(entry: Omit<LoraEntry, "id" | "active">): Promise<LoraEntry> {
  const reg = await getRegistry();
  const id = `lora_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  const newEntry: LoraEntry = { ...entry, id, active: false };
  reg.unshift(newEntry); // newest first
  await r().set(kvKey("lora:registry"), JSON.stringify(reg));
  return newEntry;
}

export async function removeFromRegistry(loraId: string): Promise<void> {
  const reg = await getRegistry();
  const next = reg.filter((e) => e.id !== loraId);
  await r().set(kvKey("lora:registry"), JSON.stringify(next));
  // If this was the active one, clear active
  const active = await getActiveLoraUrl();
  const removed = reg.find((e) => e.id === loraId);
  if (removed && active === removed.url) {
    await r().del(kvKey("lora:active"));
  }
}

export async function updateNotes(loraId: string, notes: string): Promise<LoraEntry | null> {
  const reg = await getRegistry();
  const entry = reg.find((e) => e.id === loraId);
  if (!entry) return null;
  entry.notes = notes;
  await r().set(kvKey("lora:registry"), JSON.stringify(reg));
  return entry;
}

// ────────── Job tracking ──────────

export async function getJob(jobId: string): Promise<ActiveJob | null> {
  const v = await r().get<string | ActiveJob>(kvKey(`lora:job:${jobId}`));
  if (!v) return null;
  if (typeof v === "string") {
    try {
      return JSON.parse(v) as ActiveJob;
    } catch {
      return null;
    }
  }
  return v;
}

export async function saveJob(job: ActiveJob): Promise<void> {
  // Keep job records for 7 days after completion
  await r().set(kvKey(`lora:job:${job.id}`), JSON.stringify(job), { ex: 60 * 60 * 24 * 7 });
}

// ────────── Fal: configuration ──────────

let _falConfigured = false;
function ensureFalConfigured() {
  if (_falConfigured) return;
  const key = process.env.FAL_KEY;
  if (!key) throw new Error("FAL_KEY not set");
  fal.config({ credentials: key });
  _falConfigured = true;
}

// ────────── Fal: upload + submit + poll ──────────

/**
 * Upload a Buffer to Fal's storage and return a public URL.
 * Used for the training set zip.
 */
export async function uploadZipToFal(buf: Buffer, filename: string): Promise<string> {
  ensureFalConfigured();
  const blob = new Blob([new Uint8Array(buf)], { type: "application/zip" });
  const file = new File([blob], filename, { type: "application/zip" });
  const url = await fal.storage.upload(file);
  return url;
}

// ────────── Stack-aware endpoint resolution ──────────

/**
 * Returns the training endpoint for the active project's gen stack.
 * Stack defaults:
 *   flux-photoreal → fal-ai/flux-lora-fast-training (real, works)
 *   sdxl-stylized  → THROWS — Fal does not host an SDXL LoRA training
 *                    endpoint. Operators must train SDXL LoRAs externally
 *                    (Replicate, civitai trainer, fal-ai/flux-2-trainer if
 *                    switching to FLUX 2) and add the URL via a BYO flow.
 *   openai-only / bank-only → flux endpoint as a fallback
 *
 * Operators can override via stackConfig.trainingEndpoint per-project.
 */
export function resolveTrainingEndpoint(): { endpoint: string; trainedForStack: ActiveJob["trainedForStack"] } {
  const cfg = loadConfig();
  const stack = cfg.imagePrompts.genStack;
  const stackConfig = cfg.imagePrompts.stackConfig;

  if (stack === "sdxl-stylized") {
    // CHECK: only honor a custom training endpoint if the operator
    // explicitly set one in config (meaning they know about the limitation
    // and have an alternate trainer URL). Otherwise refuse to submit.
    if (stackConfig?.stack === "sdxl-stylized" && stackConfig.trainingEndpoint) {
      return { endpoint: stackConfig.trainingEndpoint, trainedForStack: "sdxl-stylized" };
    }
    throw new Error(
      "SDXL LoRA training isn't available on Fal. Train SDXL LoRAs externally (Replicate, civitai's trainer, or use fal-ai/flux-2-trainer if switching to FLUX 2) and add the URL via the LoRA registry directly. " +
      "Or switch this project's genStack to 'flux-photoreal' in config/${PROJECT}/image-prompts.json to train on Fal's FLUX endpoint instead."
    );
  }
  if (stack === "flux-photoreal") {
    const endpoint =
      (stackConfig?.stack === "flux-photoreal" && stackConfig.trainingEndpoint) ||
      "fal-ai/flux-lora-fast-training";
    return { endpoint, trainedForStack: "flux-photoreal" };
  }
  // For openai-only / bank-only, training isn't part of the workflow but
  // we still return a valid endpoint so the UI doesn't crash if invoked.
  return { endpoint: "fal-ai/flux-lora-fast-training", trainedForStack: "flux-photoreal" };
}

/**
 * Art style of the training set. Affects training params:
 *
 * - "photorealistic": is_style=false (treat as character LoRA — Fal's
 *   trainer will optimize for face/anatomy preservation). Defaults work
 *   well for portraits, polished illustrated characters, anything where
 *   the model SHOULD render as photoreal.
 *
 * - "mspaint": is_style=true (treat as style LoRA — trainer applies
 *   style-LoRA techniques: less attention to specific subjects, more
 *   to visual style/aesthetic). Combined with elevated step count to
 *   push the trained style harder. Output at inference still shows FLUX's
 *   photoreal bias to some degree — for fully amateur MS-Paint output,
 *   the bank approach (memedepot) remains the most reliable source.
 *
 * - "auto" (default): defer to the project's genStack:
 *     flux-photoreal → photorealistic
 *     sdxl-stylized   → mspaint
 *     bank-only / openai-only → photorealistic
 */
export type TrainingArtStyle = "photorealistic" | "mspaint" | "auto";

/**
 * Resolve "auto" to a concrete art style based on the project's gen stack.
 */
function resolveArtStyle(requested: TrainingArtStyle): "photorealistic" | "mspaint" {
  if (requested !== "auto") return requested;
  const cfg = loadConfig();
  if (cfg.imagePrompts.genStack === "sdxl-stylized") return "mspaint";
  return "photorealistic";
}

/**
 * Submit a LoRA training job to the active project's stack endpoint.
 * Returns the request_id. Caller should poll status via pollTrainingJob.
 *
 * Different endpoints accept different inputs — this function abstracts
 * those differences. The minimum every endpoint accepts:
 *   - images_data_url: zipped training set
 *   - steps: training step count
 */
export async function submitTrainingJob(
  imagesDataUrl: string,
  steps: number = 1000,
  artStyle: TrainingArtStyle = "auto"
): Promise<{ requestId: string; endpoint: string; trainedForStack: ActiveJob["trainedForStack"]; artStyleUsed: "photorealistic" | "mspaint" }> {
  ensureFalConfigured();
  const { endpoint, trainedForStack } = resolveTrainingEndpoint();
  const resolvedStyle = resolveArtStyle(artStyle);

  // Build the training payload. Stack and art style both influence params.
  // FLUX trainer params:
  //   - is_style: true → trainer treats this as a STYLE LoRA, optimizing
  //     for aesthetic capture rather than subject identity. Output LoRAs
  //     pull the model harder toward the trained look.
  //   - is_style: false → CHARACTER LoRA, focuses on face/anatomy
  //     preservation. Output LoRAs reproduce the trained subject reliably
  //     but inherit the base model's overall aesthetic.
  //   - For Spurdo (brown bear in MS Paint): is_style: true is closer
  //     to right because the AESTHETIC is the hard-to-capture part.
  //     The character is simple enough that style-mode learns it too.
  let input: Record<string, unknown>;
  if (trainedForStack === "sdxl-stylized") {
    // SDXL training isn't on Fal — this branch throws via resolveTrainingEndpoint.
    // Defensive: still build a valid payload in case operator points at a
    // custom SDXL trainer URL via stackConfig.trainingEndpoint.
    input = {
      images_data_url: imagesDataUrl,
      steps: resolvedStyle === "mspaint" ? Math.max(steps, 1500) : steps,
      learning_rate: resolvedStyle === "mspaint" ? 0.0005 : 0.0004,
    };
  } else {
    // FLUX (real, working trainer)
    input = {
      images_data_url: imagesDataUrl,
      // MS Paint style benefits from more training steps — the style is
      // visually farther from FLUX's defaults so it needs more iterations
      // to overcome the base model's bias.
      steps: resolvedStyle === "mspaint" ? Math.max(steps, 1400) : steps,
      create_masks: true,
      is_style: resolvedStyle === "mspaint",
    };
  }

  const submitted = await fal.queue.submit(endpoint as never, { input: input as never });
  return {
    requestId: submitted.request_id,
    endpoint,
    trainedForStack,
    artStyleUsed: resolvedStyle,
  };
}

/**
 * Check the current status of a training job. Endpoint-agnostic.
 * Returns one of "queued" | "in_progress" | "completed" | "failed",
 * plus the LoRA URL when complete.
 */
export async function pollTrainingJob(requestId: string, endpoint?: string): Promise<{
  status: ActiveJob["status"];
  loraUrl?: string;
  error?: string;
}> {
  ensureFalConfigured();
  // If endpoint not provided (legacy jobs), default to FLUX endpoint.
  const ep = endpoint || "fal-ai/flux-lora-fast-training";

  const rawStatus = (await fal.queue.status(ep as never, { requestId })) as { status: string };

  if (rawStatus.status === "IN_QUEUE") return { status: "queued" };
  if (rawStatus.status === "IN_PROGRESS") return { status: "in_progress" };

  if (rawStatus.status === "COMPLETED") {
    try {
      const result = await fal.queue.result(ep as never, { requestId });
      // Both FLUX and SDXL endpoints return the LoRA URL in different
      // fields. Normalize.
      const data = result.data as {
        diffusers_lora_file?: { url: string };
        lora?: { url: string };
        lora_file?: { url: string };
      };
      const url =
        data.diffusers_lora_file?.url || data.lora?.url || data.lora_file?.url;
      if (!url) return { status: "failed", error: "Training completed but no LoRA URL in result" };
      return { status: "completed", loraUrl: url };
    } catch (err) {
      return { status: "failed", error: err instanceof Error ? err.message : String(err) };
    }
  }
  return { status: "failed", error: `Fal returned status: ${rawStatus.status}` };
}
