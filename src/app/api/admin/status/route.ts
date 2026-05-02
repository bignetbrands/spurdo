import { NextResponse } from "next/server";
import { checkAdminAuth } from "@/lib/auth";
import { loadConfig } from "@/lib/config";
import { isKillSwitchActive, kvHealthCheck } from "@/lib/store";
import { getActiveLoraUrl } from "@/lib/lora";
import { getBudgetStatus } from "@/lib/budget";

export const dynamic = "force-dynamic";

/**
 * GET /api/admin/status
 *
 * Returns: project config summary, kill switch state, KV health, env-var presence.
 * Used by /bot dashboard for the STATUS panel.
 */
export async function GET(request: Request) {
  const unauthorized = checkAdminAuth(request);
  if (unauthorized) return unauthorized;

  try {
    const cfg = loadConfig();
    const [killSwitch, kvHealth, activeLora, budget] = await Promise.all([
      isKillSwitchActive(),
      kvHealthCheck(),
      getActiveLoraUrl().catch(() => null),
      getBudgetStatus().catch(() => null),
    ]);

    // Surface which secrets are present (booleans only — never the values)
    const envCheck = {
      ADMIN_SECRET: !!process.env.ADMIN_SECRET,
      CRON_SECRET: !!process.env.CRON_SECRET,
      ANTHROPIC_API_KEY: !!process.env.ANTHROPIC_API_KEY,
      OPENAI_API_KEY: !!process.env.OPENAI_API_KEY,
      FAL_KEY: !!process.env.FAL_KEY,
      KV_REST_API_URL: !!(process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL),
      KV_REST_API_TOKEN: !!(process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN),
      TWITTER_API_KEY: !!process.env.TWITTER_API_KEY,
      TWITTER_API_SECRET: !!process.env.TWITTER_API_SECRET,
      TWITTER_ACCESS_TOKEN: !!process.env.TWITTER_ACCESS_TOKEN,
      TWITTER_ACCESS_TOKEN_SECRET: !!process.env.TWITTER_ACCESS_TOKEN_SECRET,
      TWITTER_BEARER_TOKEN: !!process.env.TWITTER_BEARER_TOKEN,
    };

    return NextResponse.json({
      timestamp: new Date().toISOString(),
      killSwitch,
      kvHealth,
      activeLora: activeLora ? { url: activeLora } : null,
      budget,
      config: {
        project: cfg.projectId,
        xHandle: cfg.accounts.xHandle,
        pillarsCount: Object.keys(cfg.pillars.pillars).length,
        contractAddress: cfg.token.contractAddress,
      },
      envCheck,
    });
  } catch (err) {
    console.error("[status] error:", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "unknown error" },
      { status: 500 }
    );
  }
}
