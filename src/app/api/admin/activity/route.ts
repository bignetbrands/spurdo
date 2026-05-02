import { NextResponse } from "next/server";
import { checkAdminAuth } from "@/lib/auth";
import { getDailyTweets, getHeartbeat } from "@/lib/store";

export const dynamic = "force-dynamic";

/**
 * GET /api/admin/activity
 *
 * Returns today's posted tweets + last cron heartbeats.
 * Used by the ACTIVITY card in /bot.
 */
export async function GET(request: Request) {
  const unauthorized = checkAdminAuth(request);
  if (unauthorized) return unauthorized;

  const [tweetsToday, tweetCron, repliesCron] = await Promise.all([
    getDailyTweets(),
    getHeartbeat("cron:tweet"),
    getHeartbeat("cron:replies"),
  ]);

  // Sort newest first
  tweetsToday.sort((a, b) => (a.postedAt < b.postedAt ? 1 : -1));

  return NextResponse.json({
    today: {
      date: new Date().toISOString().slice(0, 10),
      count: tweetsToday.length,
      tweets: tweetsToday,
    },
    crons: {
      tweet: tweetCron ? { lastSeen: new Date(tweetCron.ts).toISOString(), agoMinutes: Math.round((Date.now() - tweetCron.ts) / 60_000) } : null,
      replies: repliesCron ? { lastSeen: new Date(repliesCron.ts).toISOString(), agoMinutes: Math.round((Date.now() - repliesCron.ts) / 60_000) } : null,
    },
  });
}
