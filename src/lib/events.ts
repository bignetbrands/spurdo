import { Redis } from "@upstash/redis";
import { kvKey } from "./config";

// ============================================================
// EVENTS LOG
// ============================================================
// Single time-ordered list of recent events for ops visibility.
// Replaces the volatile in-browser log: surviving page refresh,
// shared across multiple operator sessions.
//
// Key shape:  ${PROJECT}:events  →  Redis list (LPUSH)
// Trimmed to last 200 events. No TTL — capped by length.
// ============================================================

export type EventType =
  | "info"
  | "success"
  | "error"
  | "warn"
  | "post"
  | "skip"
  | "cron";

export interface AppEvent {
  ts: string;
  type: EventType;
  msg: string;
  meta?: Record<string, unknown>;
}

let _redis: Redis | null = null;
function r(): Redis {
  if (_redis) return _redis;
  const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) throw new Error("KV not configured");
  _redis = new Redis({ url, token });
  return _redis;
}

const KEY = () => kvKey("events");
const MAX_EVENTS = 200;

/**
 * Record an event. Best-effort: errors are swallowed so logging
 * failures never break the calling code path.
 */
export async function logEvent(type: EventType, msg: string, meta?: Record<string, unknown>): Promise<void> {
  const evt: AppEvent = { ts: new Date().toISOString(), type, msg, meta };
  try {
    await r().lpush(KEY(), JSON.stringify(evt));
    await r().ltrim(KEY(), 0, MAX_EVENTS - 1);
  } catch (err) {
    console.warn("[events] write failed:", err);
  }
}

/** Read recent events, newest first. */
export async function getEvents(limit: number = 50): Promise<AppEvent[]> {
  try {
    const raw = await r().lrange<string | AppEvent>(KEY(), 0, Math.min(limit, MAX_EVENTS) - 1);
    return raw
      .map((entry) => {
        if (typeof entry === "string") {
          try {
            return JSON.parse(entry) as AppEvent;
          } catch {
            return null;
          }
        }
        return entry;
      })
      .filter((e): e is AppEvent => e !== null);
  } catch (err) {
    console.warn("[events] read failed:", err);
    return [];
  }
}
