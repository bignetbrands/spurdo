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
// M1 STUB — more methods (recordTweet, getDailyState, hasReplied, etc.)
// will arrive in M2/M3 as the orchestrator and scheduler need them.
// ============================================================

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

function safeJson<T>(s: string): T | null {
  try {
    return JSON.parse(s) as T;
  } catch {
    return null;
  }
}
