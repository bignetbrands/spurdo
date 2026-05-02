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
