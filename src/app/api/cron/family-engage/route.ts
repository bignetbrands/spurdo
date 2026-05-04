import { NextResponse } from "next/server";
import { checkCronAuth } from "@/lib/auth";
import {
  isKillSwitchActive,
  recordHeartbeat,
  getFamilyAccountLastReplied,
  setFamilyAccountLastReplied,
  wasMentionReplied,
  markMentionReplied,
} from "@/lib/store";
import { fetchUserRecentTweets, lookupUserIdByUsername } from "@/lib/twitter";
import { executeReply } from "@/lib/orchestrator";
import { logEvent } from "@/lib/events";
import { loadConfig } from "@/lib/config";

export const maxDuration = 120;
export const dynamic = "force-dynamic";

/**
 * GET /api/cron/family-engage
 *
 * Proactive engagement with family accounts. Runs hourly via vercel.json.
 *
 * Pipeline:
 *   1. Kill switch + engagement-rules check
 *   2. Pick eligible family accounts (those we haven't engaged with in
 *      FAMILY_REPLY_COOLDOWN_HOURS hours)
 *   3. Pick ONE random eligible account (we engage with one per cron tick
 *      to avoid spam — feels organic vs hammering all family at once)
 *   4. Fetch their recent ORIGINAL tweets (no retweets, no replies)
 *   5. Pick the most recent original we haven't replied to
 *   6. Generate Spurdish reply (warmer family tone) + post as in-reply-to
 *   7. Mark cooldown + tracked tweet ID
 *
 * Always returns HTTP 200 to prevent cron auto-retry causing dupes.
 */

// Don't engage the same family account more than once per N hours.
// Defaults to 12 hours = at most 2 engagements per day per family account.
const FAMILY_REPLY_COOLDOWN_HOURS = 12;
// How recent must their tweet be? Don't reply to ancient stuff that nobody's looking at.
const MAX_TWEET_AGE_HOURS = 24;

