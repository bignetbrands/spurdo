import { NextResponse } from "next/server";
import { put } from "@vercel/blob";
import { extract as tarExtract } from "tar-stream";
import { Readable } from "stream";
import { checkAdminAuth } from "@/lib/auth";
import { addToRegistry } from "@/lib/lora";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const MAX_BYTES = 500 * 1024 * 1024; // 500 MB cap
const ALLOWED_EXT = /\.(safetensors|tar|bin)$/i;

/**
 * Extract the .safetensors file from a Replicate-trained .tar archive.
 * Replicate packages trained LoRA weights as a tar containing
 * lora.safetensors (plus other metadata files we don't need). Fal's
 * inference endpoint expects a direct .safetensors URL, so we have to
 * extract it before re-uploading.
 *
 * Returns the safetensors file bytes + the original filename inside the tar.
 */
async function extractSafetensorsFromTar(
  tarBytes: Buffer
): Promise<{ bytes: Buffer; innerFilename: string }> {
  return new Promise((resolve, reject) => {
    const extract = tarExtract();
    let foundFile: { bytes: Buffer; innerFilename: string } | null = null;
    let firstError: Error | null = null;

    extract.on("entry", (header, stream, next) => {
      // We only care about .safetensors files inside the tar
      if (header.type === "file" && /\.safetensors$/i.test(header.name)) {
        const chunks: Buffer[] = [];
        stream.on("data", (chunk: Buffer) => chunks.push(chunk));
        stream.on("end", () => {
          if (!foundFile) {
            foundFile = {
              bytes: Buffer.concat(chunks),
              innerFilename: header.name,
            };
          }
          next();
        });
        stream.on("error", (err: Error) => {
          firstError = err;
          next();
        });
      } else {
        // Skip other files (tokenizer configs, README, etc)
        stream.on("end", next);
        stream.resume();
      }
    });

    extract.on("finish", () => {
      if (firstError) return reject(firstError);
      if (!foundFile) return reject(new Error("no .safetensors file found inside the .tar archive"));
      resolve(foundFile);
    });
    extract.on("error", reject);

    Readable.from(tarBytes).pipe(extract);
  });
}

/**
 * POST /api/admin/lora/upload-trained
 *
 * Accepts a pre-trained LoRA file from the operator's computer.
 * Two formats supported:
 *   - .safetensors → uploaded as-is to Vercel Blob
 *   - .tar         → extracted, the inner .safetensors uploaded
 *                    (Replicate ships .tar; Fal needs raw .safetensors)
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

  // ── If .tar, extract the inner .safetensors ──
  let uploadBytes: Buffer;
  let uploadFilename: string;
  let extractionNote = "";

  const fileBuffer = Buffer.from(await file.arrayBuffer());

  if (/\.tar$/i.test(file.name)) {
    try {
      const extracted = await extractSafetensorsFromTar(fileBuffer);
      uploadBytes = extracted.bytes;
      // Use a clean filename based on the original tar name
      const baseName = file.name.replace(/\.tar$/i, "");
      uploadFilename = `${baseName}.safetensors`;
      extractionNote = ` (extracted ${extracted.innerFilename} from ${file.name})`;
    } catch (err) {
      return NextResponse.json(
        {
          ok: false,
          error: `Failed to extract safetensors from .tar: ${err instanceof Error ? err.message : err}`,
        },
        { status: 400 }
      );
    }
  } else {
    // .safetensors / .bin → upload as-is
    uploadBytes = fileBuffer;
    uploadFilename = file.name;
  }

  // Upload to Vercel Blob
  let blobUrl: string;
  try {
    const safeName = uploadFilename.replace(/[^a-zA-Z0-9._-]/g, "_");
    const path = `loras/${Date.now()}-${safeName}`;
    const blob = await put(path, uploadBytes, {
      access: "public",
      contentType: "application/octet-stream",
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
      notes: (notes || `uploaded ${file.name}`) + extractionNote,
      trainingSetFilename: file.name,
      trainingSteps: undefined,
      trainedForStack,
      artStyle,
    });
    return NextResponse.json({
      ok: true,
      entry,
      blobUrl,
      sizeMB: Math.round(uploadBytes.length / 1024 / 1024),
      extracted: !!extractionNote,
    });
  } catch (err) {
    return NextResponse.json(
      {
        ok: false,
        error: `registry write failed: ${err instanceof Error ? err.message : err}`,
        blobUrlIfRegistryFailed: blobUrl,
      },
      { status: 500 }
    );
  }
}
