import { NextResponse } from "next/server";
import JSZip from "jszip";
import { checkAdminAuth } from "@/lib/auth";
import { uploadZipToFal, submitTrainingJob, saveJob } from "@/lib/lora";
import type { ActiveJob } from "@/lib/lora";
import {
  submitReplicateTraining,
  uploadTrainingZipToReplicate,
  ensureDestinationModel,
} from "@/lib/replicate";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const MAX_TOTAL_BYTES = 100 * 1024 * 1024; // 100 MB cap on aggregate upload
const MAX_FILES = 30;
const MIN_FILES = 5;
const DEFAULT_STEPS = 1000;
const ALLOWED_IMAGE_TYPES = ["image/png", "image/jpeg", "image/jpg", "image/webp"];
const ALLOWED_EXT = /\.(png|jpe?g|webp)$/i;

/**
 * POST /api/admin/lora/train
 *
 * Accepts multipart/form-data:
 *   • images: File[]   ← preferred, multiple image files
 *   • zip: File        ← legacy, single .zip with images inside
 *   • steps: string    ← optional, default 1000, clamped 100-5000
 *   • notes: string    ← optional, free-text
 *
 * When given multiple images, builds a zip server-side then submits.
 * Validates: at least 5 files, no more than 30, total under 100MB,
 * file types limited to png/jpg/webp.
 *
 * Returns: { jobId, requestId, status }
 */
