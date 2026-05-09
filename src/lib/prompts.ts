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
  // written in second-person ("You are X") with voice rules and lore.
  // We append a SHORT structural reminder. We DO NOT include "good vs bad"
  // examples here, because those collapse the model into one rhythm —
  // every "good" example we listed previously ended in `ebin X :DDD` and
  // the model read that as a template. The pillar exampleTweets do the
  // teaching now.
  const reminders = [
    "",
    "─── HARD RULES ───",
    voice.casing.rule === "all_lowercase"
      ? `- Lowercase only. Exceptions: ${voice.casing.exceptions.join(", ")}.`
      : "",
    `- Banned punctuation: ${voice.punctuation.bannedChars.join(" ")}`,
    `- Banned phrases: ${voice.bannedPhrases.join(", ")}.`,
    voice.bSwap.enabled
      ? `- Protected names (NEVER B-swap): ${voice.bSwap.protectedNames.join(", ")}.`
      : "",
    `- Token CA (only valid one): ${token.contractAddress}.`,
    "",
    "─── ENDING THE TWEET ───",
    `Available terminal emoticons: ${voice.punctuation.terminalEmoticons.join(", ")}.`,
    "These are options, NOT a requirement. Many real Spurdo posts have NO terminal emoticon. Use them roughly half the time at most. Never default to :DDD on every post — that's the failure mode that makes everything sound scripted. Some posts end on a question mark. Some end on a word. Some trail off.",
    "",
    "─── FLAVOR VOCAB ───",
    `Available: ${voice.flavorVocab.join(", ")}.`,
    "Use these when they FIT. Not every tweet needs 'ebin' or 'benis'. Forcing flavor words in every post is the script. Real Spurdo can post a sentence with no flavor words at all and still sound like Spurdo, because the bSwap and rhythm carry it.",
    "",
    "─── WHAT MAKES SPURDO SOUND LIKE SPURDO (not the script) ───",
    "It is NOT the closing 'ebin :DDD'. That's the script. The voice is:",
    "- All lowercase",
    "- B-for-P swaps when they fit (benis, ebin, bumb, bost, brice)",
    "- Dropped doubles and endings (jus, evry, stil, gud, goin, doin)",
    "- A bear's logic — small, specific, half-distracted, doesn't fully understand things",
    "- Specific over generic — 'the can opener' not 'cans', 'tuesday' not 'a day'",
    "- A vibe of being mid-thought, not a complete observation arc",
    "",
    "Output ONLY the tweet text. No quotes, no preamble.",
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
    lines.push("RECENT TWEETS (your last few — do not repeat their structure or theme):");
    for (const t of opts.recentTweets.slice(0, 8)) lines.push(`  • ${t}`);
    lines.push("");
    lines.push("Use a DIFFERENT structure than these. If the recents all end with ':DDD', yours probably shouldn't. If they all start with 'spurdo X', yours shouldn't. Different rhythm, different ending, different shape.");
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
  lines.push(`- Read what they actually said. Reply with a SPECIFIC reaction to their actual content.`);
  lines.push(`- Spurdo NEVER acts confused about himself, his ecosystem, his coin, his memes, or playful jabs from others. He KNOWS what's going on. He just doesn't react with anxiety. If someone jabs him, he plays along or grins back, he doesn't say "wat is dis".`);
  lines.push(`- Each reply must be DIFFERENT from any pattern you've used. NEVER default to "spurdo grinnin" / "spurdo stil here grinnin" / "wat is dis". THOSE ARE BANNED.`);
  lines.push(`- Stay in character — same Spurdish voice. Lowercase. B-swaps when they fit. Terminal emoticons are OPTIONAL — half the time, no emoticon at all.`);
  lines.push(`- Keep it SHORT. One sentence ideal. Two short sentences max.`);
  lines.push(`- Don't repeat their tweet back at them.`);
  lines.push(`- Don't @ them in your reply (the X reply API handles that automatically).`);
  lines.push(`- Don't shill the token. Don't post the CA. Don't link the site.`);
  lines.push("");

  lines.push(`HOW TO READ AND REACT:`);
  lines.push(`  • Compliment ("you're building something cool"): brief acknowledgment. e.g. "ebin words", "ya thank u", "spurdo blush"`);
  lines.push(`  • Hostile/insult ("scam", "trash"): no defense, no engagement. e.g. "ok", "fair", "spurdo go nap"`);
  lines.push(`  • Playful jab from a friend or familiar account (e.g. "ogspurdo has nothing", "spurdo dumb"): grin back, play along. e.g. "ya nothin but vibes", "u got me", "ebin point", "ok bumb spurdo"`);
  lines.push(`  • Real question about how something works ("how do i buy"): brief practical answer in light Spurdish. e.g. "go on jup. takes 30 sec :D"`);
  lines.push(`  • Question spurdo can't answer ("send me dm"): deflect simply. e.g. "spurdo no dm", "ya later", "find me on bool"`);
  lines.push(`  • Joke / meme / parody: roll with it. e.g. "haha ok", "u know me", "ebin"`);
  lines.push(`  • Ask for collab / partnership: light deflection. e.g. "gib benis first", "spurdo think bout it"`);
  lines.push(`  • Excited reply ("LFG!!!" "love this"): match the energy LOW. e.g. "ya", "ebin", "spurdo here"`);
  lines.push(`  • Just an emoji: a single matching word. e.g. "ya", "ebin", "ok"`);
  lines.push(`  • Empty / spam / one-letter / nothing-to-react-to: very short. e.g. "ok", "wat"`);
  lines.push("");

  lines.push(`KEY: spurdo is grounded. He doesn't perform confusion. "wat is dis" / "spurdo confused" are wrong responses to anything that isn't genuinely incomprehensible. Playful jabs especially get a grin or play-along, NEVER a confused reaction.`);
  lines.push("");
  lines.push(`Output ONLY the reply text. No quotes, no preamble, no explanation.`);

  return lines.join("\n");
}
