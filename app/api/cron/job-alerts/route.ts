import { NextRequest, NextResponse } from "next/server";
import { runJobAlertDigest } from "@/lib/notify";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * Triggered once a day by the Vercel Cron in vercel.json. Vercel adds
 * `Authorization: Bearer $CRON_SECRET` automatically when that env var is
 * set — checked here so this isn't just a public endpoint that spams every
 * active alert on request.
 */
export async function GET(request: NextRequest) {
  const secret = process.env.CRON_SECRET;
  const auth = request.headers.get("authorization");
  if (!secret || auth !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  await runJobAlertDigest();
  return NextResponse.json({ ok: true });
}
