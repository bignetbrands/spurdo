import { Redis } from "@upstash/redis";
import { kvKey, loadConfig } from "./config";

// ============================================================
// DAILY BUDGET ENFORCEMENT
// ============================================================
// Two counters tracked per UTC day:
//   ${PROJECT}:spend:YYYY-MM-DD:images  (number)
//   ${PROJECT}:spend:YYYY-MM-DD:tokens  (number)
//
// Limits live in /config/${PROJECT}/pillars.json under .dailyLimits.
// If a counter equals or exceeds its limit, the next call refuses
// to act and throws BudgetExceededError.
//
// BUDGET_OVERRIDE=1 in env bypasses both limits — for emergencies
// where you really do need to keep generating despite hitting a cap.
//
// Counters expire 36 hours after creation so we don't leak keys.
// ============================================================

let _redis: Redis | null = null;
function r(): Redis {
  if (_redis) return _redis;
  const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) throw new Error("KV not configured");
  _redis = new Redis({ url, token });
  return _redis;
}

export class BudgetExceededError extends Error {
  constructor(public resource: "images" | "tokens", public used: number, public limit: number) {
    super(`Daily ${resource} budget exceeded: ${used}/${limit}. Resets at UTC midnight. Set BUDGET_OVERRIDE=1 to bypass.`);
    this.name = "BudgetExceededError";
  }
}

function todayUTC(): string {
  return new Date().toISOString().slice(0, 10); // YYYY-MM-DD
}

function isOverridden(): boolean {
  const v = process.env.BUDGET_OVERRIDE;
  return v === "1" || v === "true";
}

function imagesKey(): string {
  return kvKey(`spend:${todayUTC()}:images`);
}
function tokensKey(): string {
  return kvKey(`spend:${todayUTC()}:tokens`);
}

const TTL_SECONDS = 60 * 60 * 36; // 36h — outlives a UTC day plus buffer

/**
 * Get current day's spend usage and limits.
 * Used by status route + dashboard.
 */
export async function getBudgetStatus(): Promise<{
  images: { used: number; limit: number; remaining: number };
  tokens: { used: number; limit: number; remaining: number };
  date: string;
  overridden: boolean;
}> {
  const cfg = loadConfig();
  const limits = cfg.pillars.dailyLimits || { images: 50, anthropicTokens: 200000 };
  const [imgRaw, tokRaw] = await Promise.all([
    r().get<number | string>(imagesKey()),
    r().get<number | string>(tokensKey()),
  ]);
  const imgUsed = Number(imgRaw) || 0;
  const tokUsed = Number(tokRaw) || 0;
  return {
    images: {
      used: imgUsed,
      limit: limits.images,
      remaining: Math.max(0, limits.images - imgUsed),
    },
    tokens: {
      used: tokUsed,
      limit: limits.anthropicTokens,
      remaining: Math.max(0, limits.anthropicTokens - tokUsed),
    },
    date: todayUTC(),
    overridden: isOverridden(),
  };
}

/**
 * Check the image budget BEFORE attempting a gen.
 * Throws BudgetExceededError if cap is reached.
 */
export async function assertImageBudget(): Promise<void> {
  if (isOverridden()) return;
  const cfg = loadConfig();
  const limit = cfg.pillars.dailyLimits?.images ?? 50;
  const used = Number((await r().get<number | string>(imagesKey())) || 0);
  if (used >= limit) {
    throw new BudgetExceededError("images", used, limit);
  }
}

/**
 * Check the token budget BEFORE a Claude call.
 * Throws BudgetExceededError if cap is reached.
 */
export async function assertTokenBudget(): Promise<void> {
  if (isOverridden()) return;
  const cfg = loadConfig();
  const limit = cfg.pillars.dailyLimits?.anthropicTokens ?? 200000;
  const used = Number((await r().get<number | string>(tokensKey())) || 0);
  if (used >= limit) {
    throw new BudgetExceededError("tokens", used, limit);
  }
}

/**
 * Atomically reserve one image slot BEFORE generating. INCR-then-compare
 * closes the old check-then-act race where N parallel gens (calibrate fires
 * 7 at once) all read the same "used" value, all passed, and overshot the
 * daily cap by N-1. Overshooters refund their increment and throw.
 * Call refundImageSlot() if the generation then fails (no money spent).
 */
export async function reserveImageSlot(): Promise<void> {
  if (isOverridden()) return;
  const cfg = loadConfig();
  const limit = cfg.pillars.dailyLimits?.images ?? 50;
  const key = imagesKey();
  const newCount = await r().incrby(key, 1);
  if (newCount === 1) await r().expire(key, TTL_SECONDS);
  if (newCount > limit) {
    await r().decrby(key, 1).catch((err) =>
      console.error("[budget] refund after over-reserve failed (cap now conservative):", err)
    );
    throw new BudgetExceededError("images", newCount - 1, limit);
  }
}

/** Give a reserved image slot back after a FAILED generation. */
export async function refundImageSlot(): Promise<void> {
  if (isOverridden()) return;
  try {
    const n = await r().decrby(imagesKey(), 1);
    if (n < 0) await r().incrby(imagesKey(), 1); // clamp — never go negative
  } catch (err) {
    // Failed refund over-counts (conservative direction) — log, dont hide
    console.error("[budget] refundImageSlot failed:", err);
  }
}

/**
 * Record an image generation. Call AFTER a successful gen.
 * (Legacy post-paid path — the fal/openai flows now use reserveImageSlot.)
 */
export async function recordImageSpend(count: number = 1): Promise<void> {
  const key = imagesKey();
  const newCount = await r().incrby(key, count);
  if (newCount === count) {
    // First write today — set the TTL
    await r().expire(key, TTL_SECONDS);
  }
}

/**
 * Record token usage. Call AFTER a successful Claude call.
 */
export async function recordTokenSpend(tokens: number): Promise<void> {
  if (tokens <= 0) return;
  const key = tokensKey();
  const newCount = await r().incrby(key, tokens);
  if (newCount === tokens) {
    await r().expire(key, TTL_SECONDS);
  }
}
