import { NextResponse } from "next/server";
import { put, del } from "@vercel/blob";
import { extract as tarExtract } from "tar-stream";
import { Readable } from "stream";
import { checkAdminAuth } from "@/lib/auth";
import { addToRegistry } from "@/lib/lora";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * Extract the inner .safetensors from a Replicate-trained .tar.
 */
async function extractSafetensorsFromTar(
  tarBytes: Buffer
): Promise<{ bytes: Buffer; innerFilename: string }> {
  return new Promise((resolve, reject) => {
    const extract = tarExtract();
    let foundFile: { bytes: Buffer; innerFilename: string } | null = null;
    let firstError: Error | null = null;

    extract.on("entry", (header, stream, next) => {
      if (header.type === "file" && /\.safetensors$/i.test(header.name)) {
        const chunks: Buffer[] = [];
        stream.on("data", (chunk: Buffer) => chunks.push(chunk));
        stream.on("end", () => {
          if (!foundFile) {
            foundFile = { bytes: Buffer.concat(chunks), innerFilename: header.name };
          }
          next();
        });
        stream.on("error", (err: Error) => {
          firstError = err;
          next();
        });
      } else {
        stream.on("end", next);
        stream.resume();
      }
    });

    extract.on("finish", () => {
      if (firstError) return reject(firstError);
      if (!foundFile) return reject(new Error("no .safetensors file found inside .tar"));
      resolve(foundFile);
    });
    extract.on("error", reject);

    Readable.from(tarBytes).pipe(extract);
  });
}

interface RegisterRequest {
  blobUrl: string;
  originalFilename: string;
  notes?: string;
  trainedForStack?: "sdxl-stylized" | "flux-photoreal";
  artStyle?: "mspaint" | "photorealistic";
}

/**
 * POST /api/admin/lora/register-uploaded
 *
 * Called by the client after a direct Blob upload finishes. The browser
 * already uploaded the file directly to Blob (bypassing our 4.5MB limit),
 * and now passes the URL here.
 *
 * For .tar files, this route downloads the blob, extracts the inner
 * .safetensors, re-uploads as a clean .safetensors blob, deletes the
 * original .tar blob, then registers the new URL.
 *
 * For .safetensors uploaded directly, just registers the URL as-is.
 */
export async function POST(request: Request) {
  const unauthorized = checkAdminAuth(request);
  if (unauthorized) return unauthorized;

  let body: RegisterRequest;
  try {
    body = (await request.json()) as RegisterRequest;
  } catch {
    return NextResponse.json({ ok: false, error: "invalid JSON body" }, { status: 400 });
  }

  if (!body.blobUrl || !body.originalFilename) {
    return NextResponse.json(
      { ok: false, error: "blobUrl and originalFilename required" },
      { status: 400 }
    );
  }

  const trainedForStack =
    body.trainedForStack === "flux-photoreal" ? "flux-photoreal" : "sdxl-stylized";
  const artStyle = body.artStyle === "photorealistic" ? "photorealistic" : "mspaint";
  const isTar = /\.tar$/i.test(body.originalFilename);

  let finalUrl = body.blobUrl;
  let extractionNote = "";

  if (isTar) {
    // Download, extract, re-upload, delete original
    let tarBytes: Buffer;
    try {
      const res = await fetch(body.blobUrl);
      if (!res.ok) throw new Error(`fetch failed: HTTP ${res.status}`);
      tarBytes = Buffer.from(await res.arrayBuffer());
    } catch (err) {
      return NextResponse.json(
        {
          ok: false,
          error: `Failed to fetch uploaded .tar: ${err instanceof Error ? err.message : err}`,
        },
        { status: 500 }
      );
    }

    let extracted: { bytes: Buffer; innerFilename: string };
    try {
      extracted = await extractSafetensorsFromTar(tarBytes);
    } catch (err) {
      return NextResponse.json(
        {
          ok: false,
          error: `Failed to extract: ${err instanceof Error ? err.message : err}`,
        },
        { status: 400 }
      );
    }

    // Re-upload the safetensors only
    try {
      const baseName = body.originalFilename.replace(/\.tar$/i, "");
      const safeName = baseName.replace(/[^a-zA-Z0-9._-]/g, "_");
      const path = `loras/${Date.now()}-${safeName}.safetensors`;
      const reUpload = await put(path, extracted.bytes, {
        access: "public",
        contentType: "application/octet-stream",
      });
      finalUrl = reUpload.url;
      extractionNote = ` (extracted ${extracted.innerFilename} from ${body.originalFilename})`;
    } catch (err) {
      return NextResponse.json(
        {
          ok: false,
          error: `Re-upload failed: ${err instanceof Error ? err.message : err}`,
        },
        { status: 502 }
      );
    }

    // Best-effort: delete the original .tar to save storage cost
    try {
      await del(body.blobUrl);
    } catch {
      // non-fatal
    }
  }

  // Register
  try {
    const entry = await addToRegistry({
      url: finalUrl,
      trainedAt: new Date().toISOString(),
      notes: (body.notes?.trim() || `uploaded ${body.originalFilename}`) + extractionNote,
      trainingSetFilename: body.originalFilename,
      trainingSteps: undefined,
      trainedForStack,
      artStyle,
    });
    return NextResponse.json({ ok: true, entry, finalUrl, extracted: !!extractionNote });
  } catch (err) {
    return NextResponse.json(
      {
        ok: false,
        error: `registry write failed: ${err instanceof Error ? err.message : err}`,
        finalUrlIfRegistryFailed: finalUrl,
      },
      { status: 500 }
    );
  }
}
