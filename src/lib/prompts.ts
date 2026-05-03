import type { ProjectConfig, PillarId, TimeOfDay } from "@/types";

// ============================================================
// PROMPT BUILDERS
// ============================================================
// All prompts are built FROM the project config — no hardcoded
// character knowledge lives in this file. To swap projects,
// swap /config/${PROJECT}/ — never edit prompts.ts.
// ============================================================

/**
 * Build the system prompt that establishes the character.
 * Combines character.md + voice rules + key constraints.
 */
export function buildSystemPrompt(cfg: ProjectConfig): string {
  const { character, voice, token } = cfg;

  // The character.md file IS the bulk of the system prompt — it's already
  // written in second-person ("You are X") with voice rules, hard rules,
  // and examples. We append a short structural reminder.
  const reminders = [
    "",
    "─── HARD CONSTRAINTS (re-stated for safety) ───",
    voice.casing.rule === "all_lowercase"
      ? `- ALL LOWERCASE always. Exceptions: ${voice.casing.exceptions.join(", ")}.`
      : "",
    `- Banned punctuation: ${voice.punctuation.bannedChars.join(" ")}`,
    `- Terminal emoticons: ${voice.punctuation.terminalEmoticons.join(", ")}. Primary: ${voice.punctuation.primaryTerminalEmoticon}.`,
    `- Banned phrases (NEVER use): ${voice.bannedPhrases.join(", ")}.`,
    `- Required vocab (use frequently): ${voice.requiredVocab.join(", ")}.`,
    voice.bSwap.enabled
      ? `- Protected names (NEVER B-swap): ${voice.bSwap.protectedNames.join(", ")}. ${voice.bSwap.protectedNamesNote}`
      : "",
    `- Max characters per tweet: ${voice.lengthLimits.preferredMaxChars} preferred, ${voice.lengthLimits.absoluteMaxChars} absolute.`,
    `- Token CA (the only valid one): ${token.contractAddress}.`,
    "",
    "Output ONLY the tweet text. No commentary, no explanation, no quotes around the text. Just the tweet.",
  ];

  return character + "\n" + reminders.filter(Boolean).join("\n");
}

/**
 * Build a tweet generation prompt for a specific pillar.
 * Includes pillar context, examples, recent tweets (for variety), and time of day.
 */
export function buildTweetPrompt(
  cfg: ProjectConfig,
  pillarId: PillarId,
  opts: {
    recentTweets?: string[];
    timeOfDay?: TimeOfDay;
  } = {}
): string {
  const pillar = cfg.pillars.pillars[pillarId];
  if (!pillar) throw new Error(`Unknown pillar: ${pillarId}`);

  const lines: string[] = [];

  lines.push(`CONTENT PILLAR: ${pillar.name}`);
  lines.push(`Description: ${pillar.description}`);
  lines.push(`Tone: ${pillar.tone}`);
  lines.push("");

  if (pillar.exampleTweets.length > 0) {
    lines.push("EXAMPLES of this pillar (do NOT copy these — write something new in this style):");
    for (const ex of pillar.exampleTweets) lines.push(`  • ${ex}`);
    lines.push("");
  }

  if (opts.timeOfDay) {
    lines.push(`Time of day: ${opts.timeOfDay} UTC. Match the energy of this time slot.`);
    lines.push("");
  }

  if (opts.recentTweets && opts.recentTweets.length > 0) {
    lines.push("RECENT TWEETS (don't repeat structure or content — be different):");
    for (const t of opts.recentTweets.slice(0, 8)) lines.push(`  • ${t}`);
    lines.push("");
  }

  lines.push(`Write ONE new tweet for this pillar. Output ONLY the tweet text — no quotes, no preamble, no explanation.`);

  return lines.join("\n");
}

export interface ImagePromptResult {
  /** Positive prompt sent to the model */
  prompt: string;
  /** Negative prompt — only used by SDXL stack, empty otherwise */
  negativePrompt: string;
  /** Format used: "natural" for FLUX/OpenAI, "tags" for SDXL */
  format: "natural" | "tags";
  /** The chosen scene (for logs/audit) */
  scene: string;
}

/**
 * Build the image generation prompt for a tweet.
 *
 * Stack-aware:
 *   - flux-photoreal / openai-only / bank-only → uses lockedPromptTemplate
 *     (natural language). Negative prompt is empty (FLUX doesn't use them
 *     and OpenAI handles negatives differently).
 *   - sdxl-stylized → uses lockedPromptTemplateTags (Pony/SDXL tag
 *     convention). Prepends qualityTags from stackConfig. Returns
 *     negativeTags from stackConfig as the negative prompt.
 *
 * If the stack expects tags but the project doesn't have a tag template,
 * falls back to using the natural template (still produces output, just
 * less optimal).
 */
export function buildImagePrompt(
  cfg: ProjectConfig,
  pillarId: PillarId,
  tweetText: string,
  sceneOverride?: string
): ImagePromptResult {
  const { lockedPromptTemplate, lockedPromptTemplateTags, scenesByPillar, genStack, stackConfig } = cfg.imagePrompts;

  // Pick a scene: explicit override > pillar's scene list > generic flat
  let scene = sceneOverride;
  if (!scene) {
    const candidates = scenesByPillar[pillarId];
    if (candidates && candidates.length > 0) {
      scene = candidates[Math.floor(Math.random() * candidates.length)];
    }
  }
  if (!scene) {
    scene = "a flat off-white background, just the character centered as a portrait";
  }

  // Determine which format the active stack wants
  const wantsTags = genStack === "sdxl-stylized";

  if (wantsTags && lockedPromptTemplateTags) {
    const sdxlConfig = stackConfig?.stack === "sdxl-stylized" ? stackConfig : null;
    const qualityPrefix = sdxlConfig?.qualityTags ? sdxlConfig.qualityTags + ", " : "";
    const negative = sdxlConfig?.negativeTags ?? "";
    return {
      prompt: qualityPrefix + lockedPromptTemplateTags.replace("[SCENE]", scene),
      negativePrompt: negative,
      format: "tags",
      scene,
    };
  }

  // Default: natural language (FLUX, OpenAI, fallback)
  return {
    prompt: lockedPromptTemplate.replace("[SCENE]", scene),
    negativePrompt: "",
    format: "natural",
    scene,
  };
}

/**
 * Determine current time of day in UTC.
 */
export function timeOfDayUTC(): TimeOfDay {
  const hour = new Date().getUTCHours();
  if (hour >= 5 && hour < 12) return "morning";
  if (hour >= 12 && hour < 18) return "afternoon";
  if (hour >= 18 && hour < 23) return "evening";
  return "latenight";
}
