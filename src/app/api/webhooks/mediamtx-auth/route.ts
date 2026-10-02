import { NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { checkRateLimit, getClientIp } from "@/lib/security";
import { isValidPublishPassword } from "@/lib/webinar/livestream";

/**
 * MediaMTX publish authorisation (Oct 1, 2026).
 *
 * MediaMTX accepted a publish on ANY path from anyone who could reach port
 * 1935, so a stranger could push their own video into `live/<anything>`.
 * With `authMethod: http` MediaMTX asks this route before every action; a 2xx
 * allows it, anything else refuses. A publish is allowed only on
 * `live/<streamKey>` where the key belongs to a Zoom meeting with live
 * streaming switched on. Reading stays open as before (playback is gated by
 * the key's secrecy and by the stream-status route that hands it out).
 *
 * Lives under /api/webhooks/ because MediaMTX calls it server to server with
 * no Origin header, which the middleware's CSRF check refuses everywhere
 * else.
 *
 * Inert until MediaMTX is restarted with the auth settings: see
 * docs/LIVE_STREAMING.md, "Publish authorisation".
 *
 * Fails CLOSED for publish: no match, a malformed body or a database error
 * all refuse. On the platform instance, RLS hides other tenants' rows from
 * this tenant-less lookup, so a publish there is refused until the lookup
 * moves to the operator lane; master is single-tenant and unaffected.
 */
const bodySchema = z.object({
  action: z.string(),
  path: z.string().default(""),
  protocol: z.string().optional(),
  ip: z.string().optional(),
  user: z.string().optional(),
  password: z.string().optional(),
  query: z.string().optional(),
});

/** MediaMTX passes `?user=&pass=` as user/password; fall back to the raw query. */
function presentedPassword(body: { password?: string; query?: string }): string | null {
  if (body.password) return body.password;
  if (!body.query) return null;
  return new URLSearchParams(body.query).get("pass");
}

const READ_ACTIONS = new Set(["read", "playback"]);
const STREAM_KEY = /^live\/([a-f0-9]{32})$/;

export async function POST(req: Request) {
  const ip = getClientIp(req);
  const { allowed } = checkRateLimit({ key: `mediamtx-auth:${ip}`, limit: 600, windowMs: 60_000 });
  if (!allowed) {
    apiLogger.warn({ ip }, "mediamtx-auth:rate-limited");
    return NextResponse.json({ error: "Too many requests" }, { status: 429 });
  }

  let parsed: z.infer<typeof bodySchema>;
  try {
    const result = bodySchema.safeParse(await req.json());
    if (!result.success) {
      apiLogger.warn({ ip, errors: result.error.flatten() }, "mediamtx-auth:invalid-body");
      return NextResponse.json({ error: "Invalid body" }, { status: 400 });
    }
    parsed = result.data;
  } catch (err) {
    apiLogger.warn({ ip, err }, "mediamtx-auth:unreadable-body");
    return NextResponse.json({ error: "Invalid body" }, { status: 400 });
  }

  if (READ_ACTIONS.has(parsed.action)) {
    return NextResponse.json({ ok: true });
  }

  if (parsed.action !== "publish") {
    apiLogger.warn({ ip, action: parsed.action, path: parsed.path }, "mediamtx-auth:action-refused");
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const match = STREAM_KEY.exec(parsed.path);
  if (!match) {
    apiLogger.warn({ ip, path: parsed.path, publisherIp: parsed.ip }, "mediamtx-auth:publish-bad-path");
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  try {
    const meeting = await db.zoomMeeting.findFirst({
      where: { streamKey: match[1], liveStreamEnabled: true },
      select: { id: true, eventId: true },
    });
    if (!meeting) {
      apiLogger.warn({ ip, publisherIp: parsed.ip }, "mediamtx-auth:publish-unknown-key");
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
    if (!isValidPublishPassword(match[1], presentedPassword(parsed))) {
      apiLogger.warn(
        { ip, publisherIp: parsed.ip, eventId: meeting.eventId },
        "mediamtx-auth:publish-bad-credentials",
      );
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
    apiLogger.info({ eventId: meeting.eventId, publisherIp: parsed.ip }, "mediamtx-auth:publish-allowed");
    return NextResponse.json({ ok: true });
  } catch (err) {
    apiLogger.error({ err, ip }, "mediamtx-auth:lookup-failed");
    return NextResponse.json({ error: "Unavailable" }, { status: 503 });
  }
}
