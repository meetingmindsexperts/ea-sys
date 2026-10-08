/**
 * AI attendees in the online venue (docs/EVENT_BLUEPRINT_PLAN.md §5.3 and
 * §5.4a, phase 5B). Owner rulings, Oct 8, 2026: 40 replies an hour per person,
 * 2,000 a day per event, on by default with a switch for the event team. When
 * a limit is hit, or AI is off, the page falls back to its pre-written answers.
 *
 * The daily count lives in `VenueAiUsage` and a reply is CLAIMED there before
 * Anthropic is called (a guarded increment), so the cap holds across restarts,
 * deploys and the blue/green pair; a call that fails gives its claim back.
 * The route decides who may call; this service trusts its caller. Errors are
 * values; never imports next/server.
 */
import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { runWithTenant } from "@/lib/tenant-context";
import { updateEventSettings } from "@/lib/event-settings";
import { anthropicProvider } from "@/lib/ai/anthropic";
import { resolveAnthropicApiKey } from "@/lib/ai/credentials";
import { getModelConfig } from "@/lib/ai/config";
import type { StreamEvent } from "@/lib/ai";
import { buildInstructions, type Persona, type Scene, type Turn } from "@/lib/venue/ai-prompt";

/** Owner ruling (Oct 8, 2026): replies per person per hour, and per event per day. */
export const VENUE_AI_PER_PERSON_HOUR = 40;
export const VENUE_AI_PER_EVENT_DAY = 2000;

interface Caller {
  organizationId: string;
  eventId: string;
  userId: string;
}

/** AI attendees are on unless the event team switched them off (`Event.settings.venue.ai.on`). */
export function readVenueAi(settings: unknown): { on: boolean } {
  const venue = settings && typeof settings === "object" ? (settings as Record<string, unknown>).venue : null;
  const ai = venue && typeof venue === "object" ? (venue as Record<string, unknown>).ai : null;
  return { on: !(ai && typeof ai === "object" && (ai as Record<string, unknown>).on === false) };
}

/** The event team switches AI attendees on or off; only `settings.venue.ai` changes. */
export async function saveVenueAi(organizationId: string, eventId: string, on: boolean) {
  await runWithTenant(organizationId, () =>
    updateEventSettings(eventId, (cur) => {
      const venue = cur.venue && typeof cur.venue === "object" ? (cur.venue as Record<string, unknown>) : {};
      return { ...cur, venue: { ...venue, ai: { on } } };
    }),
  );
  return { on };
}

/** Today's date in the event's own timezone: the daily cap's day. */
export function venueDay(timezone: string, now = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}

/** Replies used today, for the event team's panel. */
export function usageToday(organizationId: string, eventId: string, day: string) {
  return runWithTenant(organizationId, async () => {
    const row = await db.venueAiUsage.findUnique({ where: { eventId_day: { eventId, day } }, select: { replies: true } });
    return { day, replies: row?.replies ?? 0, cap: VENUE_AI_PER_EVENT_DAY, perPersonHour: VENUE_AI_PER_PERSON_HOUR };
  });
}

/** Claim one of today's replies; false when the event's daily cap is reached. */
export async function claimReply(c: Caller, day: string): Promise<boolean> {
  return runWithTenant(c.organizationId, async () => {
    try {
      await db.venueAiUsage.upsert({
        where: { eventId_day: { eventId: c.eventId, day } },
        create: { eventId: c.eventId, organizationId: c.organizationId, day },
        update: {},
      });
    } catch (err) {
      // Two first replies of the day at once: the other one created the row.
      if (!(err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002")) throw err;
    }
    const claimed = await db.venueAiUsage.updateMany({
      where: { eventId: c.eventId, organizationId: c.organizationId, day, replies: { lt: VENUE_AI_PER_EVENT_DAY } },
      data: { replies: { increment: 1 } },
    });
    return claimed.count === 1;
  });
}

/** Give a claim back when Anthropic never answered. */
async function releaseReply(c: Caller, day: string) {
  await runWithTenant(c.organizationId, () =>
    db.venueAiUsage.updateMany({ where: { eventId: c.eventId, organizationId: c.organizationId, day, replies: { gt: 0 } }, data: { replies: { decrement: 1 } } }),
  );
}

async function recordTokens(c: Caller, day: string, inputTokens: number, outputTokens: number) {
  await runWithTenant(c.organizationId, () =>
    db.venueAiUsage.updateMany({
      where: { eventId: c.eventId, organizationId: c.organizationId, day },
      data: { inputTokens: { increment: inputTokens }, outputTokens: { increment: outputTokens } },
    }),
  );
}

export type VenueReplyResult = { ok: true; stream: ReadableStream<Uint8Array> } | { ok: false; code: "AI_UNAVAILABLE"; message: string };

/**
 * One AI attendee reply, streamed as plain text. The caller has already
 * claimed it (`claimReply`). Waits for the first piece of text, so a provider
 * that fails at once is reported as AI_UNAVAILABLE (and the claim given back)
 * instead of an empty stream; after that the text flows as it arrives, and the
 * token counts are recorded when it ends.
 */
export async function streamVenueReply(c: Caller, day: string, per: Persona, scene: Scene, turns: Turn[]): Promise<VenueReplyResult> {
  const ctx = { organizationId: c.organizationId, eventId: c.eventId, userId: c.userId };
  const config = getModelConfig("venueAttendee");
  const started = Date.now();
  let events: AsyncIterator<StreamEvent>;
  let first: IteratorResult<StreamEvent>;
  try {
    events = anthropicProvider
      .streamChat({
        apiKey: await resolveAnthropicApiKey(c.organizationId),
        model: config.model,
        maxTokens: config.maxTokens,
        temperature: config.temperature,
        system: [{ text: buildInstructions(per, scene) }],
        messages: turns,
      })
      [Symbol.asyncIterator]();
    first = await events.next();
  } catch (err) {
    apiLogger.error({ msg: "venue-ai:provider-failed", ...ctx, model: config.model, err });
    await releaseReply(c, day).catch((e) => apiLogger.error({ msg: "venue-ai:release-failed", ...ctx, err: e }));
    return { ok: false, code: "AI_UNAVAILABLE", message: "The AI could not answer just now." };
  }

  const encoder = new TextEncoder();
  let chars = 0;
  const finish = async (ev: StreamEvent) => {
    if (ev.type !== "done") return;
    const usage = ev.usage;
    apiLogger.info({ msg: "venue-ai:answered", ...ctx, persona: per.name, model: config.model, chars, inputTokens: usage?.inputTokens, outputTokens: usage?.outputTokens, durationMs: Date.now() - started });
    if (usage) await recordTokens(c, day, usage.inputTokens, usage.outputTokens).catch((e) => apiLogger.error({ msg: "venue-ai:usage-failed", ...ctx, err: e }));
  };
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        for (let r = first; !r.done; r = await events.next()) {
          if (r.value.type === "text") {
            chars += r.value.delta.length;
            controller.enqueue(encoder.encode(r.value.delta));
          } else await finish(r.value);
        }
      } catch (err) {
        // Mid-reply failure: the attendee keeps what arrived; the page ends the line there.
        apiLogger.error({ msg: "venue-ai:stream-failed", ...ctx, chars, err });
      } finally {
        controller.close();
      }
    },
    async cancel() {
      // The attendee walked away or pressed Stop: stop paying for the rest.
      apiLogger.info({ msg: "venue-ai:cancelled", ...ctx, chars });
      await events.return?.();
    },
  });
  return { ok: true, stream };
}
