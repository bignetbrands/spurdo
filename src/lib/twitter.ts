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
