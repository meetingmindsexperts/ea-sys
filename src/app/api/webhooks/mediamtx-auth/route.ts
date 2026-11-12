import { NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { checkRateLimit, getClientIp } from "@/lib/security";
import { externalPublishDecision } from "@/lib/webinar/external-stream";
import { isValidPublishPassword } from "@/lib/webinar/livestream";
import { isValidControlCaller } from "@/lib/webinar/mediamtx-control";
import { streamKeyOwner, type StreamKeyOwner } from "@/lib/webinar/session-stream";

/**
 * MediaMTX publish authorisation (Oct 1, 2026).
 *
 * MediaMTX accepted a publish on ANY path from anyone who could reach port
 * 1935, so a stranger could push their own video into `live/<anything>`.
 * With `authMethod: http` MediaMTX asks this route before every action; a 2xx
 * allows it, anything else refuses. A publish is allowed only on
 * `live/<streamKey>` where the key belongs to a stream we know
 * (session-stream.ts): a Zoom meeting with live streaming switched on, or a
 * partner's external stream, which must also be switched on and inside its
 * period (external-stream.ts). Reading stays open as before (playback is gated by
 * the key's secrecy and by the stream-status route that hands it out).
 *
 * Lives under /api/webhooks/ because MediaMTX calls it server to server with
 * no Origin header, which the middleware's CSRF check refuses everywhere
 * else.
 *
 * Inert until MediaMTX is restarted with the auth settings: see
 * docs/LIVE_STREAMING.md, "Publish authorisation".
 *
 * The same question is asked for MediaMTX's control API (action "api", Nov 12,
 * 2026): allowed only with MEDIAMTX_API_SECRET, refused otherwise.
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

/**
 * A partner's key was let in: note when and from where, for the console's
 * "last received" line. Never blocks the publish: a failed note is logged and
 * the stream goes ahead.
 */
async function notePartnerPublish(owner: Extract<StreamKeyOwner, { source: "external" }>, publisherIp: string | undefined) {
  try {
    await db.externalStream.updateMany({
      where: { id: owner.id, eventId: owner.eventId },
      data: { lastPublishAt: new Date(), lastPublisherIp: publisherIp?.slice(0, 64) ?? null },
    });
  } catch (err) {
    apiLogger.error({ err, eventId: owner.eventId }, "mediamtx-auth:external-publish-note-failed");
  }
}
const STREAM_KEY = /^live\/([a-f0-9]{32})$/;

type Question = z.infer<typeof bodySchema>;
type Read = { ok: true; question: Question } | { ok: false; reason: "invalid-body" | "unreadable-body"; detail: unknown };

export async function POST(req: Request) {
  const ip = getClientIp(req);
  // Read and checked first, reported later: what it says decides whether the rate limit applies at all.
  let read: Read;
  try {
    const raw = await req.json();
    const result = bodySchema.safeParse(raw);
    read = result.success
      ? { ok: true, question: result.data }
      : { ok: false, reason: "invalid-body", detail: result.error.flatten() };
  } catch (err) {
    read = { ok: false, reason: "unreadable-body", detail: err };
  }

  // OUR OWN control call is answered before the rate limit (review of a6ec7911,
  // HIGH). Every question arrives from MediaMTX's one address, so the limit
  // below is one bucket for everyone: ten bogus publish attempts a second on
  // port 1935 use it up, and "cut the feed" on that very stream would then be
  // answered 429 and the stream would stay up. A caller holding
  // MEDIAMTX_API_SECRET is us, and is never limited.
  if (read.ok && read.question.action === "api" && isValidControlCaller(read.question.user, read.question.password)) {
    return NextResponse.json({ ok: true });
  }

  const { allowed } = checkRateLimit({ key: `mediamtx-auth:${ip}`, limit: 600, windowMs: 60_000 });
  if (!allowed) {
    apiLogger.warn({ ip }, "mediamtx-auth:rate-limited");
    return NextResponse.json({ error: "Too many requests" }, { status: 429 });
  }

  if (!read.ok) {
    apiLogger.warn({ ip, detail: read.detail }, `mediamtx-auth:${read.reason}`);
    return NextResponse.json({ error: "Invalid body" }, { status: 400 });
  }
  const parsed = read.question;

  if (READ_ACTIONS.has(parsed.action)) {
    return NextResponse.json({ ok: true });
  }

  // MediaMTX's control API (who is publishing, disconnect a publisher) has no
  // password of its own: it asks here, like a publish. Only our own callers,
  // which send MEDIAMTX_API_SECRET, were let in above (mediamtx-control.ts).
  // This route is a public address, so a wrong or missing secret is the common case.
  if (parsed.action === "api") {
    apiLogger.warn({ ip, callerIp: parsed.ip }, "mediamtx-auth:api-refused");
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  if (parsed.action !== "publish") {
    apiLogger.warn({ ip, action: parsed.action.slice(0, 40), pathLength: parsed.path.length }, "mediamtx-auth:action-refused");
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const match = STREAM_KEY.exec(parsed.path);
  if (!match) {
    // Never the path itself: an encoder that mangles `key?user=..&pass=..` could
    // put the password in it, and it would then sit in the log still valid.
    apiLogger.warn(
      { ip, pathLength: parsed.path.length, underLive: parsed.path.startsWith("live/"), publisherIp: parsed.ip },
      "mediamtx-auth:publish-bad-path",
    );
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  try {
    const meeting = await streamKeyOwner(match[1]);
    if (!meeting) {
      apiLogger.warn({ ip, publisherIp: parsed.ip }, "mediamtx-auth:publish-unknown-key");
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
    // A partner's key has its own rule: the password of its current version,
    // switched on, inside its period. The reason goes to the log only, so "it
    // does not work" can be answered from there; MediaMTX hears 403 for all.
    if (meeting.source === "external") {
      const decision = externalPublishDecision({ ...meeting, streamKey: match[1] }, presentedPassword(parsed), new Date());
      if (!decision.allowed) {
        apiLogger.warn(
          { ip, publisherIp: parsed.ip, eventId: meeting.eventId, reason: decision.reason },
          "mediamtx-auth:publish-external-refused",
        );
        return NextResponse.json({ error: "Forbidden" }, { status: 403 });
      }
      await notePartnerPublish(meeting, parsed.ip);
      apiLogger.info({ eventId: meeting.eventId, publisherIp: parsed.ip }, "mediamtx-auth:publish-external-allowed");
      return NextResponse.json({ ok: true });
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
