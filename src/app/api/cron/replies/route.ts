import { NextResponse } from "next/server";
import { checkCronAuth } from "@/lib/auth";
import {
  isKillSwitchActive,
  recordHeartbeat,
  getMentionSinceId,
  setMentionSinceId,
  wasMentionReplied,
  markMentionReplied,
} from "@/lib/store";
import { fetchMentions, getAuthenticatedUserId } from "@/lib/twitter";
import { executeReply } from "@/lib/orchestrator";
import { logEvent } from "@/lib/events";
import { loadConfig } from "@/lib/config";

export const maxDuration = 300;
export const dynamic = "force-dynamic";

/**
 * GET /api/cron/replies
 *
 * Engagement cron — runs every 30 min via vercel.json.
 *
 * Pipeline:
 *   1. Honor kill switch (early exit)
 *   2. Fetch new mentions of @${OUR_HANDLE} via X API (since_id watermark)
 *   3. For each new mention not already replied to:
 *      a. Check if author is a family account (warmer reply tone)
 *      b. Generate Spurdish reply via Claude (haiku)
 *      c. Optionally attach a bank meme
 *      d. Post as in-reply-to via X v2 tweet endpoint
 *      e. Mark as replied + advance the since_id watermark
 *
 * Always returns HTTP 200 even on internal errors. Vercel cron does not
 * retry on non-200, but we don't WANT retries — a partial double-post
 * is worse than skipping. Errors are logged and reported in the JSON body.
 */
export async function GET(request: Request) {
  const unauthorized = checkCronAuth(request);
  if (unauthorized) return unauthorized;

  await recordHeartbeat("cron:replies");

  if (await isKillSwitchActive()) {
    return NextResponse.json({
      processed: 0,
      reason: "kill switch active",
      timestamp: new Date().toISOString(),
    });
  }

  const cfg = loadConfig();

  // Engagement rules from accounts.json control whether we engage at all
  const rules = cfg.accounts.engagementRules;
  if (!rules.replyToMentionsAlways) {
    return NextResponse.json({
      processed: 0,
      reason: "engagementRules.replyToMentionsAlways = false",
      timestamp: new Date().toISOString(),
    });
  }

  // ── Fetch user ID for the timeline endpoint ──
  let userId: string;
  try {
    userId = await getAuthenticatedUserId();
  } catch (err) {
    await logEvent("error", "cron-replies: could not look up authenticated user id", {
      error: err instanceof Error ? err.message : String(err),
    }).catch(() => undefined);
    return NextResponse.json({
      processed: 0,
      error: `getAuthenticatedUserId failed: ${err instanceof Error ? err.message : err}`,
      timestamp: new Date().toISOString(),
    });
  }

  // ── Fetch new mentions ──
  const sinceId = await getMentionSinceId();
  let mentions: Awaited<ReturnType<typeof fetchMentions>>;
  try {
    mentions = await fetchMentions({ userId, sinceId, maxResults: 20 });
  } catch (err) {
    await logEvent("error", "cron-replies: fetchMentions failed", {
      error: err instanceof Error ? err.message : String(err),
      sinceId,
    }).catch(() => undefined);
    return NextResponse.json({
      processed: 0,
      error: `fetchMentions failed: ${err instanceof Error ? err.message : err}`,
      timestamp: new Date().toISOString(),
    });
  }

  if (mentions.length === 0) {
    return NextResponse.json({
      processed: 0,
      reason: "no new mentions since last run",
      sinceId,
      timestamp: new Date().toISOString(),
    });
  }

  // Family account lookup (case-insensitive on usernames)
  const familyHandles = new Set(
    cfg.accounts.familyAccounts.map((f) => f.handle.replace(/^@/, "").toLowerCase())
  );

  // Process oldest first so the watermark advances safely if we error mid-run
  const sorted = [...mentions].sort((a, b) => a.id.localeCompare(b.id));
  let processed = 0;
  let skipped = 0;
  const failures: Array<{ id: string; error: string }> = [];
  let highestProcessedId = sinceId;

  for (const m of sorted) {
    // Idempotency check: don't double-reply if KV says we already did
    if (await wasMentionReplied(m.id)) {
      skipped += 1;
      continue;
    }

    const isFamily = familyHandles.has(m.authorUsername.toLowerCase());
    // 50/50 coin flip per reply: half get a contextually-matched bank meme,
    // half are text-only. Smart-match picker uses the generated reply text
    // to pick a relevant image — keeps replies feeling alive without
    // being image-spammy. Operator can change this ratio in code.
    const includeImage = Math.random() < 0.5;

    const result = await executeReply({
      parentTweetId: m.id,
      parentText: m.text,
      authorUsername: m.authorUsername,
      isFamilyAccount: isFamily,
      hasParentImage: m.imageUrls.length > 0,
      hasParentVideo: m.hasVideo,
      includeImage,
      trigger: "cron-mention",
    });

    if (!result.ok) {
      failures.push({ id: m.id, error: result.error || "unknown" });
      // If kill-switch tripped or budget exceeded mid-loop, stop early
      if (result.error === "kill switch active" || result.budgetExceeded) {
        break;
      }
      continue;
    }

    await markMentionReplied(m.id);
    processed += 1;
    if (!highestProcessedId || m.id > highestProcessedId) {
      highestProcessedId = m.id;
    }
  }

  // Advance watermark to the highest mention ID we've SEEN (not just replied
  // to) so that "skip" mentions (e.g. spam, video-only, idempotency hits)
  // don't get re-seen forever. Use the top of the sorted list.
  const newSinceId = sorted[sorted.length - 1].id;
  if (!sinceId || newSinceId > sinceId) {
    await setMentionSinceId(newSinceId);
  }

  return NextResponse.json({
    processed,
    skipped,
    failures: failures.length,
    failureDetails: failures.slice(0, 5),
    fetchedCount: mentions.length,
    sinceIdBefore: sinceId || null,
    sinceIdAfter: newSinceId,
    timestamp: new Date().toISOString(),
  });
}
