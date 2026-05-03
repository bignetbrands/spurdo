import Anthropic from "@anthropic-ai/sdk";
import { loadConfig } from "./config";
import { buildSystemPrompt, buildTweetPrompt, timeOfDayUTC } from "./prompts";
import { assertTokenBudget, recordTokenSpend } from "./budget";
import type { PillarId } from "@/types";

// ============================================================
// CLAUDE WRAPPER
// ============================================================

const MODELS = {
  haiku: "claude-haiku-4-5",
  sonnet: "claude-sonnet-4-6",
  opus: "claude-opus-4-7",
} as const;

let _client: Anthropic | null = null;

function getClient(): Anthropic {
  if (!_client) {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) throw new Error("ANTHROPIC_API_KEY not set");
    _client = new Anthropic({ apiKey });
  }
  return _client;
}

/**
 * Generate a tweet for a given pillar.
 * Returns just the tweet text (cleaned of quotes/whitespace).
 * Throws BudgetExceededError if daily token cap reached.
 */
export async function generateTweet(
  pillarId: PillarId,
  opts: {
    recentTweets?: string[];
    timeOfDay?: ReturnType<typeof timeOfDayUTC>;
  } = {}
): Promise<{ text: string; pillar: PillarId; model: string; tokensUsed: number }> {
  await assertTokenBudget();

  const cfg = loadConfig();
  const pillar = cfg.pillars.pillars[pillarId];
  if (!pillar) throw new Error(`Unknown pillar: ${pillarId}`);

  const model = MODELS[pillar.model];
  const system = buildSystemPrompt(cfg);
  const userPrompt = buildTweetPrompt(cfg, pillarId, {
    recentTweets: opts.recentTweets,
    timeOfDay: opts.timeOfDay ?? timeOfDayUTC(),
  });

  const response = await getClient().messages.create({
    model,
    max_tokens: 200,
    system,
    messages: [{ role: "user", content: userPrompt }],
    temperature: 0.95,
  });

  const block = response.content[0];
  const raw = block.type === "text" ? block.text : "";
  const cleaned = cleanTweetText(raw);
  const tokensUsed = response.usage.input_tokens + response.usage.output_tokens;

  await recordTokenSpend(tokensUsed).catch(() => {
    /* don't fail if KV write fails */
  });

  return {
    text: cleaned,
    pillar: pillarId,
    model,
    tokensUsed,
  };
}

/**
 * Generate text using arbitrary system + user prompts. Used for replies
 * (where the prompt is built from the parent tweet, not from a pillar).
 *
 * Caller passes its own system + user prompts. Token budget IS still
 * checked and recorded — replies count against the same daily quota.
 */
export async function generateReply(opts: {
  systemPrompt: string;
  userPrompt: string;
  /** Which Claude model. Replies default to haiku for speed/cost. */
  model?: "haiku" | "sonnet" | "opus";
  maxTokens?: number;
  temperature?: number;
}): Promise<{ text: string; model: string; tokensUsed: number }> {
  await assertTokenBudget();

  const model = MODELS[opts.model || "haiku"];
  const response = await getClient().messages.create({
    model,
    max_tokens: opts.maxTokens ?? 200,
    system: opts.systemPrompt,
    messages: [{ role: "user", content: opts.userPrompt }],
    temperature: opts.temperature ?? 0.85, // slightly less random than tweets — replies need to track context
  });

  const block = response.content[0];
  const raw = block.type === "text" ? block.text : "";
  const cleaned = cleanTweetText(raw);
  const tokensUsed = response.usage.input_tokens + response.usage.output_tokens;

  await recordTokenSpend(tokensUsed).catch(() => undefined);

  return { text: cleaned, model, tokensUsed };
}

/**
 * Clean up tweet text from the LLM:
 * - strip surrounding quotes
 * - trim whitespace
 * - collapse multiple blank lines
 */
function cleanTweetText(raw: string): string {
  let t = raw.trim();
  // Strip wrapping quotes (single, double, smart)
  t = t.replace(/^["'""'']|["'""'']$/g, "").trim();
  // Strip a leading "Tweet:" or similar preamble (defensive)
  t = t.replace(/^(tweet|post|response|output)\s*[:\-]\s*/i, "").trim();
  // Collapse 3+ newlines to 2
  t = t.replace(/\n{3,}/g, "\n\n");
  return t;
}
