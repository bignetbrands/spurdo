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
