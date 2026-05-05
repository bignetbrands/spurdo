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
    "",
    "─── VOICE FAILURE MODE (most common mistake) ───",
    "DO NOT just drop articles and call it Spurdish. 'spurdo sit on bench waitin for bus' is NOT Spurdish — it's broken English.",
    "",
    `Spurdish requires AT LEAST ONE of these per tweet (ideally more):`,
    `  • An iconic vocab word: ${voice.requiredVocab.join(", ")}, fug, gib, dubs`,
    voice.bSwap.enabled
      ? `  • A B-for-P swap: ${(voice.bSwap.examples.p_to_b || []).slice(0, 8).join(", ") || "benis, ebin, bumb, bost"}`
      : "",
    voice.bSwap.enabled
      ? `  • A dropped-double or ending: ${[...(voice.bSwap.examples.drop_double || []), ...(voice.bSwap.examples.drop_ending_consonant || [])].slice(0, 8).join(", ")}`
      : "",
    "",
    "BAD (sounds dumb, no flavor):",
    "  ✗ 'spurdo sit on bench waitin for bus. bus come early. spurdo not ready'",
    "  ✗ 'humans make list of tings to do. spurdo jus does ting'",
    "  ✗ 'stubbed toe on da table. same table. evry day. spurdo stil grinnin'",
    "",
    "GOOD (real Spurdish, contains iconic markers):",
    "  ✓ 'spurdo wait for bus. bus came erly. ebin chaos :DDD'",
    "  ✓ 'humans make list. spurdo jus dubs. erryone bumb :DDD'",
    "  ✓ 'stubd toe on bencher. evry day same bencher. gib benis :D'",
    "",
    "Notice how the GOOD versions contain benis/ebin/dubs/gib AND have the wobble — not just dropped articles.",
    "",
    "─── OTHER ───",
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

  // Universal negative prompt — applies to both SDXL and FLUX paths.
  // SDXL stacks can OPTIONALLY append additional negativeTags from
  // stackConfig (e.g. SDXL-specific quality tags like 'low quality, blurry').
  const baseNegative = cfg.imagePrompts.lockedNegativePrompt ?? "";

  if (wantsTags && lockedPromptTemplateTags) {
    const sdxlConfig = stackConfig?.stack === "sdxl-stylized" ? stackConfig : null;
    const qualityPrefix = sdxlConfig?.qualityTags ? sdxlConfig.qualityTags + ", " : "";
    const stackNegative = sdxlConfig?.negativeTags ?? "";
    // Merge: project-wide negatives + stack-specific negatives, deduped by simple split/filter
    const merged = [baseNegative, stackNegative].filter(Boolean).join(", ");
    return {
      prompt: qualityPrefix + lockedPromptTemplateTags.replace("[SCENE]", scene),
      negativePrompt: merged,
      format: "tags",
      scene,
    };
  }

  // Default: natural language (FLUX, OpenAI, fallback)
  return {
    prompt: lockedPromptTemplate.replace("[SCENE]", scene),
    negativePrompt: baseNegative,
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
  void cfg; // signature kept stable; cfg currently unused but reserved for future personalization
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
  lines.push(`- Read what they actually said. Reply with a SPECIFIC reaction to their actual content, not a generic grin.`);
  lines.push(`- Each reply must be DIFFERENT from any pattern you've used before. NEVER default to "spurdo grinnin" or "spurdo stil here grinnin" or any variation. THAT IS BANNED.`);
  lines.push(`- Stay in character — same Spurdish voice, same emoticons, same vocab rules.`);
  lines.push(`- Keep it SHORT. One sentence ideal. Two short sentences max.`);
  lines.push(`- Don't repeat their tweet back at them. React to the vibe with NEW words.`);
  lines.push(`- Don't @ them in your reply (the X reply API handles that automatically).`);
  lines.push(`- Don't shill the token. Don't post the CA. Don't link the site.`);
  lines.push("");

  lines.push(`HOW TO REACT TO DIFFERENT VIBES (use these patterns, vary them, never repeat verbatim):`);
  lines.push(`  • Compliment ("you're building something great"): "ebin words :DDD" or "spurdo gib hug :D" or "okay erryone is bumb except u :DDD"`);
  lines.push(`  • Hostile/insult ("you're a scam"): "ok :D" or "spurdo nap now :DDD" or "okay maybe yes :D"`);
  lines.push(`  • Question you can't answer ("send me dm"): "spurdo dunno hao dm work :DDD" or "wat is dm :D" or "spurdo bress wrong button :DDD"`);
  lines.push(`  • Joke / parody account: "haha ok :DDD" or "u know me :D" or "ebin :DDDDD"`);
  lines.push(`  • Ask for collab/partnership: "gib benis first :DDD" or "spurdo think bout it :D" or "okay maybe :DDD"`);
  lines.push(`  • Confused message: "wat :D" or "spurdo confused too :DDD" or "ebin question :D"`);
  lines.push(`  • Excited message: "ebin :DDD" or "yes yes :DDD" or "spurdo excited too :D"`);
  lines.push(`  • Just an emoji: matching short reaction (e.g. "ebin :DDD" or "lol :D")`);
  lines.push(`  • Empty/spam: short reaction like "ok :D" or "wat :D"`);
  lines.push("");

  lines.push(`HARD BANS:`);
  lines.push(`- The phrase "spurdo grinnin" or "spurdo grining" or "spurdo stil grinnin" or "spurdo jus grinnin" — NEVER use any of these.`);
  lines.push(`- The phrase "spurdo stil here" — NEVER use.`);
  lines.push(`- "Spurdo just X" as a sentence template (boring, scripted, dead).`);
  lines.push("");

  lines.push(`Output ONLY the reply text. No quotes, no preamble, no explanation.`);

  return lines.join("\n");
}
