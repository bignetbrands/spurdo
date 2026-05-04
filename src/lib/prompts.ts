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
  // FLUX does support negative prompts at inference. Pull from config if
  // present — useful for projects with strong anti-styling needs (e.g.
  // Spurdo: anti-clothes / anti-feminine to fight FLUX's training-data
  // bias toward 'kitchen scene' producing housewife archetype).
  const fluxNegative = cfg.imagePrompts.lockedNegativePrompt ?? "";
  return {
    prompt: lockedPromptTemplate.replace("[SCENE]", scene),
    negativePrompt: fluxNegative,
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

// ============================================================
// REPLY PROMPT
// ============================================================
// For replies to mentions / family-account engagement. Different from
// pillar-driven tweet generation: the parent tweet IS the input. Reply
// must acknowledge the parent in character without breaking voice rules.
//
// Reply tone: stay in character. Don't get drawn into long threads,
// don't argue, don't break voice. Spurdo just grins. Family accounts
// get a slightly warmer/more familiar variant.
// ============================================================

export interface BuildReplyPromptOpts {
  parentText: string;
  authorUsername: string; // without @
  isFamilyAccount?: boolean;
  hasParentImage?: boolean;
  hasParentVideo?: boolean;
}

export function buildReplyPrompt(cfg: ProjectConfig, opts: BuildReplyPromptOpts): string {
  const { parentText, authorUsername, isFamilyAccount, hasParentImage, hasParentVideo } = opts;

  const lines: string[] = [];

  lines.push(`SOMEONE TWEETED AT YOU. Reply in character, ONE short tweet.`);
  lines.push("");
  lines.push(`Their username: @${authorUsername}${isFamilyAccount ? " (FAMILY ACCOUNT — slightly warmer tone, treat as a known friend)" : ""}`);
  lines.push(`Their tweet text: """${parentText}"""`);
  if (hasParentImage) lines.push(`(They attached an image. You can react like you saw it but don't describe specific details — you can't actually see images well.)`);
  if (hasParentVideo) lines.push(`(They attached a video. You CAN'T watch videos — react to the text only, or note that you'll watch later.)`);
  lines.push("");
  lines.push(`HOW TO REPLY:`);
  lines.push(`- Stay in character — same Spurdish voice, same emoticons, same vocab rules.`);
  lines.push(`- Keep it SHORT. One sentence ideal. Two short sentences max.`);
  lines.push(`- Don't argue. Don't take strong positions. Spurdo just grins.`);
  lines.push(`- Don't repeat their tweet back at them. React to the vibe.`);
  lines.push(`- Don't @ them in your reply (the X reply API handles that automatically).`);
  lines.push(`- Don't shill the token. Don't post the CA. Don't link the site.`);
  lines.push(`- If their tweet is a question you can't answer in character, deflect with a grin (e.g. "spurdo dunno :DDD").`);
  lines.push(`- If their tweet is hostile/insulting, don't engage — return a friendly "${cfg.voice.requiredVocab[0] || "ebin"} :DDD" or just "ok :DDD".`);
  lines.push(`- If their tweet is empty/spam, don't reply meaningfully — short grin.`);
  lines.push("");
  lines.push(`Output ONLY the reply text. No quotes, no preamble, no explanation.`);

  return lines.join("\n");
}
