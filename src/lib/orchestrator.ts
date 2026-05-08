import { generateTweet, generateReply } from "./claude";
import { generateImage } from "./image-gen";
import { postTweet, isDryRun } from "./twitter";
import type { PostTweetResult } from "./twitter";
import { recordTweet, getRecentTweets, isKillSwitchActive } from "./store";
import { logEvent } from "./events";
import { loadConfig } from "./config";
import { BudgetExceededError } from "./budget";
import { retryWithBackoff } from "./retry";
import { buildReplyPrompt } from "./prompts";
import type { PillarId, ProjectConfig } from "@/types";

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
  /** LoRA scale override (only meaningful for fal). Falls back to pillar config or KV tuning. */
  loraScaleOverride?: number;
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
      // Provider precedence: explicit caller override > pillar.imageOverride > default
      // (which falls through to image-gen.ts's bank default)
      const effectiveProvider = opts.imageProvider ?? pillar.imageOverride?.provider;
      const effectiveLoraScale =
        opts.loraScaleOverride ??
        (pillar.imageOverride?.provider === "fal" ? pillar.imageOverride.loraScale : undefined);

      const img = await generateImage({
        pillarId: opts.pillar,
        tweetText: text,
        sceneOverride: opts.sceneOverride,
        provider: effectiveProvider,
        loraScale: effectiveLoraScale,
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

// ============================================================
// REPLY ORCHESTRATOR
// ============================================================
// Single entry point for replying to a tweet. Generates a Spurdish
// reply (using buildReplyPrompt + Claude), optionally attaches a bank
// meme, posts as an in-reply-to, records to KV.
//
// Mention-based replies and family-account engagement both call this.
// Both are auth'd through the same X API connection, both consume the
// daily token budget, both are governed by the kill switch.
// ============================================================

export interface ExecuteReplyOptions {
  parentTweetId: string;
  parentText: string;
  authorUsername: string;
  isFamilyAccount?: boolean;
  hasParentImage?: boolean;
  hasParentVideo?: boolean;
  /** If true, attach a random bank meme (default: false — replies are usually text-only) */
  includeImage?: boolean;
  /** Trigger label for the event log */
  trigger: "cron-mention" | "cron-family" | "manual";
}

export interface ExecuteReplyResult {
  ok: boolean;
  error?: string;
  budgetExceeded?: { resource: string; used: number; limit: number };
  tweetId?: string;
  url?: string;
  text?: string;
  hasImage?: boolean;
  dryRun?: boolean;
  imageProvider?: string;
  parentTweetId: string;
  authorUsername: string;
  elapsedMs: number;
}

export async function executeReply(opts: ExecuteReplyOptions): Promise<ExecuteReplyResult> {
  const startTime = Date.now();

  if (await isKillSwitchActive()) {
    return {
      ok: false,
      error: "kill switch active",
      parentTweetId: opts.parentTweetId,
      authorUsername: opts.authorUsername,
      elapsedMs: Date.now() - startTime,
    };
  }

  const cfg = loadConfig();

  // ── Generate reply text ──
  const replyPrompt = buildReplyPrompt(cfg, {
    parentText: opts.parentText,
    authorUsername: opts.authorUsername,
    isFamilyAccount: opts.isFamilyAccount,
    hasParentImage: opts.hasParentImage,
    hasParentVideo: opts.hasParentVideo,
  });

  let replyText: string;
  try {
    const gen = await generateReply({
      systemPrompt: buildReplySystemPrompt(cfg),
      userPrompt: replyPrompt,
      model: "haiku", // fast + cheap for replies; pillars use sonnet
      maxTokens: 200,
    });
    replyText = gen.text.trim();
  } catch (err) {
    if (err instanceof BudgetExceededError) {
      return {
        ok: false,
        error: err.message,
        budgetExceeded: { resource: "tokens", used: 0, limit: 0 },
        parentTweetId: opts.parentTweetId,
        authorUsername: opts.authorUsername,
        elapsedMs: Date.now() - startTime,
      };
    }
    return {
      ok: false,
      error: `reply generation failed: ${err instanceof Error ? err.message : err}`,
      parentTweetId: opts.parentTweetId,
      authorUsername: opts.authorUsername,
      elapsedMs: Date.now() - startTime,
    };
  }

  if (!replyText) {
    return {
      ok: false,
      error: "Claude returned empty reply text",
      parentTweetId: opts.parentTweetId,
      authorUsername: opts.authorUsername,
      elapsedMs: Date.now() - startTime,
    };
  }

  // ── Optional image attach (default off — replies usually text only) ──
  let imageUrl: string | undefined;
  let imageProvider: string | undefined;
  if (opts.includeImage) {
    try {
      const img = await generateImage({
        pillarId: "pure_reactions",
        provider: "bank",
        // Pass the reply text so the bank picker uses Haiku smart-match
        // to find a contextually relevant meme. Same dedupe rules apply.
        tweetText: replyText,
      });
      imageUrl = img.imageUrl;
      imageProvider = img.provider;
    } catch (err) {
      console.warn("[orchestrator/reply] bank pick failed, posting text-only:", err);
    }
  }

  // ── Post reply ──
  let posted: PostTweetResult;
  try {
    const retryResult = await retryWithBackoff(
      () =>
        postTweet({
          text: replyText,
          imageUrl,
          inReplyToTweetId: opts.parentTweetId,
        }),
      {
        maxAttempts: 2,
        initialDelayMs: 2000,
        onRetry: (attempt, err) =>
          console.warn(`[orchestrator/reply] retry ${attempt}:`, err instanceof Error ? err.message : err),
      }
    );
    posted = retryResult.result;
  } catch (err) {
    await logEvent("error", `reply post failed for @${opts.authorUsername}`, {
      parentTweetId: opts.parentTweetId,
      error: err instanceof Error ? err.message : String(err),
      trigger: opts.trigger,
    }).catch(() => undefined);
    return {
      ok: false,
      error: `X post failed: ${err instanceof Error ? err.message : err}`,
      parentTweetId: opts.parentTweetId,
      authorUsername: opts.authorUsername,
      elapsedMs: Date.now() - startTime,
    };
  }

  await logEvent("post", `reply to @${opts.authorUsername} → ${posted.tweetId}`, {
    parentTweetId: opts.parentTweetId,
    replyTweetId: posted.tweetId,
    text: replyText,
    hasImage: posted.hasImage,
    dryRun: posted.dryRun,
    trigger: opts.trigger,
    isReply: true,
  }).catch(() => undefined);

  return {
    ok: true,
    tweetId: posted.tweetId,
    url: posted.url,
    text: posted.text,
    hasImage: posted.hasImage,
    dryRun: posted.dryRun,
    imageProvider,
    parentTweetId: opts.parentTweetId,
    authorUsername: opts.authorUsername,
    elapsedMs: Date.now() - startTime,
  };
}

/** Build the system prompt for replies. Same character as tweets but
 *  with reply-specific reminders. */
function buildReplySystemPrompt(cfg: ProjectConfig): string {
  const reminders = [
    "",
    "─── REPLY CONTEXT (additional rules) ───",
    `- This is a REPLY to someone's tweet. Stay short. Stay in character.`,
    `- ALL LOWERCASE always. Banned punctuation: ${cfg.voice.punctuation.bannedChars.join(" ")}`,
    `- Banned phrases: ${cfg.voice.bannedPhrases.slice(0, 8).join(", ")}.`,
    `- Available flavor vocab (not required, use when fits): ${cfg.voice.flavorVocab.slice(0, 8).join(", ")}.`,
    cfg.voice.bSwap.protectedNames.length > 0
      ? `- Never B-swap: ${cfg.voice.bSwap.protectedNames.join(", ")}.`
      : "",
    `- Max ${cfg.voice.lengthLimits.preferredMaxChars} chars preferred. Keep it short.`,
    "",
    "Output ONLY the reply text. No quotes, no preamble, no @-mention prefix (X handles that automatically).",
  ].filter(Boolean);

  return cfg.character + "\n" + reminders.join("\n");
}
