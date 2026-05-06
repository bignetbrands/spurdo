import { loadConfig } from "./config";
import { isKillSwitchActive, kvHealthCheck, getDailyTweets, getLastPostedAt } from "./store";
import { getBudgetStatus } from "./budget";
import { timeOfDayUTC } from "./prompts";
import type { PillarId, TimeOfDay } from "@/types";

// ============================================================
// SCHEDULER
// ============================================================
// Single function decideNext(): { shouldPost, pillar?, reason }
//
// Conservative by default — refuses if anything looks off:
//   • Kill switch active        → skip
//   • KV health failing         → skip (don't risk double-post)
//   • Quiet hours UTC           → skip
//   • Last post too recent      → skip (under gapMinutes.min for ToD)
//   • Daily target met          → skip
//   • Budget exhausted          → skip
//
// Otherwise picks a pillar via weighted-random from time-of-day weights.
// ============================================================

export interface SchedulerDecision {
  shouldPost: boolean;
  pillar?: PillarId;
  reason: string;
  meta?: {
    timeOfDay?: TimeOfDay;
    minutesSinceLast?: number;
    todayCount?: number;
    todayTarget?: { min: number; max: number };
    budgetRemaining?: { images: number; tokens: number };
  };
}

export async function decideNext(): Promise<SchedulerDecision> {
  const cfg = loadConfig();
  const schedule = cfg.pillars.schedule;
  const now = new Date();
  const hourUTC = now.getUTCHours();
  const tod = timeOfDayUTC();

  // ── Gate 1: kill switch ──
  if (await isKillSwitchActive()) {
    return { shouldPost: false, reason: "kill switch active" };
  }

  // ── Gate 2: KV health ──
  const healthy = await kvHealthCheck();
  if (!healthy) {
    return { shouldPost: false, reason: "KV health check failed — refusing to post" };
  }

  // ── Gate 3: quiet hours ──
  if (schedule.quietHoursUTC.includes(hourUTC)) {
    return { shouldPost: false, reason: `quiet hours (${hourUTC}:00 UTC)` };
  }

  // ── Gate 4: outside active window ──
  // active window is [start, end) — wraps midnight if end < start
  const inActiveWindow =
    schedule.activeStartHourUTC <= schedule.activeEndHourUTC
      ? hourUTC >= schedule.activeStartHourUTC && hourUTC < schedule.activeEndHourUTC
      : hourUTC >= schedule.activeStartHourUTC || hourUTC < schedule.activeEndHourUTC;
  if (!inActiveWindow) {
    return {
      shouldPost: false,
      reason: `outside active window (${schedule.activeStartHourUTC}:00–${schedule.activeEndHourUTC}:00 UTC)`,
    };
  }

  // ── Gate 5: daily target ──
  const today = await getDailyTweets();
  const targetMax = schedule.dailyTweetTarget.max;
  if (today.length >= targetMax) {
    return {
      shouldPost: false,
      reason: `daily target met (${today.length}/${targetMax})`,
      meta: { todayCount: today.length, todayTarget: schedule.dailyTweetTarget },
    };
  }

  // ── Gate 5b: per-pillar daily-target enforcement ──
  // Some pillars are once-per-day (gm_grin, gn_grin). We track posts
  // per pillar today to know which are exhausted.
  const todayByPillar: Record<string, number> = {};
  for (const t of today) {
    todayByPillar[t.pillar] = (todayByPillar[t.pillar] || 0) + 1;
  }

  // ── Special priority slots: gm and gn ──
  // gm_grin should fire ONCE per day in the morning window (before noon UTC),
  // and gn_grin should fire ONCE per day at night (≥22:00 UTC). These get
  // priority over the normal weighted random pick — if it's morning and
  // we haven't gm'd yet, force gm. Same for gn at night.
  const gmAlreadyToday = (todayByPillar["gm_grin"] || 0) >= 1;
  const gnAlreadyToday = (todayByPillar["gn_grin"] || 0) >= 1;
  const isMorningWindow = hourUTC < 12;
  const isNightWindow = hourUTC >= 22;

  if (isMorningWindow && !gmAlreadyToday && cfg.pillars.pillars["gm_grin"]) {
    // Skip gap + probability gates for the priority gm slot — it's its own thing
    return {
      shouldPost: true,
      pillar: "gm_grin",
      reason: `priority slot: gm_grin (morning window, none today)`,
      meta: { timeOfDay: tod, todayCount: today.length, todayTarget: schedule.dailyTweetTarget },
    };
  }
  if (isNightWindow && !gnAlreadyToday && cfg.pillars.pillars["gn_grin"]) {
    return {
      shouldPost: true,
      pillar: "gn_grin",
      reason: `priority slot: gn_grin (night window, none today)`,
      meta: { timeOfDay: tod, todayCount: today.length, todayTarget: schedule.dailyTweetTarget },
    };
  }

  // ── Gate 6: gap since last post ──
  const last = await getLastPostedAt();
  let minutesSinceLast = Infinity;
  if (last) {
    minutesSinceLast = (now.getTime() - last.getTime()) / 60_000;
    const minGap = schedule.gapMinutes[tod].min;
    if (minutesSinceLast < minGap) {
      return {
        shouldPost: false,
        reason: `last post ${Math.round(minutesSinceLast)} min ago, min gap ${minGap} min for ${tod}`,
        meta: { timeOfDay: tod, minutesSinceLast },
      };
    }
  }

  // ── Gate 7: budget ──
  const budget = await getBudgetStatus();
  if (budget.images.remaining <= 0) {
    return {
      shouldPost: false,
      reason: `image budget exhausted (${budget.images.used}/${budget.images.limit})`,
      meta: { budgetRemaining: { images: 0, tokens: budget.tokens.remaining } },
    };
  }
  if (budget.tokens.remaining <= 0) {
    return {
      shouldPost: false,
      reason: `token budget exhausted (${budget.tokens.used}/${budget.tokens.limit})`,
      meta: { budgetRemaining: { images: budget.images.remaining, tokens: 0 } },
    };
  }

  // ── Gate 8: probability gate (jitter) ──
  // Even when all gates pass, don't always post. Keeps cadence organic.
  // Probability scales with how "behind" we are vs the daily target's midpoint
  // and how long since the last post relative to the gap window.
  const targetMid = (schedule.dailyTweetTarget.min + schedule.dailyTweetTarget.max) / 2;
  const behind = Math.max(0, targetMid - today.length);
  const gapWindow = schedule.gapMinutes[tod];
  const gapProgress =
    minutesSinceLast === Infinity
      ? 1
      : Math.min(1, Math.max(0, (minutesSinceLast - gapWindow.min) / Math.max(1, gapWindow.max - gapWindow.min)));

  // Base probability: 20% + boost if behind + boost if late in gap window
  const prob = Math.min(1, 0.2 + behind * 0.2 + gapProgress * 0.6);
  const roll = Math.random();
  if (roll > prob) {
    return {
      shouldPost: false,
      reason: `probability skip (rolled ${roll.toFixed(2)} > prob ${prob.toFixed(2)})`,
      meta: { timeOfDay: tod, minutesSinceLast, todayCount: today.length, todayTarget: schedule.dailyTweetTarget },
    };
  }

  // ── Pick a pillar via weighted random ──
  // Exclude pillars that are at their daily-max already, AND exclude
  // gm_grin/gn_grin (those fire only via the priority slots above —
  // never via probabilistic rotation, to enforce once-per-day).
  const baseWeights = cfg.pillars.timeWeights[tod];
  const filteredWeights: Record<string, number> = {};
  for (const [name, w] of Object.entries(baseWeights)) {
    if (name === "gm_grin" || name === "gn_grin") continue;
    const pillarCfg = cfg.pillars.pillars[name];
    const dailyMax = pillarCfg?.dailyTarget?.max;
    if (typeof dailyMax === "number" && (todayByPillar[name] || 0) >= dailyMax) continue;
    filteredWeights[name] = w;
  }
  const pillar = pickWeighted(filteredWeights);
  if (!pillar) {
    return { shouldPost: false, reason: `no eligible pillar for ${tod} (all at daily max)` };
  }

  return {
    shouldPost: true,
    pillar,
    reason: `picked ${pillar} for ${tod} slot`,
    meta: {
      timeOfDay: tod,
      minutesSinceLast: minutesSinceLast === Infinity ? undefined : minutesSinceLast,
      todayCount: today.length,
      todayTarget: schedule.dailyTweetTarget,
      budgetRemaining: { images: budget.images.remaining, tokens: budget.tokens.remaining },
    },
  };
}

function pickWeighted(weights: Record<string, number>): string | null {
  const entries = Object.entries(weights).filter(([, w]) => w > 0);
  if (entries.length === 0) return null;
  const total = entries.reduce((s, [, w]) => s + w, 0);
  let roll = Math.random() * total;
  for (const [name, w] of entries) {
    roll -= w;
    if (roll <= 0) return name;
  }
  return entries[entries.length - 1][0];
}