export async function POST(request: Request) {
  const unauthorized = checkAdminAuth(request);
  if (unauthorized) return unauthorized;

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return NextResponse.json({ ok: false, error: "expected multipart/form-data" }, { status: 400 });
  }

  // Parse steps + notes (shared between paths)
  const stepsRaw = form.get("steps");
  let steps = DEFAULT_STEPS;
  if (typeof stepsRaw === "string" && stepsRaw.trim()) {
    const n = parseInt(stepsRaw, 10);
    if (Number.isFinite(n) && n >= 100 && n <= 5000) steps = n;
  }
  const notes = typeof form.get("notes") === "string" ? (form.get("notes") as string) : undefined;

  // Parse art style — operator picks photorealistic vs mspaint, default 'auto'
  // (which resolves to project's gen stack default).
  const artStyleRaw = form.get("artStyle");
  let artStyle: "photorealistic" | "mspaint" | "auto" = "auto";
  if (typeof artStyleRaw === "string") {
    const v = artStyleRaw.trim().toLowerCase();
    if (v === "photorealistic" || v === "mspaint" || v === "auto") {
      artStyle = v;
    }
  }

  // ── Determine input mode: images[] or zip ──
  const images = form.getAll("images").filter((v): v is File => v instanceof File && v.size > 0);
  const zipEntry = form.get("zip");
  const zipFile = zipEntry instanceof File && zipEntry.size > 0 ? zipEntry : null;

  let zipBuffer: Buffer;
  let originalFilename: string;

  if (images.length > 0) {
    // ── Multi-image path ──
    if (images.length < MIN_FILES) {
      return NextResponse.json(
        { ok: false, error: `at least ${MIN_FILES} images required (got ${images.length})` },
        { status: 400 }
      );
    }
    if (images.length > MAX_FILES) {
      return NextResponse.json(
        { ok: false, error: `at most ${MAX_FILES} images allowed (got ${images.length})` },
        { status: 400 }
      );
    }

    // Validate types + sum sizes
    const rejected: string[] = [];
    let totalBytes = 0;
    for (const f of images) {
      if (!ALLOWED_IMAGE_TYPES.includes(f.type) && !ALLOWED_EXT.test(f.name)) {
        rejected.push(`${f.name} (type ${f.type || "unknown"})`);
      }
      totalBytes += f.size;
    }
    if (rejected.length > 0) {
      return NextResponse.json(
        { ok: false, error: `unsupported image type(s): ${rejected.join(", ")}. allowed: png, jpg, jpeg, webp.` },
        { status: 400 }
      );
    }
    if (totalBytes > MAX_TOTAL_BYTES) {
      return NextResponse.json(
        {
          ok: false,
          error: `total upload too large (${Math.round(totalBytes / 1024 / 1024)} MB, max ${MAX_TOTAL_BYTES / 1024 / 1024} MB). resize images to ~1024x1024 before training.`,
        },
        { status: 400 }
      );
    }

    // Build zip server-side
    try {
      const zip = new JSZip();
      // Sanitize filenames (strip paths, keep extension)
      const usedNames = new Set<string>();
      for (let i = 0; i < images.length; i++) {
        const f = images[i];
        let name = f.name.split(/[\\/]/).pop() || `image-${i + 1}.png`;
        // Force unique names if duplicates
        if (usedNames.has(name)) {
          const m = name.match(/^(.+?)(\.[^.]+)?$/);
          name = `${m?.[1] || "image"}-${i + 1}${m?.[2] || ".png"}`;
        }
        usedNames.add(name);
        const buf = Buffer.from(await f.arrayBuffer());
        zip.file(name, buf);
      }
      zipBuffer = await zip.generateAsync({ type: "nodebuffer", compression: "STORE" });
      originalFilename = `training-set-${images.length}-images-${Date.now()}.zip`;
    } catch (err) {
      return NextResponse.json(
        { ok: false, error: `zip build failed: ${err instanceof Error ? err.message : err}` },
        { status: 500 }
      );
    }
  } else if (zipFile) {
    // ── Legacy zip path (kept for backward compatibility) ──
    if (!zipFile.name.toLowerCase().endsWith(".zip")) {
      return NextResponse.json({ ok: false, error: "file must be a .zip archive" }, { status: 400 });
    }
    if (zipFile.size > MAX_TOTAL_BYTES) {
      return NextResponse.json(
        { ok: false, error: `zip is too large (${zipFile.size} bytes, max ${MAX_TOTAL_BYTES})` },
        { status: 400 }
      );
    }
    if (zipFile.size === 0) {
      return NextResponse.json({ ok: false, error: "zip is empty" }, { status: 400 });
    }
    zipBuffer = Buffer.from(await zipFile.arrayBuffer());
    originalFilename = zipFile.name;
  } else {
    return NextResponse.json(
      { ok: false, error: `no images uploaded. send 'images' (multiple files) or 'zip' (single .zip).` },
      { status: 400 }
    );
  }

  // ============================================================
  // DISPATCH: Replicate (SDXL) for mspaint, Fal (FLUX) for photoreal
  // ============================================================
  // The training backend depends on the art style. SDXL handles amateur/
  // crude art styles much better than FLUX, but Fal doesn't host SDXL
  // training — so we route mspaint jobs to Replicate's API.
  // ============================================================

  // Resolve "auto" → concrete style based on project genStack (matches lora.ts)
  let resolvedArtStyle: "photorealistic" | "mspaint";
  if (artStyle === "auto") {
    // Default to mspaint for SaaS; this is the harder case and the one
    // operators with stylized projects need
    resolvedArtStyle = "mspaint";
  } else {
    resolvedArtStyle = artStyle;
  }

  const useReplicate = resolvedArtStyle === "mspaint";

  if (useReplicate) {
    // ── Replicate path (SDXL training) ──

    // Replicate requires a destination model on the user's account. We
    // derive owner/project-name from env. The owner is fixed per
    // deployment (the GitHub/Vercel org) and the model name is per
    // project so different projects have separate trained models.
    const replicateOwner = process.env.REPLICATE_OWNER;
    if (!replicateOwner) {
      return NextResponse.json(
        {
          ok: false,
          error: "REPLICATE_OWNER env var not set. Add it in Vercel project settings (your Replicate username/org).",
        },
        { status: 500 }
      );
    }
    const projectName = process.env.PROJECT || "spurdo";
    const destinationModel = `${replicateOwner}/${projectName}-sdxl`;

    // Ensure destination model exists (creates if not)
    try {
      await ensureDestinationModel({
        owner: replicateOwner,
        modelName: `${projectName}-sdxl`,
        description: `SDXL LoRA trained for ${projectName}`,
      });
    } catch (err) {
      return NextResponse.json(
        {
          ok: false,
          error: `Failed to create/verify Replicate destination model: ${err instanceof Error ? err.message : err}`,
        },
        { status: 502 }
      );
    }

    // Upload zip to Replicate's Files API (24h TTL — fine for training)
    let imagesZipUrl: string;
    try {
      imagesZipUrl = await uploadTrainingZipToReplicate(zipBuffer, originalFilename);
    } catch (err) {
      return NextResponse.json(
        {
          ok: false,
          error: `Replicate upload failed: ${err instanceof Error ? err.message : err}`,
        },
        { status: 502 }
      );
    }

    // Submit training
    let replicateJob: { id: string; status: string; webUrl: string };
    try {
      replicateJob = await submitReplicateTraining({
        imagesZipUrl,
        destinationModel,
        artStyle: resolvedArtStyle,
        steps,
      });
    } catch (err) {
      return NextResponse.json(
        {
          ok: false,
          error: `Replicate training submit failed: ${err instanceof Error ? err.message : err}`,
        },
        { status: 502 }
      );
    }

    // Persist job tracker (trainer="replicate" so polling routes correctly)
    const jobId = `job_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    const job: ActiveJob = {
      id: jobId,
      requestId: replicateJob.id,
      status: "queued",
      submittedAt: new Date().toISOString(),
      trainingSteps: steps,
      notes,
      trainingSetFilename: originalFilename,
      trainingEndpoint: `replicate:${destinationModel}`,
      trainedForStack: "sdxl-stylized",
      artStyle: resolvedArtStyle,
      trainer: "replicate",
    };
    await saveJob(job);

    return NextResponse.json({
      ok: true,
      jobId,
      requestId: replicateJob.id,
      status: "queued",
      trainer: "replicate",
      inputMode: images.length > 0 ? "multi-image" : "zip",
      fileCount: images.length || 1,
      trainingEndpoint: `replicate:${destinationModel}`,
      trainedForStack: "sdxl-stylized",
      artStyle: resolvedArtStyle,
      destinationModel,
      replicateWebUrl: replicateJob.webUrl,
    });
  }

  // ── Fal path (FLUX training, photorealistic) ──
  let imagesDataUrl: string;
  try {
    imagesDataUrl = await uploadZipToFal(zipBuffer, originalFilename);
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: `Fal upload failed: ${err instanceof Error ? err.message : err}` },
      { status: 502 }
    );
  }

  let trainingResult: Awaited<ReturnType<typeof submitTrainingJob>>;
  try {
    trainingResult = await submitTrainingJob(imagesDataUrl, steps, artStyle);
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: `Fal training submit failed: ${err instanceof Error ? err.message : err}` },
      { status: 502 }
    );
  }
  const { requestId, endpoint: trainingEndpoint, trainedForStack, artStyleUsed } = trainingResult;

  const jobId = `job_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  const job: ActiveJob = {
    id: jobId,
    requestId,
    status: "queued",
    submittedAt: new Date().toISOString(),
    imagesDataUrl,
    trainingSteps: steps,
    notes,
    trainingSetFilename: originalFilename,
    trainingEndpoint,
    trainedForStack,
    artStyle: artStyleUsed,
    trainer: "fal",
  };
  await saveJob(job);

  return NextResponse.json({
    ok: true,
    jobId,
    requestId,
    status: "queued",
    trainer: "fal",
    inputMode: images.length > 0 ? "multi-image" : "zip",
    fileCount: images.length || 1,
    trainingEndpoint,
    trainedForStack,
    artStyle: artStyleUsed,
  });
}
