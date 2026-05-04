import { NextResponse } from "next/server";
import { checkAdminAuth } from "@/lib/auth";
import { getJob, saveJob, pollTrainingJob, addToRegistry } from "@/lib/lora";
import { pollReplicateTraining } from "@/lib/replicate";

export const dynamic = "force-dynamic";

/**
 * GET /api/admin/lora/status/[jobId]
 *
 * Polls the underlying training job for its current status. Routes to
 * Replicate or Fal based on job.trainer.
 *
 * When the job transitions to "completed", auto-promotes it to
 * the LoRA registry (but does NOT auto-set as active — operator
 * confirms via /api/admin/lora/active).
 *
 * The dashboard calls this every ~10 seconds while a training is
 * in progress, then stops once status is "completed" or "failed".
 *
 * Returns the full ActiveJob record.
 */
export async function GET(
  request: Request,
  context: { params: Promise<{ jobId: string }> }
) {
  const unauthorized = checkAdminAuth(request);
  if (unauthorized) return unauthorized;

  const { jobId } = await context.params;

  const job = await getJob(jobId);
  if (!job) {
    return NextResponse.json({ ok: false, error: `job not found: ${jobId}` }, { status: 404 });
  }

  // Already terminal → just return cached state (no extra poll call)
  if (job.status === "completed" || job.status === "failed") {
    return NextResponse.json({ ok: true, job });
  }

  // ── Dispatch poll to the right backend ──
  // Default to "fal" for legacy jobs that don't have the trainer field
  const trainer = job.trainer || "fal";

  let polled: { status: "submitting" | "queued" | "in_progress" | "completed" | "failed"; loraUrl?: string; error?: string };

  if (trainer === "replicate") {
    try {
      const r = await pollReplicateTraining(job.requestId);
      // Map Replicate status to our status enum
      let mappedStatus: typeof polled.status;
      if (r.status === "starting") mappedStatus = "queued";
      else if (r.status === "processing") mappedStatus = "in_progress";
      else if (r.status === "succeeded") mappedStatus = "completed";
      else if (r.status === "failed" || r.status === "canceled") mappedStatus = "failed";
      else mappedStatus = "in_progress";

      polled = {
        status: mappedStatus,
        loraUrl: r.weightsUrl,
        error: r.error,
      };
    } catch (err) {
      return NextResponse.json(
        { ok: false, error: `Replicate poll failed: ${err instanceof Error ? err.message : err}` },
        { status: 502 }
      );
    }
  } else {
    try {
      polled = await pollTrainingJob(job.requestId, job.trainingEndpoint);
    } catch (err) {
      return NextResponse.json(
        { ok: false, error: `Fal poll failed: ${err instanceof Error ? err.message : err}` },
        { status: 502 }
      );
    }
  }

  // Apply the new status
  if (polled.status === "completed" && polled.loraUrl) {
    job.status = "completed";
    job.loraUrl = polled.loraUrl;
    job.completedAt = new Date().toISOString();
    await saveJob(job);

    // Auto-add to registry (not active yet — operator chooses)
    try {
      await addToRegistry({
        url: polled.loraUrl,
        trainedAt: job.completedAt,
        notes: job.notes,
        trainingSetFilename: job.trainingSetFilename,
        trainingSteps: job.trainingSteps,
        trainedForStack: job.trainedForStack,
        artStyle: job.artStyle,
      });
    } catch {
      // Registry write failed — job is still successful, just not in registry
    }
  } else if (polled.status === "failed") {
    job.status = "failed";
    job.error = polled.error;
    job.completedAt = new Date().toISOString();
    await saveJob(job);
  } else {
    // Still queued or in progress
    if (job.status !== polled.status) {
      job.status = polled.status;
      await saveJob(job);
    }
  }

  return NextResponse.json({ ok: true, job });
}
