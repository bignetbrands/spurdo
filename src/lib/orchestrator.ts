import { generateTweet } from "./claude";
import { generateImage } from "./image-gen";
import { postTweet, isDryRun } from "./twitter";
import { recordTweet, getRecentTweets } from "./store";
import { logEvent } from "./events";
import { loadConfig } from "./config";
import { BudgetExceededError } from "./budget";
import { retryWithBackoff } from "./retry";
import type { PillarId } from "@/types";

// ============================================================
// ORCHESTRATOR
// ============================================================
// Single entry point: executeTweet(pillar, opts)
//
//   1. Generate Spurdish tweet via Claude
//   2. (optional) Generate image via Fal/OpenAI
//   3. Post to X (or dry-run)
//   4. Record to KV tweets list
//   5. Log event
//
// Used by:
//   • /api/cron/tweet            — autonomous, picks pillar via scheduler
//   • /api/admin/post-now        — manual override from /bot dashboard
//
// Failures are surfaced as structured errors AND logged. Caller
// decides how to present (dashboard shows error, cron just records).
// ============================================================

export interface ExecuteTweetOptions {
  pillar: PillarId;
  /** If false, post text-only even if pillar config says generateImage=true */
  generateImage?: boolean;
  /** Override the scene from the pillar's default list */
  sceneOverride?: string;
  /** Override the image provider */
  imageProvider?: "fal" | "openai";
  /** Provided text to post directly (skip Claude). Used by post-now after edit. */
  textOverride?: string;
  /** Provided image URL (skip image gen). Used by post-now to use compose preview. */
  imageUrlOverride?: string;
  /** Tag the event so we know what triggered this (cron / manual / etc). */
  trigger?: "cron" | "manual" | "test";
}

export interface ExecuteTweetResult {
  ok: boolean;
  tweetId?: string;
  url?: string;
  text?: string;
  hasImage?: boolean;
  pillar: PillarId;
  dryRun?: boolean;
  imageProvider?: string;
  error?: string;
  budgetExceeded?: { resource: "images" | "tokens"; used: number; limit: number };
  elapsedMs: number;
}

export async function executeTweet(opts: ExecuteTweetOptions): Promise<ExecuteTweetResult> {
  const startTime = Date.now();
  const cfg = loadConfig();
  const pillar = cfg.pillars.pillars[opts.pillar];
  if (!pillar) {
    return {
      ok: false,
      pillar: opts.pillar,
      error: `unknown pillar: ${opts.pillar}`,
      elapsedMs: 0,
    };
  }

  const trigger = opts.trigger || "manual";

  // ── Step 1: Tweet text ──
  let text: string;
  if (opts.textOverride && opts.textOverride.trim()) {
    text = opts.textOverride.trim();
  } else {
    try {
      // Pull recent tweets so Claude can avoid repeating
      const recent = await getRecentTweets(8);
      const recentTexts = recent.map((t) => t.text);
      const tweet = await generateTweet(opts.pillar, { recentTweets: recentTexts });
      text = tweet.text;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await logEvent("error", `tweet gen failed: ${msg}`, { pillar: opts.pillar, trigger });
      if (err instanceof BudgetExceededError) {
        return {
          ok: false,
          pillar: opts.pillar,
          error: msg,
          budgetExceeded: { resource: err.resource, used: err.used, limit: err.limit },
          elapsedMs: Date.now() - startTime,
        };
      }
      return { ok: false, pillar: opts.pillar, error: msg, elapsedMs: Date.now() - startTime };
    }
  }

  // ── Step 2: Image (optional) ──
  const shouldImage = opts.generateImage ?? pillar.generateImage;
  let imageUrl: string | undefined = opts.imageUrlOverride;
  let imageProvider: string | undefined;

  if (shouldImage && !imageUrl) {
    try {
      const img = await generateImage({
        pillarId: opts.pillar,
        tweetText: text,
        sceneOverride: opts.sceneOverride,
        provider: opts.imageProvider,
      });
      imageUrl = img.imageUrl;
      imageProvider = img.provider;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // Image failure is NOT fatal — post text-only as fallback
      await logEvent("warn", `image gen failed, posting text-only: ${msg}`, {
        pillar: opts.pillar,
        trigger,
      });
      imageUrl = undefined;
    }
  }

  // ── Step 3: Post ──
  let posted: Awaited<ReturnType<typeof postTweet>>;
  try {
    // Wrap the X API call in retry — transient failures are common
    const { result } = await retryWithBackoff(
      () => postTweet({ text, imageUrl }),
      {
        maxAttempts: 3,
        initialDelayMs: 2000,
        onRetry: (attempt, err) =>
          console.warn(`[orchestrator] post retry ${attempt}:`, err instanceof Error ? err.message : err),
      }
    );
    posted = result;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await logEvent("error", `post failed after retries: ${msg}`, { pillar: opts.pillar, trigger, text });
    return { ok: false, pillar: opts.pillar, error: msg, elapsedMs: Date.now() - startTime };
  }

  // ── Step 4: Record to KV ──
  try {
    await recordTweet({
      id: posted.tweetId,
      text: posted.text,
      pillar: opts.pillar,
      postedAt: new Date().toISOString(),
      url: posted.url,
      hasImage: posted.hasImage,
      imageProvider,
      dryRun: posted.dryRun,
    });
  } catch (err) {
    // KV write failed AFTER posting — log but don't fail the result
    console.error("[orchestrator] KV record failed:", err);
    await logEvent("warn", `posted but KV record failed: ${err instanceof Error ? err.message : err}`, {
      pillar: opts.pillar,
      trigger,
      tweetId: posted.tweetId,
    });
  }

  // ── Step 5: Log success event ──
  await logEvent("post", `${posted.dryRun ? "[DRY-RUN] " : ""}posted ${opts.pillar}`, {
    pillar: opts.pillar,
    trigger,
    tweetId: posted.tweetId,
    url: posted.url,
    text: posted.text,
    hasImage: posted.hasImage,
    imageProvider,
  });

  return {
    ok: true,
    tweetId: posted.tweetId,
    url: posted.url,
    text: posted.text,
    hasImage: posted.hasImage,
    pillar: opts.pillar,
    dryRun: posted.dryRun,
    imageProvider,
    elapsedMs: Date.now() - startTime,
  };
}

/** Re-export for cron route convenience */
export { isDryRun };
