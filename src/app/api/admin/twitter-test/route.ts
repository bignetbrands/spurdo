import { NextResponse } from "next/server";
import { TwitterApi } from "twitter-api-v2";
import { checkAdminAuth } from "@/lib/auth";

export const dynamic = "force-dynamic";

/**
 * GET /api/admin/twitter-test
 *
 * Diagnostic endpoint: tests Twitter credentials without posting.
 * Hits v2 /users/me which requires user-context auth (the same
 * scope posting needs). Returns specific failure reasons so we
 * can isolate whitespace / wrong-token / scope issues.
 */
export async function GET(request: Request) {
  const unauthorized = checkAdminAuth(request);
  if (unauthorized) return unauthorized;

  // ── Sanity checks: env presence + length + whitespace ──
  const envChecks = {
    TWITTER_API_KEY: checkVar(process.env.TWITTER_API_KEY),
    TWITTER_API_SECRET: checkVar(process.env.TWITTER_API_SECRET),
    TWITTER_ACCESS_TOKEN: checkVar(process.env.TWITTER_ACCESS_TOKEN),
    TWITTER_ACCESS_TOKEN_SECRET: checkVar(process.env.TWITTER_ACCESS_TOKEN_SECRET),
    TWITTER_BEARER_TOKEN: checkVar(process.env.TWITTER_BEARER_TOKEN),
  };

  const anyMissing = Object.values(envChecks).some((c) => !c.present);
  const anyDirty = Object.values(envChecks).some((c) => c.present && (c.hasLeadingSpace || c.hasTrailingSpace || c.hasNewline));

  // ── Try authenticating as the user ──
  let userTest: Record<string, unknown> = { skipped: true };
  if (!anyMissing) {
    try {
      const client = new TwitterApi({
        appKey: process.env.TWITTER_API_KEY!.trim(),
        appSecret: process.env.TWITTER_API_SECRET!.trim(),
        accessToken: process.env.TWITTER_ACCESS_TOKEN!.trim(),
        accessSecret: process.env.TWITTER_ACCESS_TOKEN_SECRET!.trim(),
      });
      const me = await client.v2.me();
      userTest = {
        ok: true,
        userId: me.data.id,
        username: me.data.username,
        name: me.data.name,
        note: ".trim() applied — if this works but the live route doesn't, it's a whitespace problem in the env var",
      };
    } catch (err) {
      const e = err as { code?: number; data?: { detail?: string; title?: string }; message?: string };
      userTest = {
        ok: false,
        code: e.code,
        title: e.data?.title,
        detail: e.data?.detail,
        message: e.message,
        diagnosis: diagnoseTwitterError(e),
      };
    }
  }

  return NextResponse.json({
    timestamp: new Date().toISOString(),
    envChecks,
    summary: {
      anyMissing,
      anyDirty,
      whitespaceWarning: anyDirty
        ? "One or more env vars have leading/trailing whitespace or newline characters. This breaks OAuth signing. Re-paste the affected vars carefully (no trailing space, no Enter at the end)."
        : null,
    },
    userTest,
  });
}

function checkVar(v: string | undefined): {
  present: boolean;
  length?: number;
  hasLeadingSpace?: boolean;
  hasTrailingSpace?: boolean;
  hasNewline?: boolean;
  preview?: string;
} {
  if (!v) return { present: false };
  return {
    present: true,
    length: v.length,
    hasLeadingSpace: v !== v.trimStart(),
    hasTrailingSpace: v !== v.trimEnd(),
    hasNewline: /[\r\n]/.test(v),
    // Preview: first 4 + last 4 chars only (don't leak full secret)
    preview: v.length > 12 ? `${v.slice(0, 4)}…${v.slice(-4)}` : "<short>",
  };
}

function diagnoseTwitterError(e: { code?: number; data?: { detail?: string; title?: string }; message?: string }): string {
  const code = e.code;
  const detail = e.data?.detail || e.message || "";
  if (code === 401) {
    if (/expired/i.test(detail)) return "Token expired or invalidated — regenerate Access Token + Secret in X dev portal";
    if (/invalid/i.test(detail)) return "Token doesn't match. Check: (1) you pasted the right value into the right env var, (2) no whitespace, (3) you regenerated AFTER setting permissions to Read+Write";
    return "Auth failed — most commonly hidden whitespace, wrong-var paste, or a permission mismatch";
  }
  if (code === 403) return "Auth worked but action not permitted — app permissions are still read-only OR the API tier doesn't allow this action";
  if (code === 429) return "Rate limited — wait or upgrade tier";
  if (code === 400) return "Bad request — usually a typo in env var or malformed token";
  return "Unknown error — check the raw fields above";
}
