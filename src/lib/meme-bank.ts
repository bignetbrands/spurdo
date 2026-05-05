import { Redis } from "@upstash/redis";
import { kvKey, loadConfig } from "./config";

// ============================================================
// MEME BANK — MEMEDEPOT SCRAPER
// ============================================================
// Pulls authentic curated memes from memedepot.com/d/${slug}
// Same pattern ET uses: memedepot has no API but the depot pages
// are public HTML and the images are served via Cloudflare's
// imagedelivery CDN at predictable URLs. We fetch the page,
// regex-extract image IDs, construct CDN URLs.
//
// Why scrape vs an API: memedepot has no programmatic API. Period.
// Their pages are public, their CDN is public. This is allowed by
// their robots.txt and matches how their own page renders images.
//
// Filename-based tags from earlier design DON'T apply here —
// memedepot doesn't expose filenames. We fetch by ID + URL only.
// Pillar matching is therefore RANDOM rather than tag-driven.
// (Future: optional KV-backed tagging UI in /bot to map IDs to tags.)
//
// Caching: manifest cached in KV for 1h. Scrape is best-effort —
// if memedepot is down we serve from KV (or empty if no cache yet).
// ============================================================

export interface MemeEntry {
  id: string; // memedepot/cloudflare image ID
  rawUrl: string; // CDN URL ready to attach to a tweet
  source: "scraped" | "fallback";
}

