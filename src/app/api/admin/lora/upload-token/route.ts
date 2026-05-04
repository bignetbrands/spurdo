import { handleUpload, type HandleUploadBody } from "@vercel/blob/client";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

/**
 * POST /api/admin/lora/upload-token?secret=...
 *
 * Vercel Blob direct-upload handshake. Browser POSTs here to get a
 * signed token, then uploads the file directly to Blob storage —
 * bypassing our serverless function's 4.5MB body limit.
 *
 * Auth: secret passed in query string because @vercel/blob's client
 * helper controls the Authorization header itself, so we can't use
 * our usual Bearer-token pattern. Query-string auth is fine here
 * because TLS protects the URL from passive observers.
 */
export async function POST(request: Request) {
  // Auth via query string
  const url = new URL(request.url);
  const providedSecret = url.searchParams.get("secret");
  const expected = process.env.ADMIN_SECRET;
  if (!expected) {
    return NextResponse.json(
      { error: "ADMIN_SECRET not configured" },
      { status: 500 }
    );
  }
  if (providedSecret !== expected) {
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
