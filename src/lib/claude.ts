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
 * Generate an image SCENE description from a tweet's text. The scene is a
 * short visual description that gets composed into the locked character
 * template, so the generated image actually reflects what the tweet says
 * rather than being a generic background.
 *
 * Example:
 *   tweet: "wakin up. stil grinnin :DDD"
 *   →     "spurdo in bed, blanket pulled up to chest, morning light through window, eyes half-open"
 *
 * Uses haiku (cheap + fast). Falls back to a generic "flat solid background"
 * scene on error so image gen never blocks on this step.
 */
export async function generateImageScene(opts: {
  tweetText: string;
  /** Optional pillar hint — gives the model context about what the tweet category is */
  pillarHint?: string;
}): Promise<string> {
  await assertTokenBudget();

  const userPrompt = [
    `TWEET: "${opts.tweetText.trim()}"`,
    opts.pillarHint ? `PILLAR: ${opts.pillarHint}` : "",
    "",
    "Translate this tweet into a SHORT visual scene description suitable for image generation.",
    "",
    "RULES:",
    "- Output ONE LINE describing the scene/environment around the character.",
    "- 8-15 words ideal. Concrete. Visual. No abstractions.",
    "- DO NOT describe the character's appearance — that's locked elsewhere.",
    "- DO describe: setting, weather, time of day, props, posture, what they're doing.",
    "- If the tweet is purely emotional/abstract with no clear scene, default to a simple environment that matches the mood (e.g. 'sitting on snow at night, finnish forest in background').",
    "- NO text/captions/labels in the scene.",
    "",
    "Output ONLY the scene description. No quotes, no preamble, no explanation.",
  ]
    .filter(Boolean)
    .join("\n");

  try {
    const response = await getClient().messages.create({
      model: MODELS.haiku,
      max_tokens: 80,
      system:
        "You translate tweets into one-line visual scene descriptions for image generation. Output the scene only — no preamble, no quotes.",
      messages: [{ role: "user", content: userPrompt }],
      temperature: 0.7,
    });
    const block = response.content[0];
    const raw = block.type === "text" ? block.text : "";
    const cleaned = raw
      .trim()
      .replace(/^["'""'']|["'""'']$/g, "")
      .trim()
      .split("\n")[0]; // first line only — defensive against multi-line returns
    const tokensUsed = response.usage.input_tokens + response.usage.output_tokens;
    await recordTokenSpend(tokensUsed).catch(() => undefined);
    return cleaned || "flat off-white background, simple meme panel framing";
  } catch (err) {
    console.warn("[claude/scene] failed, using fallback scene:", err);
    return "flat off-white background, simple meme panel framing";
  }
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
