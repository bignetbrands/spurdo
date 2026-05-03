import { Redis } from "@upstash/redis";
import { kvKey, loadConfig } from "./config";

// ============================================================
// MEME BANK
// ============================================================
// Fetches curated authentic character memes from a GitHub repo.
// The bank is the source of truth for projects whose visual style
// FLUX/DALL-E doesn't natively produce well (Spurdo / MS Paint /
// crude / amateur internet art). Generation stays available for
// projects whose style commercial models do well (photorealism,
// polished illustration).
//
// Repo layout convention:
//   bignetbrands/${PROJECT}-memes
//     └── memes/
//         ├── spurdo-sauna-winter-headshot.png
//         ├── spurdo-pure_reactions-grin.png
//         └── ...
//
// Filename tags: hyphen/underscore-separated tokens in the filename
// (excluding extension). When a token matches a known pillar ID,
// it becomes the entry's primaryPillar. All other tokens are
// general tags for matching/filtering.
//
// The bank manifest is cached in KV for 1 hour. To force refresh,
// call refreshBank(). The dashboard's "refresh bank" button hits
// this when you've pushed new memes to the repo.
// ============================================================

export interface MemeEntry {
  filename: string;
  rawUrl: string; // GitHub raw content URL (cdn-quality, fast)
  tags: string[]; // lowercased tokens parsed from filename
  primaryPillar?: string; // first tag that matches a known pillar (if any)
  sizeBytes?: number;
}

export interface BankManifest {
  fetchedAt: string;
  repoSlug: string; // "owner/repo@branch"
  count: number;
  entries: MemeEntry[];
  /** Set if fetch failed; manifest will be empty/stale */
  error?: string;
}

// ────────── KV ──────────

let _redis: Redis | null = null;
function r(): Redis {
  if (_redis) return _redis;
  const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) throw new Error("KV not configured");
  _redis = new Redis({ url, token });
  return _redis;
}

const MANIFEST_KEY = () => kvKey("memebank:manifest");
const MANIFEST_TTL_SECONDS = 60 * 60; // 1 hour cache

// ────────── Repo coordinates (overridable via env) ──────────

function getRepoSlug(): string {
  const fromEnv = process.env.MEME_BANK_REPO;
  if (fromEnv) return fromEnv;
  const cfg = loadConfig();
  return `bignetbrands/${cfg.projectId}-memes`;
}

function getBranch(): string {
  return process.env.MEME_BANK_BRANCH || "main";
}

function getPath(): string {
  return process.env.MEME_BANK_PATH || "memes";
}

// ────────── Filename → entry parsing ──────────

const IMAGE_EXT_RE = /\.(png|jpe?g|webp|gif)$/i;

function parseEntry(filename: string, rawUrl: string, sizeBytes: number, knownPillars: Set<string>): MemeEntry {
  const stem = filename.replace(IMAGE_EXT_RE, "");

  // Tokenize on hyphens, dots, and runs of underscores.
  // BUT preserve underscores as part of multi-word pillar IDs (pure_reactions, scene_vignettes).
  // Strategy: split on hyphens + dots, then check each chunk for pillar matches first;
  // if no match, further split underscores into separate tags.
  const chunks = stem.split(/[-.\s]+/).filter(Boolean);
  const tags: string[] = [];
  let primaryPillar: string | undefined;

  for (const raw of chunks) {
    const chunk = raw.toLowerCase();
    if (knownPillars.has(chunk)) {
      // Whole chunk is a pillar id (e.g., "pure_reactions" without splitting underscores)
      tags.push(chunk);
      if (!primaryPillar) primaryPillar = chunk;
      continue;
    }
    // No exact pillar match — split underscores too
    const sub = chunk.split(/_+/).filter(Boolean);
    for (const t of sub) tags.push(t);
  }

  return { filename, rawUrl, tags, primaryPillar, sizeBytes };
}

// ────────── GitHub fetch ──────────

