/**
 * Live colleagues in the online venue (plan §5.4, phase 5C), inside EA-SYS:
 *
 *   POST { peer, presence }   where this tab is now (the runtime sends at most
 *                             3 a second, only when something changed)
 *   POST { peer, leave: true } this tab left
 *   GET ?peer=<tab>           a server-sent event stream of everyone else in
 *                             this event's venue, pushed when something moves
 *                             (checked every 300 ms), a keep-alive every 15 s
 *
 * Identity is the session's; `peer` is a random id per browser tab, bound to
 * its user on first use (presence-store.ts). Positions live in memory only.
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { apiLogger } from "@/lib/logger";
import { checkRateLimit } from "@/lib/security";
import { rateLimited } from "@/lib/api-errors";
import { runWithTenant } from "@/lib/tenant-context";
import { venueGuard } from "@/lib/venue/route-guard";
import { venueDisplayName } from "@/lib/venue/display-name";
import { MAX_TABS_PER_PERSON, TAB_ID, leavePresence, peersFor, presenceVersion, putPresence } from "@/lib/venue/presence-store";

type Params = { params: Promise<{ eventId: string }> };
type Gate = Extract<Awaited<ReturnType<typeof venueGuard>>, { ok: true }>;

const POST_ROUTE = "venue/presence:POST";
const GET_ROUTE = "venue/presence:GET";
/** 3 a second from the runtime; the limit leaves room for a burst. */
const LIMIT = { limit: 300, windowMs: 60_000 };
const TICK_MS = 300;
const PING_MS = 15_000;
/** A stream ends after 30 minutes; the browser reconnects by itself. */
const MAX_STREAM_MS = 30 * 60_000;

const bodySchema = z.object({
  peer: z.string().regex(TAB_ID),
  presence: z.record(z.string(), z.unknown()).optional(),
  leave: z.literal(true).optional(),
});

const STATUS = { TAB_TAKEN: 409, TOO_MANY_TABS: 429, VENUE_FULL: 503 } as const;

/** Open streams per person, so one person cannot hold the server's connections. */
const openStreams: Map<string, number> = ((globalThis as { __venueStreams?: Map<string, number> }).__venueStreams ??= new Map());

export async function POST(req: Request, { params }: Params) {
  try {
    const { eventId } = await params;
    const gate = await venueGuard({ id: eventId }, POST_ROUTE);
    if (!gate.ok) return gate.response;
    const ctx = { userId: gate.userId, eventId };
    return await runWithTenant(gate.organizationId, async () => {
      const rl = checkRateLimit({ key: `venue-presence:${gate.userId}`, ...LIMIT });
      if (!rl.allowed) return rateLimited(rl, { route: POST_ROUTE, ...ctx, limit: LIMIT.limit, windowSeconds: 60 });
      const parsed = bodySchema.safeParse(await req.json().catch(() => null));
      if (!parsed.success) {
        apiLogger.warn({ msg: `${POST_ROUTE}:invalid-body`, ...ctx, errors: parsed.error.flatten() });
        return NextResponse.json({ error: "Invalid input", code: "INVALID_INPUT" }, { status: 400 });
      }
      const { peer, presence, leave } = parsed.data;
      if (leave) {
        leavePresence(eventId, peer, gate.userId);
        return NextResponse.json({ ok: true });
      }
      const res = putPresence(eventId, peer, gate.userId, venueDisplayName(gate.session), presence ?? {});
      if (!res.ok) {
        apiLogger.warn({ msg: `${POST_ROUTE}:refused`, ...ctx, code: res.code });
        return NextResponse.json({ error: "Not accepted", code: res.code }, { status: STATUS[res.code] });
      }
      return NextResponse.json({ ok: true });
    });
  } catch (err) {
    apiLogger.error({ err, msg: `${POST_ROUTE}:failed` });
    return NextResponse.json({ error: "Failed to update" }, { status: 500 });
  }
}

export async function GET(req: Request, { params }: Params) {
  try {
    const { eventId } = await params;
    const gate = await venueGuard({ id: eventId }, GET_ROUTE);
    if (!gate.ok) return gate.response;
    return await runWithTenant(gate.organizationId, async () => openStream(req, gate, eventId));
  } catch (err) {
    apiLogger.error({ err, msg: `${GET_ROUTE}:failed` });
    return NextResponse.json({ error: "Failed to open" }, { status: 500 });
  }
}

function openStream(req: Request, gate: Gate, eventId: string) {
  const userId = gate.userId;
  const tab = new URL(req.url).searchParams.get("peer") ?? "";
  if (!TAB_ID.test(tab)) {
    apiLogger.warn({ msg: `${GET_ROUTE}:invalid-peer`, userId, eventId });
    return NextResponse.json({ error: "Invalid input", code: "INVALID_INPUT" }, { status: 400 });
  }
  if ((openStreams.get(userId) ?? 0) >= MAX_TABS_PER_PERSON) {
    apiLogger.warn({ msg: `${GET_ROUTE}:too-many-streams`, userId, eventId });
    return NextResponse.json({ error: "Too many open venue tabs", code: "TOO_MANY_TABS" }, { status: 429 });
  }
  openStreams.set(userId, (openStreams.get(userId) ?? 0) + 1);
  const started = Date.now();
  const encoder = new TextEncoder();
  let stop = () => {};

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let lastVersion = -1;
      let closed = false;
      const send = (s: string) => {
        try {
          controller.enqueue(encoder.encode(s));
        } catch {
          stop(); // the reader is gone
        }
      };
      const tick = () => {
        const v = presenceVersion(eventId);
        if (v === lastVersion) return;
        lastVersion = v;
        send(`data: ${JSON.stringify({ peers: peersFor(eventId, tab, userId) })}\n\n`);
      };
      const timer = setInterval(tick, TICK_MS);
      const ping = setInterval(() => send(": ping\n\n"), PING_MS);
      const life = setTimeout(() => stop(), MAX_STREAM_MS);
      stop = () => {
        if (closed) return;
        closed = true;
        clearInterval(timer);
        clearInterval(ping);
        clearTimeout(life);
        const n = (openStreams.get(userId) ?? 1) - 1;
        if (n > 0) openStreams.set(userId, n);
        else openStreams.delete(userId);
        // The tab's stream ended: take its avatar out now rather than in 15 s.
        leavePresence(eventId, tab, userId);
        apiLogger.info({ msg: `${GET_ROUTE}:closed`, userId, eventId, seconds: Math.round((Date.now() - started) / 1000) });
        try {
          controller.close();
        } catch {
          // already closed by the reader
        }
      };
      req.signal.addEventListener("abort", () => stop());
      send("retry: 3000\n\n");
      tick();
    },
    cancel() {
      stop();
    },
  });
  apiLogger.info({ msg: `${GET_ROUTE}:opened`, userId, eventId });
  return new Response(stream, {
    headers: { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-store", "X-Accel-Buffering": "no", Connection: "keep-alive" },
  });
}
