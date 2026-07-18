import { NextResponse } from "next/server";
import { checkAdminAuth } from "@/lib/auth";
import { Redis } from "@upstash/redis";
import { kvKey } from "@/lib/config";
import { randomBytes } from "crypto";

export const dynamic = "force-dynamic";

/**
 * POST /api/admin/lora/upload-ticket
 *
 * Mints a short-lived, single-use ticket for the Vercel Blob direct-upload
 * handshake. The @vercel/blob client controls the Authorization header on
 * its own request, so /upload-token can't use our normal Bearer pattern —
 * but putting the ADMIN_SECRET itself in the query string leaked it into
 * request logs and browser history. Now the dashboard trades its Bearer
 * secret for a 120s ticket here, and only the ticket rides in the URL.
 */
export async function POST(request: Request) {
  const unauthorized = checkAdminAuth(request);
  if (unauthorized) return unauthorized;

  const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) {
    return NextResponse.json({ error: "KV not configured" }, { status: 500 });
  }
  const redis = new Redis({ url, token, automaticDeserialization: false });

  const ticket = randomBytes(24).toString("base64url");
  await redis.set(kvKey(`lora:upload-ticket:${ticket}`), "1", { ex: 120 });

  return NextResponse.json({ ticket, expiresInSeconds: 120 });
}
