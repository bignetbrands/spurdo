import { NextResponse } from "next/server";
import { checkAdminAuth } from "@/lib/auth";
import { getJob, saveJob, pollTrainingJob, addToRegistry } from "@/lib/lora";

export const dynamic = "force-dynamic";

/**
 * GET /api/admin/lora/status/[jobId]
 *
 * Polls the underlying Fal training job for its current status.
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

  // Already terminal → just return cached state (no extra Fal call)
  if (job.status === "completed" || job.status === "failed") {
    return NextResponse.json({ ok: true, job });
  }

  // Poll Fal — pass the original training endpoint so we use the right poll URL
  let polled: Awaited<ReturnType<typeof pollTrainingJob>>;
  try {
    polled = await pollTrainingJob(job.requestId, job.trainingEndpoint);
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: `Fal poll failed: ${err instanceof Error ? err.message : err}` },
      { status: 502 }
    );
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
