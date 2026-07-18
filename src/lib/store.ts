import { Redis } from "@upstash/redis";
import { kvKey } from "./config";

// ============================================================
// KV STORE
// ============================================================
// Thin wrapper around Upstash Redis.
// All keys are prefixed with `${PROJECT}:` so this codebase can
// host multiple character projects without key collisions.
// ============================================================

let _redis: Redis | null = null;

function getRedis(): Redis {
  if (_redis) return _redis;
  const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) {
    throw new Error(
      "KV not configured. Set KV_REST_API_URL and KV_REST_API_TOKEN (or the UPSTASH_REDIS_REST_* equivalents) in your environment."
    );
  }
  _redis = new Redis({ url, token });
  return _redis;
}

/**
 * Health check — verifies KV is reachable and responsive.
 * Used by cron routes to refuse to act when state can't be persisted
 * (which would cause double-posts / double-replies).
 */
export async function kvHealthCheck(): Promise<boolean> {
  try {
    const probe = kvKey("__health");
    await getRedis().set(probe, Date.now(), { ex: 60 });
    const v = await getRedis().get(probe);
    return v !== null;
  } catch (err) {
    console.error("[KV] health check failed:", err);
    return false;
  }
}

// ============================================================
// KILL SWITCH
// ============================================================

export async function isKillSwitchActive(): Promise<boolean> {
  try {
    const v = await getRedis().get<boolean | string | number>(kvKey("kill_switch"));
    return v === true || v === "true" || v === 1 || v === "1";
  } catch {
    return false; // fail-open if KV is down so we don't lock ourselves out
  }
}

export async function setKillSwitch(active: boolean): Promise<void> {
  await getRedis().set(kvKey("kill_switch"), active ? "true" : "false");
}

// ============================================================
// HEARTBEAT
// ============================================================
// Used by /api/admin/status to confirm the worker is alive.

export async function recordHeartbeat(source: string): Promise<void> {
  await getRedis().set(
    kvKey(`heartbeat:${source}`),
    JSON.stringify({ ts: Date.now(), source })
  );
}

export async function getHeartbeat(
  source: string
): Promise<{ ts: number; source: string } | null> {
  const v = await getRedis().get<{ ts: number; source: string }>(
    kvKey(`heartbeat:${source}`)
  );
  return v;
}

// ============================================================
// RUN LOCKS
// ============================================================
// Redis SET NX locks. Two uses:
//   • per-cron run lock — stops overlapping invocations of the same cron
//     (replies cron runs every 300s with a multi-minute budget; a slow run
//     must not overlap the next one or mentions get double-replied)
//   • global posting lock — spans decide→post→record so the tweet cron and
//     the dashboard's post-now can never both pass the gap/daily-count
//     gates and double-post
// TTL is a safety valve: if the function is killed mid-run the lock frees
// itself. Releasing someone else's expired-and-reacquired lock is avoided
// by storing a per-acquisition token and checking it before DEL.
// ============================================================

export async function acquireLock(name: string, ttlSeconds: number): Promise<string | null> {
  const token = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  try {
    const ok = await getRedis().set(kvKey(`lock:${name}`), token, { nx: true, ex: ttlSeconds });
    return ok !== null ? token : null;
  } catch {
    // KV down → treat as lock-not-acquired; callers skip the run rather
    // than risk concurrent posting without coordination
    return null;
  }
}

export async function releaseLock(name: string, token: string): Promise<void> {
  try {
    const key = kvKey(`lock:${name}`);
    const held = await getRedis().get<string>(key);
    if (held === token) await getRedis().del(key);
  } catch { /* ttl frees it */ }
}

// ============================================================
// TWEET RECORDS (M3+)
// ============================================================
// Per-day list of posted tweets. Used for:
//   - daily activity panel in dashboard
//   - "recent tweets" injected into Claude prompt for variety
//   - dedup checks (M3 light, M4 heavy)
//
// Key shape:
//   ${PROJECT}:tweets:YYYY-MM-DD  →  JSON array of TweetRecord
//
// Records expire after 14 days.
// ============================================================

export interface StoredTweet {
  id: string;
  text: string;
  pillar: string;
  postedAt: string; // ISO
  url: string;
  hasImage: boolean;
  imageProvider?: string;
  dryRun?: boolean;
}

const TWEET_TTL_SECONDS = 60 * 60 * 24 * 14; // 14 days

function todayUTC(): string {
  return new Date().toISOString().slice(0, 10);
}

function tweetKey(date: string): string {
  return kvKey(`tweets:${date}`);
}

