import { fal } from "@fal-ai/client";
import { Redis } from "@upstash/redis";
import { kvKey } from "./config";

// ============================================================
// LORA REGISTRY + TRAINING
// ============================================================
// Manages the lifecycle of trained character LoRAs:
//   1. Submit a training job to Fal with a zipped image set
//   2. Track the job until it completes
//   3. Store the resulting LoRA URL in the registry
//   4. Pick one as "active" — image-gen.ts reads this at inference time
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

/**
 * Submit a FLUX LoRA fast training job. Returns the request_id.
 * Doesn't block — caller should poll status via pollTrainingJob.
 */
export async function submitTrainingJob(
  imagesDataUrl: string,
  steps: number = 1000
): Promise<string> {
  ensureFalConfigured();
  const submitted = await fal.queue.submit("fal-ai/flux-lora-fast-training", {
    input: {
      images_data_url: imagesDataUrl,
      steps,
      create_masks: true,
      is_style: false,
    },
  });
  return submitted.request_id;
}

/**
 * Check the current status of a training job.
 * Returns one of "queued" | "in_progress" | "completed" | "failed",
 * plus the LoRA URL when complete.
 */
export async function pollTrainingJob(requestId: string): Promise<{
  status: ActiveJob["status"];
  loraUrl?: string;
  error?: string;
}> {
  ensureFalConfigured();
  const rawStatus = (await fal.queue.status("fal-ai/flux-lora-fast-training", {
    requestId,
  })) as { status: string };

  if (rawStatus.status === "IN_QUEUE") {
    return { status: "queued" };
  }
  if (rawStatus.status === "IN_PROGRESS") {
    return { status: "in_progress" };
  }
  if (rawStatus.status === "COMPLETED") {
    // Job done — fetch the result for the LoRA URL
    try {
      const result = await fal.queue.result("fal-ai/flux-lora-fast-training", { requestId });
      const data = result.data as { diffusers_lora_file?: { url: string } };
      const url = data.diffusers_lora_file?.url;
      if (!url) return { status: "failed", error: "Training completed but no LoRA URL in result" };
      return { status: "completed", loraUrl: url };
    } catch (err) {
      return { status: "failed", error: err instanceof Error ? err.message : String(err) };
    }
  }
  // Anything else (e.g. CANCELLED, FAILED) — treat as failed
  return { status: "failed", error: `Fal returned status: ${rawStatus.status}` };
}
