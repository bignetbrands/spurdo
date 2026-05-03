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

const MANIFEST_KEY = () => kvKey("memebank:manifest");
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
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => /^[a-f0-9-]{36}$/i.test(s));
}

/**
 * Cloudflare imagedelivery account ID.
 * Discovered automatically on first scrape (parsed from any URL on the depot page).
 * Cached in KV alongside the manifest. Override via env if you know it.
 */
function getEnvCfAccountId(): string | null {
  return process.env.MEMEDEPOT_CF_ACCOUNT_ID || null;
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
  let cfAccountId: string | null = getEnvCfAccountId();
  let match;
  while ((match = pattern.exec(html)) !== null) {
    if (!cfAccountId) cfAccountId = match[1];
    ids.add(match[2]);
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
export async function pickMemeForPillar(_pillarId: string): Promise<MemeEntry | null> {
  const m = await getManifest();
  if (m.entries.length === 0) return null;
  return m.entries[Math.floor(Math.random() * m.entries.length)];
}

export async function pickRandomMeme(): Promise<MemeEntry | null> {
  return pickMemeForPillar("");
}