async function fetchFromGitHub(): Promise<BankManifest> {
  const repoSlug = getRepoSlug();
  const branch = getBranch();
  const path = getPath();
  const cfg = loadConfig();
  const knownPillars = new Set(Object.keys(cfg.pillars.pillars));

  const apiUrl = `https://api.github.com/repos/${repoSlug}/contents/${path}?ref=${branch}`;
  const headers: Record<string, string> = {
    "User-Agent": "spurdo-meme-bank",
    Accept: "application/vnd.github.v3+json",
  };
  if (process.env.GITHUB_TOKEN) {
    headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  }

  const res = await fetch(apiUrl, { headers });
  if (!res.ok) {
    if (res.status === 404) {
      throw new Error(
        `meme bank repo or path not found: ${repoSlug}/${path} (branch ${branch}). create the repo + push some images to ${path}/, or override MEME_BANK_REPO env.`
      );
    }
    if (res.status === 403) {
      // Likely rate limit — GitHub allows 60/hr unauthenticated, 5000/hr with token
      throw new Error(
        `github API forbidden (${res.status}). likely rate-limited. set GITHUB_TOKEN env to raise the limit.`
      );
    }
    throw new Error(`github API error ${res.status}: ${apiUrl}`);
  }

  const items = (await res.json()) as Array<{
    name: string;
    type: string;
    download_url: string | null;
    size: number;
  }>;

  const entries: MemeEntry[] = items
    .filter((item) => item.type === "file" && IMAGE_EXT_RE.test(item.name) && item.download_url)
    .map((item) => parseEntry(item.name, item.download_url!, item.size, knownPillars));

  return {
    fetchedAt: new Date().toISOString(),
    repoSlug: `${repoSlug}@${branch}`,
    count: entries.length,
    entries,
  };
}

// ────────── Public API ──────────

/**
 * Get the current manifest. Returns cached if fresh (< 1h),
 * fetches fresh otherwise. If GitHub is unreachable but we have
 * a stale cached manifest, returns the stale one with .error set.
 */
export async function getManifest(force: boolean = false): Promise<BankManifest> {
  if (!force) {
    try {
      const cached = await r().get<string | BankManifest>(MANIFEST_KEY());
      if (cached) {
        const m = typeof cached === "string" ? (JSON.parse(cached) as BankManifest) : cached;
        return m;
      }
    } catch {
      // KV read failed — fall through to fetch
    }
  }

  try {
    const fresh = await fetchFromGitHub();
    try {
      await r().set(MANIFEST_KEY(), JSON.stringify(fresh), { ex: MANIFEST_TTL_SECONDS });
    } catch {
      // KV write failed — proceed with what we have
    }
    return fresh;
  } catch (err) {
    // Fetch failed — try to return stale cache if any
    try {
      const stale = await r().get<string | BankManifest>(MANIFEST_KEY());
      if (stale) {
        const m = typeof stale === "string" ? (JSON.parse(stale) as BankManifest) : stale;
        return { ...m, error: err instanceof Error ? err.message : String(err) };
      }
    } catch {
      // No stale cache, no fresh — propagate
    }
    throw err;
  }
}

/** Force-refresh the cache. Used by the dashboard "↻ refresh bank" button. */
export async function refreshBank(): Promise<BankManifest> {
  return getManifest(true);
}

/**
 * Pick a meme appropriate for a given pillar.
 *
 * Match priority:
 *   1. Entries whose primaryPillar === pillarId
 *   2. Entries with pillarId in their tags
 *   3. Any entry (fallback)
 *
 * Returns null if the bank is empty.
 */
export async function pickMemeForPillar(pillarId: string): Promise<MemeEntry | null> {
  const manifest = await getManifest();
  if (manifest.entries.length === 0) return null;

  const primary = manifest.entries.filter((e) => e.primaryPillar === pillarId);
  if (primary.length > 0) return pickRandom(primary);

  const tagged = manifest.entries.filter((e) => e.tags.includes(pillarId));
  if (tagged.length > 0) return pickRandom(tagged);

  return pickRandom(manifest.entries);
}

/** Pick a random meme regardless of pillar. */
export async function pickRandomMeme(): Promise<MemeEntry | null> {
  const manifest = await getManifest();
  if (manifest.entries.length === 0) return null;
  return pickRandom(manifest.entries);
}

function pickRandom<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}
