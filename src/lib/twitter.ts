import { TwitterApi, TwitterApiReadWrite } from "twitter-api-v2";

// ============================================================
// TWITTER (X API v2 + v1.1 media)
// ============================================================
// Posts tweets, optionally with an image.
//
// Why v2 + v1.1: tweet creation is v2, but media upload is still
// only on v1.1. twitter-api-v2 handles both seamlessly.
//
// DRY_RUN=1 in env disables the actual X call — useful for
// testing the pipeline without consuming X API quota or posting
// real tweets.
// ============================================================

let _client: TwitterApiReadWrite | null = null;

function getClient(): TwitterApiReadWrite {
  if (_client) return _client;
  const apiKey = process.env.TWITTER_API_KEY;
  const apiSecret = process.env.TWITTER_API_SECRET;
  const accessToken = process.env.TWITTER_ACCESS_TOKEN;
  const accessSecret = process.env.TWITTER_ACCESS_TOKEN_SECRET;

  if (!apiKey || !apiSecret || !accessToken || !accessSecret) {
    throw new Error(
      "Twitter creds missing — need TWITTER_API_KEY, TWITTER_API_SECRET, TWITTER_ACCESS_TOKEN, TWITTER_ACCESS_TOKEN_SECRET"
    );
  }

  const client = new TwitterApi({
    appKey: apiKey,
    appSecret: apiSecret,
    accessToken,
    accessSecret,
  });
  _client = client.readWrite;
  return _client;
}

export function isDryRun(): boolean {
  const v = process.env.DRY_RUN;
  return v === "1" || v === "true";
}

export interface PostTweetOptions {
  text: string;
  /** Optional image URL — fetched and attached if provided */
  imageUrl?: string;
  /** Optional reply target tweet ID (used by M4 reply engine) */
  inReplyToTweetId?: string;
}

export interface PostTweetResult {
  tweetId: string;
  text: string;
  url: string;
  hasImage: boolean;
  dryRun: boolean;
}

/**
 * Post a tweet, optionally with an image.
 * Throws on failure. Returns the new tweet's ID + URL.
 *
 * In DRY_RUN mode: skips the API call, returns a fake tweet ID prefixed "dryrun_".
 */
export async function postTweet(opts: PostTweetOptions): Promise<PostTweetResult> {
  const text = opts.text.trim();
  if (!text) throw new Error("postTweet: empty text");

  const dryRun = isDryRun();

  if (dryRun) {
    const fakeId = `dryrun_${Date.now()}`;
    return {
      tweetId: fakeId,
      text,
      url: `https://x.com/dryrun/status/${fakeId}`,
      hasImage: !!opts.imageUrl,
      dryRun: true,
    };
  }

  const client = getClient();
  let mediaId: string | undefined;

  // Upload image if provided
  if (opts.imageUrl) {
    try {
      const buffer = await fetchImageBuffer(opts.imageUrl);
      const mimeType = guessMimeType(opts.imageUrl);
      mediaId = await client.v1.uploadMedia(buffer, { mimeType });
    } catch (err) {
      // Don't fail the whole post — try posting text-only as a fallback
      console.warn("[twitter] media upload failed, posting text-only:", err);
    }
  }

  const tweetPayload: {
    text: string;
    media?: { media_ids: [string] };
    reply?: { in_reply_to_tweet_id: string };
  } = { text };

  if (mediaId) {
    tweetPayload.media = { media_ids: [mediaId] };
  }
  if (opts.inReplyToTweetId) {
    tweetPayload.reply = { in_reply_to_tweet_id: opts.inReplyToTweetId };
  }

  const tweet = await client.v2.tweet(tweetPayload);
  const tweetId = tweet.data.id;
  return {
    tweetId,
    text,
    url: `https://x.com/i/status/${tweetId}`,
    hasImage: !!mediaId,
    dryRun: false,
  };
}

// ============================================================
// Mention fetching
// ============================================================

export interface Mention {
  /** Tweet ID of the mention */
  id: string;
  /** Tweet text */
  text: string;
  /** When the tweet was posted */
  createdAt: string;
  /** Twitter user ID of the author */
  authorId: string;
  /** Author's screen name (without @) */
  authorUsername: string;
  /** Author's display name */
  authorName: string;
  /** ID of the conversation root, useful for thread-aware replies */
  conversationId?: string;
  /** ID of the tweet this mention is replying to, if any */
  inReplyToTweetId?: string;
  /** URLs of any images in the mention itself */
  imageUrls: string[];
  /** True if the mention has a video (we can't see videos) */
  hasVideo: boolean;
}

