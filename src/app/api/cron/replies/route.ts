import { NextResponse } from "next/server";
import { checkCronAuth } from "@/lib/auth";
import {
  isKillSwitchActive,
  kvHealthCheck,
  recordHeartbeat,
  getMentionSinceId,
  setMentionSinceId,
  tryReserveMention,
  unreserveMention,
  acquireLock,
  releaseLock,
} from "@/lib/store";
import { fetchMentions, getAuthenticatedUserId } from "@/lib/twitter";
import { executeReply } from "@/lib/orchestrator";
import { logEvent } from "@/lib/events";
import { loadConfig } from "@/lib/config";

// Cron fires every 300s (vercel.json `*/5`). maxDuration MUST stay well
// under that period or a slow run overlaps the next invocation. The run
// lock below is the hard guard; this is the soft one.
export const maxDuration = 240;
export const dynamic = "force-dynamic";

const RUN_LOCK = "cron-replies";
const RUN_LOCK_TTL = 250; // just past maxDuration so a killed run frees itself

/**
 * GET /api/cron/replies
 *
 * Engagement cron — runs every 5 minutes via vercel.json.
 *
 * Pipeline:
 *   1. Run lock (skip if a previous invocation is still going)
 *   2. Honor kill switch + KV health (no idempotency without KV)
 *   3. Fetch new mentions of @${OUR_HANDLE} via X API (since_id watermark)
 *   4. For each new mention: atomically reserve it (SADD), generate a
 *      Spurdish reply via Claude (haiku), post as in-reply-to
 *   5. Advance the since_id watermark ONLY past contiguously-consumed
 *      mentions, so anything we didn't get to is re-fetched next run
 *
 * Always returns HTTP 200 even on internal errors. Vercel cron retries
 * non-200, and a retry re-opens the double-post window — errors are
 * logged and reported in the JSON body instead.
 */
export async function GET(request: Request) {
  const unauthorized = checkCronAuth(request);
  if (unauthorized) return unauthorized;

  try {
    return await run();
  } catch (err) {
    // Never bubble a 500 out of a posting cron — Vercel would retry it.
    await logEvent("error", "cron-replies: unhandled error", {
      error: err instanceof Error ? err.message : String(err),
    }).catch(() => undefined);
    return NextResponse.json({
      processed: 0,
      error: `unhandled: ${err instanceof Error ? err.message : err}`,
      timestamp: new Date().toISOString(),
    });
  }
}

async function run(): Promise<NextResponse> {
  // ── Run lock — one invocation at a time ──
  const lockToken = await acquireLock(RUN_LOCK, RUN_LOCK_TTL);
  if (!lockToken) {
    return NextResponse.json({
      processed: 0,
      reason: "another replies run is still in progress (run lock held)",
      timestamp: new Date().toISOString(),
    });
  }

  try {
    await recordHeartbeat("cron:replies").catch(() => undefined);

    if (await isKillSwitchActive()) {
      return NextResponse.json({
        processed: 0,
        reason: "kill switch active",
        timestamp: new Date().toISOString(),
      });
    }

    // Without KV we can't do idempotency — refuse to act rather than
    // risk double-replying to everything.
    if (!(await kvHealthCheck())) {
      await logEvent("warn", "cron-replies: KV unhealthy, skipping run").catch(() => undefined);
      return NextResponse.json({
        processed: 0,
        reason: "kv health check failed — refusing to reply without idempotency state",
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

    // Process oldest first. Tweet IDs are numeric snowflakes — compare by
    // length first so "99" < "100" sorts correctly regardless of digits.
    const sorted = [...mentions].sort((a, b) => cmpId(a.id, b.id));
    let processed = 0;
    let skipped = 0;
    const failures: Array<{ id: string; error: string }> = [];

    // Watermark rule: advance only past CONTIGUOUSLY consumed mentions.
    // "Consumed" = replied, already-in-set skip, or a post-phase failure
    // (which may have actually posted — we burn it rather than risk a
    // double-reply). A generation-phase failure or an early break leaves
    // the mention unconsumed: the watermark stops before it and the next
    // run re-fetches it. This is what fixes the old bug where a budget
    // trip on mention 3 of 20 silently dropped mentions 4–20 forever.
    let watermark = sinceId;
    let contiguous = true;
    const consume = (id: string) => {
      if (contiguous && (!watermark || cmpId(id, watermark) > 0)) watermark = id;
    };

    for (const m of sorted) {
      // Atomic reservation: SADD returns 1 only for the run that added it,
      // so overlapping runs (or a lock-expiry edge) can never both win.
      if (!(await tryReserveMention(m.id))) {
        skipped += 1;
        consume(m.id);
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
        // Pass the actual image URLs so Haiku can see them. Without this
        // the model is replying blind when the joke is in the image.
        parentImageUrls: m.imageUrls,
        includeImage,
        trigger: "cron-mention",
      });

      if (result.ok) {
        processed += 1;
        consume(m.id);
        continue;
      }

      failures.push({ id: m.id, error: result.error || "unknown" });

      if (result.failedAtPost) {
        // The X create call errored — the reply MAY still have been posted
        // (X can create the tweet then drop the connection). Keep the
        // reservation and consume the mention: a missed reply is invisible,
        // a double-reply looks broken.
        consume(m.id);
      } else {
        // Generation-phase failure (Claude error, empty text, kill switch,
        // budget) — nothing reached X. Free the reservation so the next
        // run retries, and stop the watermark before this mention.
        await unreserveMention(m.id).catch(() => undefined);
        contiguous = false;
      }

      // If kill-switch tripped or budget exceeded mid-loop, stop early.
      // Everything after this point stays unconsumed and re-fetches.
      if (result.error === "kill switch active" || result.budgetExceeded) {
        break;
      }
    }

    if (watermark && (!sinceId || cmpId(watermark, sinceId) > 0)) {
      await setMentionSinceId(watermark);
    }

    return NextResponse.json({
      processed,
      skipped,
      failures: failures.length,
      failureDetails: failures.slice(0, 5),
      fetchedCount: mentions.length,
      sinceIdBefore: sinceId || null,
      sinceIdAfter: watermark || null,
      timestamp: new Date().toISOString(),
    });
  } finally {
    await releaseLock(RUN_LOCK, lockToken);
  }
}

/** Numeric-safe compare for tweet-id snowflake strings. */
function cmpId(a: string, b: string): number {
  if (a.length !== b.length) return a.length - b.length;
  return a < b ? -1 : a > b ? 1 : 0;
}