export async function GET(request: Request) {
  const unauthorized = checkCronAuth(request);
  if (unauthorized) return unauthorized;

  await recordHeartbeat("cron:family-engage");

  if (await isKillSwitchActive()) {
    return NextResponse.json({
      processed: 0,
      reason: "kill switch active",
      timestamp: new Date().toISOString(),
    });
  }

  const cfg = loadConfig();

  if (!cfg.accounts.engagementRules.replyToFamilyEachCycle) {
    return NextResponse.json({
      processed: 0,
      reason: "engagementRules.replyToFamilyEachCycle = false",
      timestamp: new Date().toISOString(),
    });
  }

  const family = cfg.accounts.familyAccounts;
  if (family.length === 0) {
    return NextResponse.json({
      processed: 0,
      reason: "no family accounts configured",
      timestamp: new Date().toISOString(),
    });
  }

  // ── Filter to accounts off cooldown ──
  const cooldownMs = FAMILY_REPLY_COOLDOWN_HOURS * 60 * 60 * 1000;
  const now = Date.now();
  const eligible: Array<{ handle: string; label: string }> = [];
  for (const f of family) {
    const handle = f.handle.replace(/^@/, "");
    const last = await getFamilyAccountLastReplied(handle);
    if (!last || now - new Date(last).getTime() > cooldownMs) {
      eligible.push({ handle, label: f.label });
    }
  }

  if (eligible.length === 0) {
    return NextResponse.json({
      processed: 0,
      reason: `all family accounts on cooldown (last engagement < ${FAMILY_REPLY_COOLDOWN_HOURS}h ago for each)`,
      timestamp: new Date().toISOString(),
    });
  }

  // Pick ONE random eligible account — feels organic vs blasting all at once
  const picked = eligible[Math.floor(Math.random() * eligible.length)];

  // ── Look up their user ID ──
  let targetUserId: string | null;
  try {
    targetUserId = await lookupUserIdByUsername(picked.handle);
  } catch (err) {
    await logEvent("error", `family-engage: lookup failed for @${picked.handle}`, {
      error: err instanceof Error ? err.message : String(err),
    }).catch(() => undefined);
    return NextResponse.json({
      processed: 0,
      error: `userByUsername failed: ${err instanceof Error ? err.message : err}`,
      pickedHandle: picked.handle,
      timestamp: new Date().toISOString(),
    });
  }
  if (!targetUserId) {
    return NextResponse.json({
      processed: 0,
      reason: `could not resolve @${picked.handle} (suspended? renamed?)`,
      pickedHandle: picked.handle,
      timestamp: new Date().toISOString(),
    });
  }

  // ── Fetch their recent originals ──
  let tweets: Awaited<ReturnType<typeof fetchUserRecentTweets>>;
  try {
    tweets = await fetchUserRecentTweets({ userId: targetUserId, maxResults: 10 });
  } catch (err) {
    await logEvent("error", `family-engage: fetchUserRecentTweets failed for @${picked.handle}`, {
      error: err instanceof Error ? err.message : String(err),
    }).catch(() => undefined);
    return NextResponse.json({
      processed: 0,
      error: `userTimeline failed: ${err instanceof Error ? err.message : err}`,
      pickedHandle: picked.handle,
      timestamp: new Date().toISOString(),
    });
  }

  if (tweets.length === 0) {
    return NextResponse.json({
      processed: 0,
      reason: `@${picked.handle} has no recent original tweets`,
      pickedHandle: picked.handle,
      timestamp: new Date().toISOString(),
    });
  }

  // ── Pick a tweet to reply to ──
  // Filter to tweets that are:
  //   - within MAX_TWEET_AGE_HOURS
  //   - not already replied to (idempotency check via wasMentionReplied —
  //     reusing the same KV set as mentions; mention IDs and family-tweet IDs
  //     don't collide because they're both globally-unique tweet IDs)
  //   - text isn't trivial (>= 10 chars; very short tweets are usually emoji
  //     reactions and not great reply targets)
  const ageMs = MAX_TWEET_AGE_HOURS * 60 * 60 * 1000;
  const candidates = [];
  for (const t of tweets) {
    if (now - new Date(t.createdAt).getTime() > ageMs) continue;
    if (t.text.trim().length < 10) continue;
    if (await wasMentionReplied(t.id)) continue;
    candidates.push(t);
  }

  if (candidates.length === 0) {
    return NextResponse.json({
      processed: 0,
      reason: `no eligible tweets from @${picked.handle} (all too old, too short, or already replied to)`,
      pickedHandle: picked.handle,
      tweetsConsidered: tweets.length,
      timestamp: new Date().toISOString(),
    });
  }

  // Pick the most recent eligible (sorted by createdAt desc)
  candidates.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  const target = candidates[0];

  // ── Generate + post reply ──
  const result = await executeReply({
    parentTweetId: target.id,
    parentText: target.text,
    authorUsername: picked.handle,
    isFamilyAccount: true,
    hasParentImage: target.imageUrls.length > 0,
    hasParentVideo: target.hasVideo,
    includeImage: false, // text replies for family — keeps it conversational
    trigger: "cron-family",
  });

  if (!result.ok) {
    // Mark this tweet as "handled" in the dedupe set so we don't keep
    // retrying it every 2 hours. Common cause of repeated failure is
    // a 403 from X (target account has reply restrictions, deleted the
    // tweet, blocked us, etc) — those don't get better by retrying.
    await markMentionReplied(target.id).catch(() => undefined);
    return NextResponse.json({
      processed: 0,
      error: result.error,
      pickedHandle: picked.handle,
      targetTweetId: target.id,
      markedAsHandled: true,
      timestamp: new Date().toISOString(),
    });
  }

  await markMentionReplied(target.id);
  await setFamilyAccountLastReplied(picked.handle);

  return NextResponse.json({
    processed: 1,
    pickedHandle: picked.handle,
    targetTweetId: target.id,
    replyTweetId: result.tweetId,
    replyUrl: result.url,
    dryRun: result.dryRun,
    timestamp: new Date().toISOString(),
  });
}
