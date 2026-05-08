// ============================================================
// CORE TYPES
// ============================================================

/** A content pillar. Pillar names are configured in /config/${PROJECT}/pillars.json */
export type PillarId = string;

export interface PillarConfig {
  name: string;
  description: string;
  tone: string;
  dailyTarget: { min: number; max: number };
  model: "sonnet" | "opus" | "haiku";
  generateImage: boolean;
  exampleTweets: string[];
  /**
   * Per-pillar image override. When set, the orchestrator uses this
   * provider instead of the default (bank). Useful for posts that
   * must always be generated fresh — e.g. gm/gn posts where a curated
   * meme would feel stale, but a fresh fal-generated frame feels alive.
   */
  imageOverride?: {
    provider: "fal" | "openai" | "bank";
    /** LoRA scale override (only meaningful for fal). Default uses tuning. */
    loraScale?: number;
  };
}

export type TimeOfDay = "morning" | "afternoon" | "evening" | "latenight";

export interface PillarsConfig {
  pillars: Record<PillarId, PillarConfig>;
  timeWeights: Record<TimeOfDay, Record<PillarId, number>>;
  schedule: {
    activeStartHourUTC: number;
    activeEndHourUTC: number;
    quietHoursUTC: number[];
    dailyTweetTarget: { min: number; max: number };
    gapMinutes: Record<TimeOfDay, { min: number; max: number }>;
  };
  dailyLimits?: {
    images: number;
    anthropicTokens: number;
    comment?: string;
  };
}

export interface VoiceConfig {
  casing: { rule: string; exceptions: string[] };
  punctuation: {
    bannedChars: string[];
    allowedChars: string[];
    terminalEmoticons: string[];
    /**
     * Used to be a "default emoticon" the model would slap on every tweet.
     * Now nullable — when null, no default; the model picks an ending or
     * none at all.
     */
    primaryTerminalEmoticon: string | null;
    terminalEmoticonsNote?: string;
  };
  bannedPhrases: string[];
  bannedEmoji: string;
  /**
   * Available flavor vocab. Renamed from "classicVocab" / "requiredVocab"
   * to make explicit that these are AVAILABLE not REQUIRED. The model
   * should use them when they fit, not in every tweet.
   */
  flavorVocab: string[];
  flavorVocabNote?: string;
  bSwap: {
    enabled: boolean;
    examples: Record<string, string[]>;
    protectedNames: string[];
    protectedNamesNote: string;
  };
  register: {
    heavy: { useFor: string[]; rule: string };
    light: { useFor: string[]; rule: string };
  };
  greetings: { morning: string | null; evening: string | null; neverUse: string[] };
  lengthLimits: {
    preferredMaxChars: number;
    absoluteMaxChars: number;
    preferredMaxLines: number;
  };
  exclusions: Record<string, string | boolean>;
}

// ============================================================
// IMAGE GENERATION STACKS
// ============================================================
// A "gen stack" is a complete pipeline for producing images for
// a project: base model + LoRA approach + prompt format + training
// endpoint. Different stacks suit different visual styles. Each
// project declares its stack in image-prompts.json; the dispatcher
// in lib/image-gen.ts and lib/lora.ts route accordingly.
//
// Adding a new stack: add a literal here, add a branch in the
// dispatcher, document the StackConfig shape in this comment.
// ============================================================

/**
 * Identifiers for the supported generation stacks.
 *
 * - "flux-photoreal": Fal's flux-lora endpoint with optional identity LoRA.
 *   Best for: photoreal / polished illustration / clean cartoon styles.
 *   Native language prompting. What ET uses, what M2 originally shipped.
 *
 * - "sdxl-stylized": Fal's lora endpoint (SDXL base) with stacked LoRAs:
 *   one for visual style (MS Paint, doodle, amateur internet art, etc.)
 *   and one for character identity. Tag-based prompting (Pony/SDXL
 *   convention). Best for: deliberately-amateur / stylized / non-photoreal.
 *
 * - "openai-only": OpenAI gpt-image-1. No LoRA support; use for projects
 *   that need a fallback or have ultra-simple needs.
 *
 * - "bank-only": No generation at all. Image always pulled from memedepot.
 *   Best for: meme-curation projects where generation can never beat
 *   authentic source material (e.g., pixel art accounts, classic-meme accounts).
 */
export type GenStack = "flux-photoreal" | "sdxl-stylized" | "openai-only" | "bank-only";

/** Type of LoRA in a stacked-LoRA setup */
export type LoraRole = "identity" | "style";

export interface StackedLora {
  /** Public URL to the .safetensors file (Fal CDN, HuggingFace, Civitai etc) */
  url: string;
  /** Conceptual role — used for ordering and UI labels */
  role: LoraRole;
  /** Effect strength — 0.5 (subtle) to 1.5 (strong). Default 1.0. */
  scale?: number;
  /** Human-readable label for the dashboard */
  label?: string;
  /** Trigger word baked into the LoRA's training captions, if any */
  triggerWord?: string;
}

/**
 * Per-stack configuration. Different stacks expose different fields.
 * Discriminated union on `stack`.
 */
