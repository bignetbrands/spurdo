import { handleUpload, type HandleUploadBody } from "@vercel/blob/client";
import { NextResponse } from "next/server";
import { Redis } from "@upstash/redis";
import { kvKey } from "@/lib/config";

export const dynamic = "force-dynamic";

/**
 * POST /api/admin/lora/upload-token?ticket=...
 *
 * Vercel Blob direct-upload handshake. Browser POSTs here to get a
 * signed token, then uploads the file directly to Blob storage —
 * bypassing our serverless function's 4.5MB body limit.
 *
 * Auth: @vercel/blob's client helper controls the Authorization header
 * itself, so this route can't use our usual Bearer pattern. Instead the
 * dashboard first trades its Bearer secret for a short-lived single-use
 * ticket at /api/admin/lora/upload-ticket, and only that ticket rides in
 * the query string — never the ADMIN_SECRET (query strings land in
 * request logs and browser history).
 */
export async function POST(request: Request) {
  const url = new URL(request.url);
  const ticket = url.searchParams.get("ticket");
  if (!ticket || !/^[A-Za-z0-9_-]{16,64}$/.test(ticket)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const kvUrl = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
  const kvToken = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!kvUrl || !kvToken) {
    return NextResponse.json({ error: "KV not configured" }, { status: 500 });
  }
  const redis = new Redis({ url: kvUrl, token: kvToken, automaticDeserialization: false });
  // Single-use: DEL returns 1 only for the caller that actually removed the
  // key, so a replayed ticket (from a log or history) is worthless.
  const consumed = await redis.del(kvKey(`lora:upload-ticket:${ticket}`));
  if (consumed !== 1) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = (await request.json()) as HandleUploadBody;

  try {
    const jsonResponse = await handleUpload({
      body,
      request,
      onBeforeGenerateToken: async (pathname) => {
        if (!/^loras\//.test(pathname)) {
          throw new Error("path must start with loras/");
        }
        if (!/\.(safetensors|tar|bin)$/i.test(pathname)) {
          throw new Error("file must be .safetensors, .tar, or .bin");
        }
        return {
          allowedContentTypes: [
            "application/octet-stream",
            "application/x-tar",
            "application/x-safetensors",
          ],
          maximumSizeInBytes: 500 * 1024 * 1024,
          addRandomSuffix: true,
        };
      },
      onUploadCompleted: async () => {
        // Finalization happens via /register-uploaded
      },
    });
    return NextResponse.json(jsonResponse);
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 400 }
    );
  }
}
