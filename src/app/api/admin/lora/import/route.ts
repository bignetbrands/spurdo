import { NextResponse } from "next/server";
import { checkAdminAuth } from "@/lib/auth";
import { addToRegistry } from "@/lib/lora";

export const dynamic = "force-dynamic";

interface ImportRequest {
  url: string;
  notes?: string;
  trainedForStack: "flux-photoreal" | "sdxl-stylized";
  artStyle?: "photorealistic" | "mspaint";
}

/**
 * POST /api/admin/lora/import
 *
 * Import an externally-trained LoRA by URL into the registry.
 * Use case: Spurdo identity LoRA trained on Replicate (since Fal
 * doesn't host SDXL training). Operator pastes the .safetensors URL
 * here and it lands in the registry the same as a Fal-trained one.
 */
export async function POST(request: Request) {
  const unauthorized = checkAdminAuth(request);
  if (unauthorized) return unauthorized;

  let body: ImportRequest;
  try {
    body = (await request.json()) as ImportRequest;
  } catch {
    return NextResponse.json({ ok: false, error: "invalid JSON body" }, { status: 400 });
  }

  if (!body.url || typeof body.url !== "string" || !body.url.trim()) {
    return NextResponse.json({ ok: false, error: "url is required" }, { status: 400 });
  }
  const url = body.url.trim();
  if (!/^https:\/\/[^\s]+/.test(url)) {
    return NextResponse.json({ ok: false, error: "url must be https://" }, { status: 400 });
  }
  if (body.trainedForStack !== "flux-photoreal" && body.trainedForStack !== "sdxl-stylized") {
    return NextResponse.json(
      { ok: false, error: "trainedForStack must be 'flux-photoreal' or 'sdxl-stylized'" },
      { status: 400 }
    );
  }

  // Soft warning if URL doesn't look like a LoRA file
  const looksLikeLora =
    /\.safetensors($|\?)/i.test(url) ||
    /\.bin($|\?)/i.test(url) ||
    /civitai\.com|huggingface\.co|fal\.media|replicate\.delivery/i.test(url);

  try {
    const entry = await addToRegistry({
      url,
      trainedAt: new Date().toISOString(),
      notes: body.notes?.trim() || `imported (${body.trainedForStack})`,
      trainingSetFilename: "external import",
      trainingSteps: undefined,
      trainedForStack: body.trainedForStack,
      artStyle: body.artStyle,
    });
    return NextResponse.json({
      ok: true,
      entry,
      warning: looksLikeLora
        ? undefined
        : "URL doesn't look like a LoRA file (.safetensors / .bin). If inference fails later, double-check it's a direct download URL.",
    });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: `registry write failed: ${err instanceof Error ? err.message : err}` },
      { status: 500 }
    );
  }
}
