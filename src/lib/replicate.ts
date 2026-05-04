import Replicate from "replicate";
import type { TrainingArtStyle } from "./lora";

// ============================================================
// REPLICATE TRAINING API CLIENT
// ============================================================
// Wraps the Replicate API for SDXL LoRA training. The whole point of this
// module is that operators NEVER touch Replicate's UI — we drive their
// training programmatically from the /bot dashboard.
//
// Two-call lifecycle:
//   1. submitTraining(): POST /trainings, returns training_id
//   2. pollTraining(id): GET /trainings/{id}, returns status + (when
//                        done) the permanent weights URL
//
// The weights URL Replicate returns is permanent and Fal can fetch it
// directly — no rehosting needed.
// ============================================================

let _replicate: Replicate | null = null;

function getReplicate(): Replicate {
  if (!_replicate) {
    const token = process.env.REPLICATE_API_TOKEN;
    if (!token) {
      throw new Error(
        "REPLICATE_API_TOKEN env var is not set. Add it in Vercel project settings."
      );
    }
    _replicate = new Replicate({ auth: token });
  }
  return _replicate;
}

/**
 * The SDXL LoRA trainer model on Replicate. This is the version pinned
 * for stability — same version we used in the manual run. If Replicate
 * deprecates this version, swap it out here.
 *
 * Format: "owner/model:version_hash"
 */
const SDXL_TRAINER_VERSION =
  "stability-ai/sdxl:7762fd07cf82c948538e41f63f77d685e02b063e37e496e96eefd46c929f9bdc";

/**
 * Submit a training job to Replicate.
 *
 * Inputs:
 *   - imagesZipUrl: a publicly fetchable URL to a .zip of training images.
 *     The URL must be reachable from Replicate's servers. We upload to
 *     Replicate's own Files API first (see uploadTrainingZip below) so
 *     this URL is always valid.
 *   - destinationModel: in form "owner/model-name" — Replicate creates a
 *     new version of this model when training succeeds.
 *   - artStyle: photorealistic vs mspaint (affects step count/params)
 *
 * Returns the training ID — caller polls with pollTraining().
 */
export async function submitReplicateTraining(opts: {
  imagesZipUrl: string;
  destinationModel: string;
  artStyle: TrainingArtStyle;
  steps?: number;
  triggerWord?: string;
}): Promise<{ id: string; status: string; webUrl: string }> {
  const replicate = getReplicate();

  // Style-aware tuning (mirrors the Fal trainer logic but adapted for Replicate's params)
  const isMspaint = opts.artStyle === "mspaint";
  const baseSteps = opts.steps ?? 1500;
  const trainingSteps = isMspaint ? Math.max(baseSteps, 1500) : baseSteps;
  const trigger = opts.triggerWord || "TOK";

  // Replicate's stability-ai/sdxl trainer accepts these params (verified
  // from the same form we filled manually earlier in development).
  const input: Record<string, unknown> = {
    input_images: opts.imagesZipUrl,
    token_string: trigger,
    caption_prefix: `a photo of ${trigger}`,
    max_train_steps: trainingSteps,
    use_face_detection_instead: false,
  };

  // The training endpoint requires owner/model:version split out:
  const [modelOwner, modelRest] = SDXL_TRAINER_VERSION.split("/");
  const [modelName, versionHash] = modelRest.split(":");

  const training = await replicate.trainings.create(modelOwner, modelName, versionHash, {
    destination: opts.destinationModel as `${string}/${string}`,
    input,
  });

  return {
    id: training.id,
    status: training.status,
    webUrl: training.urls?.get?.replace("/api.", "/").replace("/v1/trainings/", "/p/") || "",
  };
}

/**
 * Poll a training. Returns the current status and, when status is
 * "succeeded", the permanent weights URL.
 */
export async function pollReplicateTraining(trainingId: string): Promise<{
  id: string;
  status: "starting" | "processing" | "succeeded" | "failed" | "canceled";
  weightsUrl?: string;
  error?: string;
  logs?: string;
}> {
  const replicate = getReplicate();
  const t = await replicate.trainings.get(trainingId);

  type TrainingOutput = { weights?: string; version?: string };
  const output = (t.output ?? null) as TrainingOutput | null;

  return {
    id: t.id,
    status: t.status as "starting" | "processing" | "succeeded" | "failed" | "canceled",
    weightsUrl: output?.weights || undefined,
    error: t.error ? String(t.error) : undefined,
    logs: t.logs || undefined,
  };
}

/**
 * Upload a training zip to Replicate's Files API, returns a URL Replicate
 * itself can fetch. Replicate's files expire after 24h but training reads
 * them within seconds of creation, so that's fine.
 *
 * Why upload there instead of e.g. our own Vercel blob: training data
 * staying within Replicate's network avoids egress complications and
 * makes the URL guaranteed-fetchable from their workers.
 */
export async function uploadTrainingZipToReplicate(
  zipBuffer: Buffer | Uint8Array,
  filename: string = "training-images.zip"
): Promise<string> {
  const replicate = getReplicate();
  // The SDK's files.create accepts a File-like object
  const blob = new Blob([new Uint8Array(zipBuffer)], { type: "application/zip" });
  const file = new File([blob], filename, { type: "application/zip" });
  const uploaded = await replicate.files.create(file);

  // The 'urls.get' field is the URL we hand to the trainer
  const url = uploaded.urls?.get;
  if (!url) {
    throw new Error("Replicate file upload returned no URL");
  }
  return url;
}

/**
 * Ensure a destination model exists on Replicate (the place where the
 * trained version will land). If it doesn't exist, create it.
 *
 * Replicate's training requires the destination to exist beforehand.
 * For our SaaS UX we want to create it transparently per-project on
 * first training attempt.
 */
export async function ensureDestinationModel(opts: {
  owner: string;
  modelName: string;
  description?: string;
}): Promise<string> {
  const replicate = getReplicate();
  const fullName = `${opts.owner}/${opts.modelName}`;

  // Check if it already exists
  try {
    await replicate.models.get(opts.owner, opts.modelName);
    return fullName;
  } catch (err) {
    // 404 means doesn't exist; any other error we re-throw
    const e = err as { response?: { status?: number }; status?: number };
    const status = e.response?.status ?? e.status;
    if (status !== 404) throw err;
  }

  // Create it as a private model
  await replicate.models.create(opts.owner, opts.modelName, {
    visibility: "private",
    hardware: "gpu-l40s",
    description: opts.description || `LoRA trained for ${opts.modelName}`,
  });

  return fullName;
}
