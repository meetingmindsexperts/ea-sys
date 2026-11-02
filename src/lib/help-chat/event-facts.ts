/**
 * Event facts for the Help Assistant's external audience (Nov 2, 2026).
 *
 * An abstract author, reviewer or attendee asking "who do I contact?" or
 * "can I submit a case study?" was told the bot didn't know, although we know
 * exactly which events they are on. This loads a few facts from those events
 * for the uncached tail of the system prompt: name, dates, the event team's
 * support email, and (for authors and reviewers) the abstract deadline and
 * the presentation types the event actually offers.
 *
 * MULTI-TENANCY: these people are org-independent (organizationId null), so
 * the read is deliberately not wrapped in runWithTenant, the same class as
 * the reviewer feed (src/app/api/my-reviews/route.ts). On an RLS-enabled
 * instance it fail-closes to an empty list, which the prompt handles.
 */
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { buildEventAccessWhere } from "@/lib/event-access";
import { isDeadlinePassed, readAbstractDeadline } from "@/lib/submission-deadline";
import { readEnabledPresentationTypes } from "@/lib/abstract-presentation-types";
import { PRESENTATION_TYPE_OPTIONS } from "@/app/(dashboard)/events/[eventId]/abstracts/abstract-enums";
import type { Prisma } from "@prisma/client";
import type { HelpChatEventFacts } from "./system-prompt";

/** A person on more events than this gets the most recent ones. */
const MAX_EVENTS = 5;
const MAX_NAME_LENGTH = 200;

interface ExternalAsker {
  id: string;
  role: string;
}

export async function loadExternalHelpEvents(user: ExternalAsker): Promise<HelpChatEventFacts[]> {
  const withAbstracts = user.role === "SUBMITTER" || user.role === "REVIEWER";
  try {
    const events = await db.event.findMany({
      where: { AND: [eventsOf(user), { status: { not: "CANCELLED" } }] },
      orderBy: { startDate: "desc" },
      take: MAX_EVENTS,
      select: { name: true, startDate: true, endDate: true, timezone: true, supportEmail: true, settings: true },
    });
    return events.map((e) => ({
      name: oneLine(e.name).slice(0, MAX_NAME_LENGTH),
      dates: formatDateRange(e.startDate, e.endDate, e.timezone),
      supportEmail: e.supportEmail?.trim() || null,
      abstractDeadline: withAbstracts ? formatDeadline(readAbstractDeadline(e.settings), e.timezone) : null,
      presentationTypes: withAbstracts ? presentationTypeLabels(e.settings) : [],
    }));
  } catch (err) {
    // The facts improve answers; they never gate them.
    apiLogger.warn({ msg: "help-chat:event-facts-failed", userId: user.id, role: user.role, err });
    return [];
  }
}

/**
 * The events this person takes part in. A reviewer can also hold a
 * per-abstract assignment on an event whose reviewer pool does not list them.
 */
function eventsOf(user: ExternalAsker): Prisma.EventWhereInput {
  const where = buildEventAccessWhere(user);
  if (user.role !== "REVIEWER") return where;
  return { OR: [where, { abstracts: { some: { reviewers: { some: { userId: user.id } } } } }] };
}

function presentationTypeLabels(settings: unknown): string[] {
  const enabled = new Set<string>(readEnabledPresentationTypes(settings));
  return PRESENTATION_TYPE_OPTIONS.filter((o) => enabled.has(o.value)).map((o) => o.label);
}

function formatDateRange(start: Date, end: Date, timeZone: string): string {
  const fmt = dateFormatter(timeZone, false);
  const a = fmt.format(start);
  const b = fmt.format(end);
  return a === b ? a : `${a} to ${b}`;
}

function formatDeadline(iso: string | null, timeZone: string): string | null {
  if (!iso) return null;
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return null;
  // Said outright: given only the date, the bot told an author whose deadline
  // had passed a month earlier to "make sure it's submitted before then".
  const passed = isDeadlinePassed(iso) ? ", already passed" : "";
  return `${dateFormatter(timeZone, true).format(at)} (${timeZone}${passed})`;
}

function dateFormatter(timeZone: string, withTime: boolean): Intl.DateTimeFormat {
  const opts: Intl.DateTimeFormatOptions = { day: "numeric", month: "long", year: "numeric" };
  if (withTime) Object.assign(opts, { hour: "2-digit", minute: "2-digit", hour12: false });
  try {
    return new Intl.DateTimeFormat("en-GB", { ...opts, timeZone });
  } catch {
    // An unrecognised zone name must not lose the date.
    return new Intl.DateTimeFormat("en-GB", { ...opts, timeZone: "UTC" });
  }
}

function oneLine(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}