/** Append a tweet to today's list. */
export async function recordTweet(t: StoredTweet): Promise<void> {
  const key = tweetKey(todayUTC());
  const existing = (await getRedis().get<string | StoredTweet[]>(key)) || [];
  const list: StoredTweet[] = typeof existing === "string" ? safeJson<StoredTweet[]>(existing) || [] : existing;
  list.push(t);
  await getRedis().set(key, JSON.stringify(list), { ex: TWEET_TTL_SECONDS });
}

/** Get today's posted tweets (UTC day). */
export async function getDailyTweets(date?: string): Promise<StoredTweet[]> {
  const v = await getRedis().get<string | StoredTweet[]>(tweetKey(date || todayUTC()));
  if (!v) return [];
  return typeof v === "string" ? safeJson<StoredTweet[]>(v) || [] : v;
}

/**
 * Get the most recent N tweets across the last 3 days.
 * Used to feed Claude's prompt with recent-style context (don't repeat).
 */
export async function getRecentTweets(limit: number = 8): Promise<StoredTweet[]> {
  const days: string[] = [];
  const now = new Date();
  for (let i = 0; i < 3; i++) {
    const d = new Date(now);
    d.setUTCDate(d.getUTCDate() - i);
    days.push(d.toISOString().slice(0, 10));
  }
  const lists = await Promise.all(days.map((d) => getDailyTweets(d)));
  const flat = lists.flat();
  // Sort newest first by postedAt
  flat.sort((a, b) => (a.postedAt < b.postedAt ? 1 : -1));
  return flat.slice(0, limit);
}

/** Time the most recent tweet was posted. Used by scheduler for gap checking. */
export async function getLastPostedAt(): Promise<Date | null> {
  const recent = await getRecentTweets(1);
  if (recent.length === 0) return null;
  return new Date(recent[0].postedAt);
}

// ============================================================
// REPLY TRACKING (M4-rest)
// ============================================================
// Two pieces of state needed for the mention reply pipeline:
//
//   1. since_id watermark — the highest mention ID we've seen, so the
//      next cron run only fetches genuinely new mentions. This is what
//      Twitter recommends instead of fetching the full timeline each call.
//
//   2. processed set — short TTL set of mention IDs we've already replied
//      to. Belt-and-suspenders against double-replies if the watermark
//      gets reset (deploys, KV flush, race conditions).
//
// The watermark is authoritative for "what's new"; the set is the
// idempotency check before posting.
// ============================================================

const MENTION_SINCE_KEY = () => kvKey("replies:since-id");
const REPLIED_SET_KEY = () => kvKey("replies:processed");

/** Highest mention ID we've fetched. Returns undefined if first run. */
export async function getMentionSinceId(): Promise<string | undefined> {
  const v = await getRedis().get<string | number>(MENTION_SINCE_KEY());
  // upstash auto-deserialization JSON.parses numeric-looking strings into
  // numbers — normalize back, or length-based snowflake compares break
  return v === null || v === undefined || v === "" ? undefined : String(v);
}

export async function setMentionSinceId(id: string): Promise<void> {
  await getRedis().set(MENTION_SINCE_KEY(), id);
}

/**
 * Atomically reserve a mention for replying. SADD returns 1 only for the
 * caller that actually added the member, so two overlapping runs can never
 * both win the same mention — this replaces the old check-then-act pair
 * (wasMentionReplied → post → markMentionReplied) whose check and mark
 * straddled the network-bound post call.
 */
export async function tryReserveMention(mentionId: string): Promise<boolean> {
  const added = await getRedis().sadd(REPLIED_SET_KEY(), mentionId);
  if (added !== 1) return false;
  // Soft cap: trim if we exceed 5000. SPOP removes random members so we
  // can't preserve "newest" — but the since_id watermark covers that
  // case, so trimming randomly is acceptable.
  try {
    const size = await getRedis().scard(REPLIED_SET_KEY());
    if (size > 5000) await getRedis().spop(REPLIED_SET_KEY(), size - 5000);
  } catch { /* trim is best-effort */ }
  return true;
}

/**
 * Give a reservation back. ONLY safe when we know nothing was posted
 * (generation failed, kill switch, budget). Never call after a post
 * attempt — an X error can arrive after the tweet was actually created,
 * and unreserving would set up a double-reply.
 */
export async function unreserveMention(mentionId: string): Promise<void> {
  await getRedis().srem(REPLIED_SET_KEY(), mentionId);
}


function safeJson<T>(s: string): T | null {
  try {
    return JSON.parse(s) as T;
  } catch {
    return null;
  }
}
