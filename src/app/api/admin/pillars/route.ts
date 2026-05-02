import { NextResponse } from "next/server";
import { checkAdminAuth } from "@/lib/auth";
import { loadConfig } from "@/lib/config";

export const dynamic = "force-dynamic";

/**
 * GET /api/admin/pillars
 *
 * Returns the list of content pillars from the project config.
 * Used by the dashboard composer to populate the pillar dropdown.
 */
export async function GET(request: Request) {
  const unauthorized = checkAdminAuth(request);
  if (unauthorized) return unauthorized;

  const cfg = loadConfig();
  const pillars = Object.entries(cfg.pillars.pillars).map(([id, p]) => ({
    id,
    name: p.name,
    description: p.description,
    generateImage: p.generateImage,
    model: p.model,
    dailyTarget: p.dailyTarget,
  }));

  return NextResponse.json({ pillars });
}