export type StackConfig =
  | {
      stack: "flux-photoreal";
      /** Fal endpoint for inference. Default: "fal-ai/flux-lora" */
      inferenceEndpoint?: string;
      /** Fal endpoint for LoRA training. Default: "fal-ai/flux-lora-fast-training" */
      trainingEndpoint?: string;
      /** Default identity LoRA scale at inference. */
      defaultLoraScale?: number;
      /** Number of inference steps. Default 28. */
      numInferenceSteps?: number;
      /** Guidance scale. FLUX likes low values (3-4). Default 3.5. */
      guidanceScale?: number;
    }
  | {
      stack: "sdxl-stylized";
      /** Fal endpoint for inference. Default: "fal-ai/lora" (SDXL with LoRAs) */
      inferenceEndpoint?: string;
      /** Fal endpoint for LoRA training. Default: "fal-ai/fast-sdxl-lora-training" */
      trainingEndpoint?: string;
      /**
       * Style LoRAs to ALWAYS stack on top of the identity LoRA.
       * For Spurdo this should include an MS-Paint style LoRA.
       * Identity LoRA is added separately from the project's active LoRA registry.
       */
      defaultStyleLoras?: StackedLora[];
      /** Default identity LoRA scale. SDXL identity LoRAs often want 1.0-1.3. */
      defaultIdentityScale?: number;
      /**
       * Quality-tag prefix for prompts. Pony/SDXL convention uses
       * `score_9, score_8_up, score_7_up` to bias toward higher quality.
       * Set to "" if your style LoRA dislikes them.
       */
      qualityTags?: string;
      /** Negative prompt prefix. */
      negativeTags?: string;
      /** Inference steps. SDXL likes 25-40. Default 30. */
      numInferenceSteps?: number;
      /** Guidance scale. SDXL likes 6-9. Default 7.0. */
      guidanceScale?: number;
    }
  | {
      stack: "openai-only";
      model?: string;
      size?: string;
      quality?: "low" | "medium" | "high";
    }
  | {
      stack: "bank-only";
      /** No fields needed — bank handles everything */
    };

export interface ImagePromptsConfig {
  /**
   * Which generation pipeline to use when the operator picks "fal" or
   * triggers automatic generation. The dispatcher reads this and routes
   * to the right stack. The bank provider always works regardless.
   */
  genStack: GenStack;
  /** Stack-specific config. Schema depends on genStack. */
  stackConfig?: StackConfig;
  /**
   * Image providers shown in the COMPOSE dropdown.
   *   "bank"   — pull from memedepot
   *   "custom" — operator uploads an image directly (bypasses generation)
   *   "fal"    — invoke the configured genStack (flux or sdxl)
   *   "openai" — invoke openai-image directly (legacy fallback)
   */
  allowedProviders?: Array<"bank" | "custom" | "fal" | "openai">;
  allowedProvidersComment?: string;

  // === Legacy / OpenAI-specific (still used) ===
  model: string;
  size: string;
  quality: "low" | "medium" | "high";

  // === Prompt content ===
  /** Natural-language prompt template for FLUX/OpenAI. SDXL stacks override per-stack. */
  lockedPromptTemplate: string;
  /**
   * Negative prompt for the FLUX stack (or any natural-language stack
   * that supports it). Comma-separated phrases describing what NOT to
   * render. Useful when FLUX's training-data biases pull output away
   * from canon (e.g. a male brown bear getting feminized into a
   * housewife archetype when placed in a kitchen scene). Optional —
   * empty string is fine.
   */
  lockedNegativePrompt?: string;
  /**
   * SDXL/Pony tag-based prompt template. Used only when genStack is sdxl-stylized.
   * Comma-separated tags with [SCENE] placeholder.
   */
  lockedPromptTemplateTags?: string;
  scenesByPillar: Record<PillarId, string[]>;
  hardExclusions: string[];
  visualCanonChecklist: string[];
}

export interface AccountsConfig {
  xHandle: string;
  xUserId: string | null;
  ogQuantsChatId: string;
  familyAccounts: Array<{ handle: string; label: string }>;
  engagementRules: {
    replyToFamilyEachCycle: boolean;
    replyToMentionsAlways: boolean;
    engageBigAccountsOnMentions: boolean;
    raidModeRequiresOperatorToggle: boolean;
  };
}

export interface TokenConfig {
  ticker: string;
  tickerProtected: boolean;
  characterName: string;
  characterNameProtected: boolean;
  contractAddress: string;
  chain: string;
  launchpad: string;
  site: string;
  memeBank: string;
  depositMultisig?: string;
}

export interface ProjectConfig {
  projectId: string;
  character: string; // raw markdown of character.md
  pillars: PillarsConfig;
  voice: VoiceConfig;
  imagePrompts: ImagePromptsConfig;
  accounts: AccountsConfig;
  token: TokenConfig;
}

// ============================================================
// RUNTIME TYPES
// ============================================================

export interface GeneratedTweet {
  text: string;
  pillar: PillarId;
  imageUrl?: string;
  rawImageUrl?: string;
  imageMediaId?: string;
}

export interface TweetRecord {
  id: string;
  text: string;
  pillar: PillarId;
  postedAt: string;
  hasImage: boolean;
}

export interface DailyState {
  date: string;
  tweets: TweetRecord[];
  pillarCounts: Record<PillarId, number>;
}

export interface SchedulerDecision {
  shouldTweet: boolean;
  pillar?: PillarId;
  useTrending?: boolean;
  reason: string;
}
