import { NextResponse } from "next/server";
import { put } from "@vercel/blob";
import { checkAdminAuth } from "@/lib/auth";
import { addToRegistry } from "@/lib/lora";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const MAX_BYTES = 500 * 1024 * 1024; // 500 MB cap (LoRAs are ~170MB, .tar ~250MB)
const ALLOWED_EXT = /\.(safetensors|tar|bin)$/i;

/**
 * POST /api/admin/lora/upload-trained
 *
 * Accepts a pre-trained LoRA file from the operator's computer (e.g.,
 * downloaded from Replicate, civitai, or any other source). Uploads it
 * to Vercel Blob (permanent storage), then adds the resulting public
 * URL to the LoRA registry.
 *
 * This is the "I already have a trained LoRA" path — bypasses the
 * train flow entirely.
 *
 * Form fields:
 *   - file: File             ← .safetensors or .tar (required)
 *   - notes: string          ← optional label
 *   - trainedForStack: enum  ← "sdxl-stylized" | "flux-photoreal"
 *   - artStyle: enum         ← "mspaint" | "photorealistic"
 */
export async function POST(request: Request) {
  const unauthorized = checkAdminAuth(request);
  if (unauthorized) return unauthorized;

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return NextResponse.json({ ok: false, error: "expected multipart/form-data" }, { status: 400 });
  }

  const fileEntry = form.get("file");
  if (!(fileEntry instanceof File) || fileEntry.size === 0) {
    return NextResponse.json({ ok: false, error: "file is required" }, { status: 400 });
  }
  const file = fileEntry;

  if (!ALLOWED_EXT.test(file.name)) {
    return NextResponse.json(
      { ok: false, error: "file must be .safetensors, .tar, or .bin" },
      { status: 400 }
    );
  }
  if (file.size > MAX_BYTES) {
    return NextResponse.json(
      { ok: false, error: `file too large (${Math.round(file.size / 1024 / 1024)} MB, max 500 MB)` },
      { status: 400 }
    );
  }

  // Parse metadata
  const notes = typeof form.get("notes") === "string" ? (form.get("notes") as string).trim() : undefined;
  const stackRaw = form.get("trainedForStack");
  const styleRaw = form.get("artStyle");
  const trainedForStack =
    stackRaw === "sdxl-stylized" || stackRaw === "flux-photoreal" ? stackRaw : "sdxl-stylized";
  const artStyle =
    styleRaw === "mspaint" || styleRaw === "photorealistic" ? styleRaw : "mspaint";

  // Upload to Vercel Blob
  let blobUrl: string;
  try {
    const filename = `loras/${Date.now()}-${file.name.replace(/[^a-zA-Z0-9._-]/g, "_")}`;
    const blob = await put(filename, file, {
      access: "public",
      contentType: file.type || (file.name.endsWith(".tar") ? "application/x-tar" : "application/octet-stream"),
    });
    blobUrl = blob.url;
  } catch (err) {
    return NextResponse.json(
      {
        ok: false,
        error: `Vercel Blob upload failed: ${err instanceof Error ? err.message : err}. Make sure BLOB_READ_WRITE_TOKEN is set in Vercel.`,
      },
      { status: 502 }
    );
  }

  // Add to registry
  try {
    const entry = await addToRegistry({
      url: blobUrl,
      trainedAt: new Date().toISOString(),
      notes: notes || `uploaded ${file.name}`,
      trainingSetFilename: file.name,
      trainingSteps: undefined,
      trainedForStack,
      artStyle,
    });
    return NextResponse.json({
      ok: true,
      entry,
      blobUrl,
      sizeMB: Math.round(file.size / 1024 / 1024),
    });
  } catch (err) {
    return NextResponse.json(
      {
        ok: false,
        error: `registry write failed: ${err instanceof Error ? err.message : err}`,
        // Blob upload succeeded — give them the URL so it's not lost
        blobUrlIfRegistryFailed: blobUrl,
      },
      { status: 500 }
    );
  }
}
