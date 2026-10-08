/**
 * POST /api/venue/:eventId/ai: one AI attendee reply, streamed as plain text
 * (plan §5.3, phase 5B). The page sends the persona's fields, the room and the
 * conversation; the server checks every persona field against the venue's own
 * lists and writes the instructions itself (src/lib/venue/ai-prompt.ts).
 *
 * Refusals the page turns into its pre-written answers:
 *   403 AI_OFF            the event team switched AI attendees off
 *   429 RATE_LIMITED      40 replies an hour for this person
 *   429 AI_LIMIT_EVENT    2,000 replies today for this event
 *   502 AI_UNAVAILABLE    Anthropic did not answer (the claim is given back)
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { apiLogger } from "@/lib/logger";
import { runWithTenant } from "@/lib/tenant-context";
import { checkRateLimit } from "@/lib/security";
import { rateLimited } from "@/lib/api-errors";
import { resolveTimezone } from "@/lib/event-time";
import { venueGuard } from "@/lib/venue/route-guard";
import { venueDateRange } from "@/lib/venue/date-range";
import { eventLayout } from "@/lib/venue/event-venue";
import { MAX_TURNS, checkGreeting, checkPersona, cleanTurns } from "@/lib/venue/ai-prompt";
import { VENUE_AI_PER_EVENT_DAY, VENUE_AI_PER_PERSON_HOUR, claimReply, readVenueAi, streamVenueReply, venueDay } from "@/services/venue-ai-service";

type Params = { params: Promise<{ eventId: string }> };

const ROUTE = "venue/ai:POST";
const LIMIT = { limit: VENUE_AI_PER_PERSON_HOUR, windowMs: 60 * 60_000 };

const bodySchema = z.object({
  persona: z.record(z.string(), z.unknown()),
  zone: z.string().max(40).optional(),
  pose: z.string().max(20).optional(),
  role: z.string().max(20).optional(),
  greeting: z.string().max(400).optional(),
  turns: z.array(z.object({ role: z.string().max(20), content: z.string().max(4000) })).min(1).max(MAX_TURNS * 2),
});

export async function POST(req: Request, { params }: Params) {
  try {
    const { eventId } = await params;
    const gate = await venueGuard({ id: eventId }, ROUTE);
    if (!gate.ok) return gate.response;
    const ctx = { userId: gate.userId, eventId };
    return await runWithTenant(gate.organizationId, async () => {
      if (!readVenueAi(gate.event.settings).on) {
        apiLogger.warn({ msg: `${ROUTE}:ai-off`, ...ctx });
        return NextResponse.json({ error: "AI attendees are off for this event", code: "AI_OFF" }, { status: 403 });
      }
      const rl = checkRateLimit({ key: `venue-ai:${gate.userId}`, ...LIMIT });
      if (!rl.allowed) return rateLimited(rl, { route: ROUTE, ...ctx, limit: LIMIT.limit, windowSeconds: 3600 });

      const parsed = bodySchema.safeParse(await req.json().catch(() => null));
      if (!parsed.success) {
        apiLogger.warn({ msg: `${ROUTE}:invalid-body`, ...ctx, errors: parsed.error.flatten() });
        return NextResponse.json({ error: "Invalid input", code: "INVALID_INPUT" }, { status: 400 });
      }
      const body = parsed.data;
      const persona = checkPersona(body.persona);
      if (!persona) {
        apiLogger.warn({ msg: `${ROUTE}:unknown-persona`, ...ctx });
        return NextResponse.json({ error: "Unknown attendee", code: "INVALID_PERSONA" }, { status: 400 });
      }
      const turns = cleanTurns(body.turns);
      if (!turns) {
        apiLogger.warn({ msg: `${ROUTE}:nothing-to-answer`, ...ctx });
        return NextResponse.json({ error: "Nothing to answer", code: "INVALID_TURNS" }, { status: 400 });
      }

      const e = gate.event, tz = resolveTimezone(e.timezone), day = venueDay(tz);
      const caller = { organizationId: gate.organizationId, eventId, userId: gate.userId };
      if (!(await claimReply(caller, day))) {
        apiLogger.warn({ msg: `${ROUTE}:event-daily-cap`, ...ctx, day, cap: VENUE_AI_PER_EVENT_DAY });
        return NextResponse.json({ error: "Today's AI replies for this event are used up", code: "AI_LIMIT_EVENT" }, { status: 429 });
      }
      // A generated venue: the instructions describe its own rooms, organiser and subject (phase 6).
      const built = eventLayout(e);
      const layout = built.kind === "generated" ? built.layout : undefined;
      const scene = {
        layout,
        event: {
          name: e.name, date: venueDateRange(e.startDate, e.endDate, tz), venue: e.venue || "the venue",
          ...(layout && { organiser: e.organization?.name ?? undefined, specialty: e.specialty ?? undefined }),
        },
        zone: body.zone ?? "",
        pose: body.pose ?? "",
        role: body.role ?? "",
        greeting: checkGreeting(body.greeting, persona),
      };
      const res = await streamVenueReply(caller, day, persona, scene, turns);
      if (!res.ok) return NextResponse.json({ error: res.message, code: res.code }, { status: 502 });
      return new Response(res.stream, {
        headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store", "X-Accel-Buffering": "no", "X-Content-Type-Options": "nosniff" },
      });
    });
  } catch (err) {
    apiLogger.error({ err, msg: `${ROUTE}:failed` });
    return NextResponse.json({ error: "Failed to answer" }, { status: 500 });
  }
}
