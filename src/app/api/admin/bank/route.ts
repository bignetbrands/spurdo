import { NextResponse } from "next/server";
import { checkAdminAuth } from "@/lib/auth";
import { getManifest, refreshBank, pickMemeForPillar } from "@/lib/meme-bank";

export const dynamic = "force-dynamic";

/**
 * GET /api/admin/bank
 *   ?refresh=1   force-refresh manifest from GitHub
 *   ?pillar=ID   also return what pickMemeForPillar(ID) would return
 *
 * Returns: { manifest, picked? }
 */
export async function GET(request: Request) {
  const unauthorized = checkAdminAuth(request);
  if (unauthorized) return unauthorized;

  const url = new URL(request.url);
  const force = url.searchParams.get("refresh") === "1";
  const pillar = url.searchParams.get("pillar");

  try {
    const manifest = force ? await refreshBank() : await getManifest();
    const picked = pillar ? await pickMemeForPillar(pillar) : null;
    return NextResponse.json({ ok: true, manifest, picked });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : String(err) },
      { status: 502 }
    );
  }
}