export interface BankManifest {
  fetchedAt: string;
  source: string; // "memedepot.com/d/${slug}"
  count: number;
  scrapedCount: number;
  fallbackCount: number;
  entries: MemeEntry[];
  /** Set if scrape failed; manifest may be stale or fallback-only */
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

const MANIFEST_KEY = () => {
  // Version the cache key by the exclusion set. When operators add a new
  // banned ID, the next call gets a clean cache miss + fresh scrape that
  // honors the new list — no manual ↻ refresh required.
  const excludes = Array.from(getExcludeIds()).sort().join(",");
  // Short hash so the key doesn't get too long
  let h = 0;
  for (let i = 0; i < excludes.length; i++) h = ((h << 5) - h + excludes.charCodeAt(i)) | 0;
  return kvKey(`memebank:manifest:v${(h >>> 0).toString(36)}`);
};
const MANIFEST_TTL_SECONDS = 60 * 60; // 1 hour

// ────────── Source coordinates ──────────

/** memedepot slug — typically the same as projectId. Override via MEMEDEPOT_SLUG env. */
function getDepotSlug(): string {
  return process.env.MEMEDEPOT_SLUG || loadConfig().projectId;
}

/** Width param for the CDN URL. Lower = faster fetches but lower quality. */
function getCdnWidth(): string {
  return process.env.MEMEDEPOT_CDN_WIDTH || "1080";
}

/**
 * Fallback IDs — hardcoded known good IDs that are always served
 * even if scraping fails on first run. Comma-separated env var.
 *
 * To populate: visit memedepot.com/d/${slug}, view-source, search
 * for /imagedelivery/, copy the ID portion of each URL into this var.
 *
 * Set in Vercel as MEMEDEPOT_FALLBACK_IDS=id1,id2,id3,...
 */
function getFallbackIds(): string[] {
  const raw = process.env.MEMEDEPOT_FALLBACK_IDS;
  if (!raw) return [];
  const excludeIds = getExcludeIds();
  return raw
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter((s) => /^[a-f0-9-]{36}$/.test(s))
    .filter((s) => !excludeIds.has(s));
}

/**
 * Cloudflare imagedelivery account ID.
 * Discovered automatically on first scrape (parsed from any URL on the depot page).
 * Cached in KV alongside the manifest. Override via env if you know it.
 */
function getEnvCfAccountId(): string | null {
  return process.env.MEMEDEPOT_CF_ACCOUNT_ID || null;
}

/**
 * UUIDs to exclude from the scraped manifest. Used for the depot's
 * profile banner image, any pinned UI assets, off-canon variants
 * uploaded by accident, etc.
 *
 * Hardcoded list applies to all projects (we know specific bad IDs
 * from incidents). Env var MEMEDEPOT_EXCLUDE_IDS adds project-specific
 * additions (comma-separated UUIDs).
 *
 * Mirrors ET's BANNER_ID pattern but extended to multiple IDs.
 */
const HARDCODED_EXCLUDE_IDS = new Set<string>([
  // Spurdo depot's banner image (reported by operator)
  "1aa675c1-2040-4f0d-8149-3a84ab394b00",
]);

function getExcludeIds(): Set<string> {
  const fromEnv = process.env.MEMEDEPOT_EXCLUDE_IDS;
  if (!fromEnv) return HARDCODED_EXCLUDE_IDS;
  const envIds = fromEnv
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter((s) => /^[a-f0-9-]{36}$/.test(s));
  return new Set([...HARDCODED_EXCLUDE_IDS, ...envIds]);
}

// ────────── Scrape ──────────

/**
 * Fetch the depot page and extract image IDs + the Cloudflare account.
 *
 * Memedepot's HTML contains image URLs of the form:
 *   /cdn-cgi/imagedelivery/${CF_ACCOUNT_ID}/${IMAGE_ID}/width=...
 *
 * Both pieces are regex-extractable. We collect every unique IMAGE_ID
 * we see, and capture the first CF_ACCOUNT_ID we find (it's the same
 * across all images on a single depot).
 */
async function scrapeMemedepot(): Promise<{ cfAccountId: string; ids: string[] }> {
  const slug = getDepotSlug();
  const url = `https://memedepot.com/d/${slug}`;

  const res = await fetch(url, {
    headers: { "User-Agent": "Mozilla/5.0 (compatible; SpurdoBot/1.0; +https://spurdosparde.fun)" },
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`memedepot fetch failed: HTTP ${res.status} for ${url}`);
  const html = await res.text();

  // Pattern: imagedelivery/{ACCOUNT}/{IMAGE_ID}/width=...
  // ACCOUNT is base62-ish, IMAGE_ID is a UUID.
  const pattern = /imagedelivery\/([a-zA-Z0-9_-]+)\/([a-f0-9-]{36})\//g;
  const ids = new Set<string>();
  const excludeIds = getExcludeIds();
  let cfAccountId: string | null = getEnvCfAccountId();
  let match;
  while ((match = pattern.exec(html)) !== null) {
    const id = match[2].toLowerCase();
    if (!cfAccountId) cfAccountId = match[1];
    if (excludeIds.has(id)) continue; // skip banner / known bad IDs
    ids.add(id);
  }

  if (!cfAccountId) {
    throw new Error(`could not find any imagedelivery URLs on ${url}. is the depot empty? does the slug exist?`);
  }

  return { cfAccountId, ids: Array.from(ids) };
}

function buildCdnUrl(cfAccountId: string, imageId: string): string {
  return `https://memedepot.com/cdn-cgi/imagedelivery/${cfAccountId}/${imageId}/width=${getCdnWidth()}`;
}

// ────────── Manifest building ──────────

async function buildManifest(): Promise<BankManifest> {
  const slug = getDepotSlug();
  const fallbackIds = getFallbackIds();

  let scraped: { cfAccountId: string; ids: string[] } | null = null;
  let scrapeError: string | undefined;

  try {
    scraped = await scrapeMemedepot();
  } catch (err) {
    scrapeError = err instanceof Error ? err.message : String(err);
  }

  // Determine the CF account ID to use for fallback URLs:
  //   1. If scrape succeeded, use that
  //   2. Otherwise env var
  //   3. Otherwise we can't build URLs — fallback IDs become useless
  const cfAccountId = scraped?.cfAccountId || getEnvCfAccountId();

  const scrapedEntries: MemeEntry[] =
    scraped && cfAccountId
      ? scraped.ids.map((id) => ({
          id,
          rawUrl: buildCdnUrl(cfAccountId, id),
          source: "scraped" as const,
        }))
      : [];

  const fallbackEntries: MemeEntry[] =
    cfAccountId && fallbackIds.length > 0
      ? fallbackIds
          .filter((id) => !scrapedEntries.some((e) => e.id === id)) // de-dup
          .map((id) => ({
            id,
            rawUrl: buildCdnUrl(cfAccountId, id),
            source: "fallback" as const,
          }))
      : [];

  const entries = [...scrapedEntries, ...fallbackEntries];

  const manifest: BankManifest = {
    fetchedAt: new Date().toISOString(),
    source: `memedepot.com/d/${slug}`,
    count: entries.length,
    scrapedCount: scrapedEntries.length,
    fallbackCount: fallbackEntries.length,
    entries,
  };
  if (scrapeError) manifest.error = scrapeError;

  return manifest;
}

// ────────── Public API ──────────

/**
 * Get the current manifest. Returns cached if fresh (< 1h),
 * fetches fresh otherwise. If memedepot is unreachable but we
 * have a stale cached manifest, returns the stale one with .error.
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
      // KV read failed — fall through
    }
  }

  const fresh = await buildManifest();

  // Cache successful builds. Even if scrape errored, if we got fallback
  // entries it's worth caching so we don't pound memedepot every call.
  if (fresh.count > 0) {
    try {
      await r().set(MANIFEST_KEY(), JSON.stringify(fresh), { ex: MANIFEST_TTL_SECONDS });
    } catch {
      // KV write failed — proceed
    }
  }

  return fresh;
}

/** Force-refresh. Used by the dashboard "↻ refresh bank" button. */
export async function refreshBank(): Promise<BankManifest> {
  return getManifest(true);
}

/**
 * Pick a meme. Memedepot images are untagged from our side, so
 * this is uniformly random. (We accept pillarId for API symmetry
 * with the GitHub-bank version and to enable future tagging.)
 */
// How many recent picks to remember and avoid re-picking. With ~30 memes
// in bank and 5 posts/day, a buffer of 12 means each meme has time to
// "rest" for ~2.5 days before being eligible again. Tunable.
const RECENT_PICKS_BUFFER = 12;

async function getRecentPicks(): Promise<string[]> {
  try {
    const raw = await r().get<string[]>(kvKey("bank:recent-picks"));
    return Array.isArray(raw) ? raw : [];
  } catch {
    return [];
  }
}

async function pushRecentPick(memeId: string): Promise<void> {
  try {
    const list = await getRecentPicks();
    const filtered = list.filter((id) => id !== memeId);
    filtered.unshift(memeId);
    const trimmed = filtered.slice(0, RECENT_PICKS_BUFFER);
    await r().set(kvKey("bank:recent-picks"), trimmed);
  } catch {
    // non-fatal — dedupe is a quality-of-life feature, not safety-critical
  }
}

/**
 * Pick a meme for a pillar, avoiding recently-used ones.
 *
 * Strategy: filter out the last N picks, then random-pick from what
 * remains. If filtering would leave <2 memes (degenerate case — bank
 * smaller than the buffer), fall back to picking from anything except
 * the most recent single pick.
 */
export async function pickMemeForPillar(_pillarId: string): Promise<MemeEntry | null> {
  const m = await getManifest();
  if (m.entries.length === 0) return null;

  const recent = await getRecentPicks();
  const recentSet = new Set(recent);

  // Pool = everything not in recent buffer
  let pool = m.entries.filter((e) => !recentSet.has(e.id));

  // Degenerate: bank smaller than buffer — fall back to "anything but most recent 1"
  if (pool.length < 2) {
    const lastPicked = recent[0];
    pool = m.entries.filter((e) => e.id !== lastPicked);
  }

  // Final fallback (bank has only 1 meme)
  if (pool.length === 0) {
    pool = m.entries;
  }

  const picked = pool[Math.floor(Math.random() * pool.length)];
  await pushRecentPick(picked.id);
  return picked;
}

export async function pickRandomMeme(): Promise<MemeEntry | null> {
  return pickMemeForPillar("");
}
