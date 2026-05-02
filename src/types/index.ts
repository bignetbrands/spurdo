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
}

export interface VoiceConfig {
  casing: { rule: string; exceptions: string[] };
  punctuation: {
    bannedChars: string[];
    allowedChars: string[];
    terminalEmoticons: string[];
    primaryTerminalEmoticon: string;
  };
  bannedPhrases: string[];
  bannedEmoji: string;
  requiredVocab: string[];
  classicVocab: string[];
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

export interface ImagePromptsConfig {
  referenceImage: string;
  model: string;
  size: string;
  quality: "low" | "medium" | "high";
  lockedPromptTemplate: string;
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