/**
 * Fetch mentions of @${TWITTER_HANDLE} since the given tweet ID.
 * Pass undefined sinceId on first run; subsequent runs should pass
 * the highest ID seen so far so we only get genuinely new mentions.
 *
 * Returns an empty array in DRY_RUN mode (no API calls). Returns an
 * empty array if no user_id is configured (we need it for the v2
 * mentions timeline endpoint).
 */
export async function fetchMentions(opts: {
  userId: string;
  sinceId?: string;
  maxResults?: number;
}): Promise<Mention[]> {
  if (isDryRun()) return [];

  const client = getClient();
  const max = Math.min(Math.max(opts.maxResults ?? 20, 5), 100);

  // userMentionTimeline expects the authenticated user's numeric ID.
  // Provide rich expansions so we get author names and image URLs in one call.
  const tl = await client.v2.userMentionTimeline(opts.userId, {
    max_results: max,
    since_id: opts.sinceId,
    "tweet.fields": ["created_at", "conversation_id", "in_reply_to_user_id", "referenced_tweets", "attachments"],
    "user.fields": ["username", "name"],
    "media.fields": ["type", "url", "preview_image_url"],
    expansions: ["author_id", "attachments.media_keys"],
  });

  // Build lookup tables for the includes
  const usersById = new Map<string, { username: string; name: string }>();
  for (const u of tl.includes?.users ?? []) {
    usersById.set(u.id, { username: u.username, name: u.name });
  }
  const mediaByKey = new Map<string, { type: string; url?: string; preview_image_url?: string }>();
  for (const m of tl.includes?.media ?? []) {
    const key = (m as { media_key: string }).media_key;
    mediaByKey.set(key, m as { type: string; url?: string; preview_image_url?: string });
  }

  const out: Mention[] = [];
  for (const t of tl.data?.data ?? []) {
    const author = usersById.get(t.author_id || "");
    const mediaKeys = (t.attachments?.media_keys ?? []) as string[];
    const imageUrls: string[] = [];
    let hasVideo = false;
    for (const k of mediaKeys) {
      const m = mediaByKey.get(k);
      if (!m) continue;
      if (m.type === "video" || m.type === "animated_gif") hasVideo = true;
      const u = m.url || m.preview_image_url;
      if (u && (m.type === "photo" || m.type === "animated_gif")) imageUrls.push(u);
    }
    const referenced = (t.referenced_tweets ?? []) as Array<{ type: string; id: string }>;
    const replyRef = referenced.find((r) => r.type === "replied_to");

    out.push({
      id: t.id,
      text: t.text,
      createdAt: t.created_at || new Date().toISOString(),
      authorId: t.author_id || "",
      authorUsername: author?.username || "unknown",
      authorName: author?.name || "Unknown",
      conversationId: t.conversation_id,
      inReplyToTweetId: replyRef?.id,
      imageUrls,
      hasVideo,
    });
  }

  return out;
}

/**
 * Look up the authenticated user's numeric ID. Cached for the lifetime
 * of the process; should rarely change, and Twitter's "me" endpoint
 * is cheap enough to call once per cold start.
 */
let _meIdCache: string | null = null;
export async function getAuthenticatedUserId(): Promise<string> {
  if (_meIdCache) return _meIdCache;
  // Allow operator override via env (avoids API call entirely)
  const fromEnv = process.env.TWITTER_USER_ID;
  if (fromEnv) {
    _meIdCache = fromEnv;
    return fromEnv;
  }
  if (isDryRun()) return "dryrun_user_id";
  const client = getClient();
  const me = await client.v2.me();
  _meIdCache = me.data.id;
  return _meIdCache;
}




// ────────── helpers ──────────

async function fetchImageBuffer(url: string): Promise<Buffer> {
  // Support data URLs (OpenAI gpt-image-1 returns them) AND http URLs (Fal)
  if (url.startsWith("data:")) {
    const commaIdx = url.indexOf(",");
    if (commaIdx === -1) throw new Error("malformed data URL");
    const b64 = url.slice(commaIdx + 1);
    return Buffer.from(b64, "base64");
  }
  const res = await fetch(url);
  if (!res.ok) throw new Error(`image fetch failed: HTTP ${res.status}`);
  const ab = await res.arrayBuffer();
  return Buffer.from(ab);
}

function guessMimeType(url: string): "image/png" | "image/jpeg" | "image/gif" | "image/webp" {
  if (url.startsWith("data:image/png")) return "image/png";
  if (url.startsWith("data:image/jpeg") || url.startsWith("data:image/jpg")) return "image/jpeg";
  if (url.includes(".jpg") || url.includes(".jpeg")) return "image/jpeg";
  if (url.includes(".gif")) return "image/gif";
  if (url.includes(".webp")) return "image/webp";
  return "image/png"; // sane default; Fal returns PNG
}
