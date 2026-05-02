import { NextResponse } from "next/server";
import { checkAdminAuth } from "@/lib/auth";
import { uploadZipToFal, submitTrainingJob, saveJob } from "@/lib/lora";
import type { ActiveJob } from "@/lib/lora";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const MAX_ZIP_BYTES = 100 * 1024 * 1024; // 100 MB ceiling
const DEFAULT_STEPS = 1000;

/**
 * POST /api/admin/lora/train
 *
 * Accepts a multipart/form-data upload:
 *   • zip: File (the training set archive)
 *   • steps: string (optional, default 1000)
 *   • notes: string (optional, free-text reminder for the registry)
 *
 * Behavior:
 *   1. Validate the upload (zip extension, size cap)
 *   2. Upload to Fal's storage → get a public URL
 *   3. Submit the flux-lora-fast-training job
 *   4. Persist a job tracker in KV so the dashboard can poll
 *   5. Return the jobId immediately (training takes ~10-15 min)
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

  const file = form.get("zip");
  if (!(file instanceof File)) {
    return NextResponse.json({ ok: false, error: "missing 'zip' file in form data" }, { status: 400 });
  }

  if (!file.name.toLowerCase().endsWith(".zip")) {
    return NextResponse.json({ ok: false, error: "file must be a .zip archive" }, { status: 400 });
  }

  if (file.size > MAX_ZIP_BYTES) {
    return NextResponse.json(
      { ok: false, error: `zip is too large (${file.size} bytes, max ${MAX_ZIP_BYTES})` },
      { status: 400 }
    );
  }
  if (file.size === 0) {
    return NextResponse.json({ ok: false, error: "zip is empty" }, { status: 400 });
  }

  const stepsRaw = form.get("steps");
  let steps = DEFAULT_STEPS;
  if (typeof stepsRaw === "string" && stepsRaw.trim()) {
    const n = parseInt(stepsRaw, 10);
    if (Number.isFinite(n) && n >= 100 && n <= 5000) steps = n;
  }

  const notes = typeof form.get("notes") === "string" ? (form.get("notes") as string) : undefined;

  // ── Read the file into a Buffer for upload ──
  const buf = Buffer.from(await file.arrayBuffer());

  // ── Upload to Fal storage ──
  let imagesDataUrl: string;
  try {
    imagesDataUrl = await uploadZipToFal(buf, file.name);
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: `Fal upload failed: ${err instanceof Error ? err.message : err}` },
      { status: 502 }
    );
  }

  // ── Submit training job ──
  let requestId: string;
  try {
    requestId = await submitTrainingJob(imagesDataUrl, steps);
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: `Fal training submit failed: ${err instanceof Error ? err.message : err}` },
      { status: 502 }
    );
  }

  // ── Persist job tracker in KV ──
  const jobId = `job_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  const job: ActiveJob = {
    id: jobId,
    requestId,
    status: "queued",
    submittedAt: new Date().toISOString(),
    imagesDataUrl,
    trainingSteps: steps,
    notes,
    trainingSetFilename: file.name,
  };
  await saveJob(job);

  return NextResponse.json({ ok: true, jobId, requestId, status: "queued" });
}
