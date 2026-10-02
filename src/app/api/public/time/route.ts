import { NextResponse } from "next/server";
import { apiLogger } from "@/lib/logger";
import { checkRateLimit, getClientIp } from "@/lib/security";

/**
 * The server's clock, for the stream delay measurement (Oct 2, 2026): the
 * console preview and the /stream-clock page correct their own clocks to this
 * one, so a laptop clock that is a few seconds off does not skew the delay.
 * No data, no auth; rate-limited like every public route.
 */
export async function GET(req: Request) {
  const ip = getClientIp(req);
  const { allowed, retryAfterSeconds } = checkRateLimit({
    key: `public-time:${ip}`,
    limit: 600,
    windowMs: 3600_000,
  });
  if (!allowed) {
    apiLogger.warn({ ip, retryAfterSeconds }, "public/time:rate-limited");
    return NextResponse.json(
      { error: "Too many requests" },
      { status: 429, headers: { "Retry-After": String(retryAfterSeconds) } },
    );
  }
  return NextResponse.json({ now: Date.now() }, { headers: { "Cache-Control": "no-store" } });
}
