import { NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { checkAdminAuth } from "@/lib/auth";
import { getUntaggedMemes, setMemeTagRecord, getAllMemeTags } from "@/lib/meme-bank";

export const dynamic = "force-dynamic";
export const maxDuration = 300; // up to 5 min — sequential vision calls add up

interface TagResponse {
  tags: string[];
  caption: string;
}

/**
 * GET /api/admin/bank/tag — returns count of tagged + untagged memes
 * POST /api/admin/bank/tag — tags up to N untagged memes with Claude Vision
 *
 * One-time per meme: each meme image is sent to Claude Sonnet, which
 * returns a short caption + 4-8 mood/scene/theme tags. Stored in KV
 * keyed by meme ID — survives bank refreshes.
 *
 * After tagging, /api/admin/lora/calibrate (and the autonomous cron)
 * use Haiku to match tweet → meme based on these tags.
 *
 * Cost: Sonnet vision is ~$0.015 per meme. A 30-meme bank costs
 * ~$0.45 to tag. Re-tagging only happens for new memes added in
 * subsequent bank-refresh cycles.
 *
 * Body: { batchSize?: number } — how many memes to tag in this run.
 *   Defaults to 10. Hard cap at 30 to stay under maxDuration.
 */
export async function GET(request: Request) {
  const unauthorized = checkAdminAuth(request);
  if (unauthorized) return unauthorized;

  const tags = await getAllMemeTags();
  const untagged = await getUntaggedMemes();
  return NextResponse.json({
    ok: true,
    taggedCount: Object.keys(tags).length,
    untaggedCount: untagged.length,
    untaggedIds: untagged.map((e) => e.id),
  });
}

export async function POST(request: Request) {
  const unauthorized = checkAdminAuth(request);
  if (unauthorized) return unauthorized;

  let body: { batchSize?: number } = {};
  try {
    body = await request.json();
  } catch {
    // empty body OK
  }
  const batchSize = Math.min(30, Math.max(1, body.batchSize || 10));

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return NextResponse.json(
      { ok: false, error: "ANTHROPIC_API_KEY not set" },
      { status: 500 }
    );
  }
  const anthropic = new Anthropic({ apiKey });

  const untagged = await getUntaggedMemes();
  if (untagged.length === 0) {
    return NextResponse.json({ ok: true, message: "all memes already tagged", taggedThisRun: 0 });
  }

  const toTag = untagged.slice(0, batchSize);
  const results: Array<{ id: string; ok: boolean; tags?: string[]; caption?: string; error?: string }> = [];

  // Sequential — vision calls can run concurrently but we'd hit rate
  // limits, and 10 calls × ~3s each fits comfortably in maxDuration.
  for (const meme of toTag) {
    try {
      const tagResult = await tagSingleMeme(anthropic, meme.rawUrl);
      await setMemeTagRecord(meme.id, {
        tags: tagResult.tags,
        caption: tagResult.caption,
        taggedAt: new Date().toISOString(),
      });
      results.push({ id: meme.id, ok: true, tags: tagResult.tags, caption: tagResult.caption });
    } catch (err) {
      results.push({
        id: meme.id,
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return NextResponse.json({
    ok: true,
    taggedThisRun: results.filter((r) => r.ok).length,
    failed: results.filter((r) => !r.ok).length,
    remaining: untagged.length - toTag.length,
    results,
  });
}

/**
 * Send a single image URL to Claude Vision and parse out tags + caption.
 * Returns { tags, caption } or throws.
 */
async function tagSingleMeme(
  anthropic: Anthropic,
  imageUrl: string
): Promise<TagResponse> {
  const userMessage = `Look at this Spurdo meme image. Generate metadata to help match it with relevant tweets later.

Reply with ONLY a JSON object, no other text. Schema:
{
  "caption": "one short sentence describing what's happening",
  "tags": ["4-8 short lowercase tags covering mood, scene, theme, characters"]
}

Tag categories to consider (pick what fits):
  - mood: grinning, confused, angry, smug, tired, anxious, peaceful, excited, defeated
  - scene: indoors, outdoors, home, office, kitchen, forest, gym, store, computer, phone
  - theme: trading, money, food, sleep, work, relationships, weather, travel, technology
  - characters: solo, two-spurdos, group, with-other-character
  - composition: close-up, full-body, speech-text, no-text, comic-panels, single-panel
  - actions: sitting, standing, walking, holding, looking, eating, sleeping, fighting

Be specific. "two-spurdos arguing about jeeting bags" gets tags like:
  ["arguing", "two-spurdos", "speech-text", "trading", "confrontation", "indoors"]

Respond with ONLY the JSON. No prose, no markdown fences.`;

  const response = await anthropic.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 500,
    messages: [
      {
        role: "user",
        content: [
          {
            type: "image",
            source: { type: "url", url: imageUrl },
          },
          { type: "text", text: userMessage },
        ],
      },
    ],
  });

  const block = response.content[0];
  if (!block || block.type !== "text") {
    throw new Error("vision returned non-text response");
  }
  const text = block.text.trim();

  // Strip markdown fences if Claude added them despite instructions
  const cleaned = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/, "").trim();

  let parsed: { caption?: unknown; tags?: unknown };
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    throw new Error(`vision returned invalid JSON: ${text.slice(0, 100)}`);
  }

  const caption = typeof parsed.caption === "string" ? parsed.caption.trim() : "";
  const tags = Array.isArray(parsed.tags)
    ? parsed.tags.filter((t): t is string => typeof t === "string" && t.length > 0).map((t) => t.toLowerCase())
    : [];

  if (!caption || tags.length === 0) {
    throw new Error("vision response missing caption or tags");
  }
  return { caption, tags };
}
