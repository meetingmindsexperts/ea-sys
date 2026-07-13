/**
 * Event-timezone helpers — a single source of truth for "what local date
 * is this instant in the event's timezone" and "how do we show a session
 * time to attendees".
 *
 * Isomorphic: uses only `Intl.DateTimeFormat`, so it runs in both Node
 * (API routes) and the browser (public pages). No Node-only imports — safe
 * to import from `"use client"` components.
 *
 * Why this exists: session date-validation and public time rendering were
 * each reimplementing (or skipping) timezone math, so the same session
 * could be validated in the server's UTC but displayed in the viewer's
 * local zone — neither being the event's actual timezone.
 */

export const DEFAULT_EVENT_TIMEZONE = "Asia/Dubai";

export function resolveTimezone(tz: string | null | undefined): string {
  return tz && tz.trim() ? tz : DEFAULT_EVENT_TIMEZONE;
}

/** The local calendar date (YYYY-MM-DD) of `date` in `timeZone`. */
export function localDateInTz(date: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

/**
 * True when a session falls within the event's date range, compared as
 * LOCAL DATES in the event's timezone. Mirrors the MCP create/update
 * logic so REST and MCP agree. A session at 11pm on the last event day
 * is valid even though its UTC instant is already "tomorrow".
 */
export function isSessionWithinEventDates(
  sessionStart: Date,
  sessionEnd: Date,
  eventStart: Date,
  eventEnd: Date,
  timeZone: string,
): boolean {
  const tz = resolveTimezone(timeZone);
  const evStart = localDateInTz(eventStart, tz);
  const evEnd = localDateInTz(eventEnd, tz);
  const sStart = localDateInTz(sessionStart, tz);
  const sEnd = localDateInTz(sessionEnd, tz);
  return sStart >= evStart && sEnd <= evEnd;
}

/** Time-of-day in the event timezone, e.g. "2:00 PM". */
export function formatTimeInTz(date: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: resolveTimezone(timeZone),
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  }).format(date);
}

/** Date in the event timezone, e.g. "Mon, Jun 15, 2026". */
export function formatDateInTz(date: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: resolveTimezone(timeZone),
    weekday: "short",
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(date);
}

/**
 * Short timezone label for `date` in `timeZone`, e.g. "GMT+4". Returned
 * separately so callers can render it once per row/section rather than on
 * every timestamp.
 */
export function tzLabel(date: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: resolveTimezone(timeZone),
    timeZoneName: "short",
  }).formatToParts(date);
  return parts.find((p) => p.type === "timeZoneName")?.value ?? "";
}

/** Where an event sits relative to now, in the event's own timezone. */
export type EventCountdown =
  /** Starts in the future. `days` is whole calendar days away (1 = tomorrow). */
  | { phase: "upcoming"; days: number; label: string }
  /** Today is between start and end inclusive. `day`/`totalDays` are 1-indexed. */
  | { phase: "ongoing"; day: number; totalDays: number; label: string }
  /** The end date has passed. `days` is whole calendar days since. */
  | { phase: "past"; days: number; label: string };

/** Whole days between two YYYY-MM-DD calendar dates (b − a). */
function daysBetweenLocalDates(a: string, b: string): number {
  const MS_PER_DAY = 86_400_000;
  // Parsing YYYY-MM-DD via Date.UTC keeps this arithmetic on a fixed 24h grid:
  // both operands are already timezone-resolved calendar dates, so no DST shift
  // can bleed in and turn a 1-day gap into 0.96 of one.
  const [ay, am, ad] = a.split("-").map(Number);
  const [by, bm, bd] = b.split("-").map(Number);
  return Math.round(
    (Date.UTC(by, bm - 1, bd) - Date.UTC(ay, am - 1, ad)) / MS_PER_DAY,
  );
}

/**
 * "How long until this event?" — counted in CALENDAR DAYS in the event's own
 * timezone, which is the only measure an organizer means by "days to go".
 *
 * The naive `(startDate - now) / 86400000` is wrong twice over, and both ways
 * are visible to the user. It measures elapsed time, not dates: at 11pm the
 * night before a 9am event it yields 0.4 → "0 days to go" when everyone in the
 * building would say "tomorrow". And it measures in the *viewer's* timezone, so
 * the same Dubai event reads a day apart for a colleague in London. Comparing
 * `localDateInTz` strings sidesteps both — it is date arithmetic on dates.
 *
 * `now` is injectable so callers can compute it once per render (React 19
 * forbids `Date.now()` during render) and so this is testable without faking
 * the clock.
 */
export function eventCountdown(
  startDate: Date | string,
  endDate: Date | string,
  timeZone: string | null | undefined,
  now: Date,
): EventCountdown {
  const tz = resolveTimezone(timeZone);
  const today = localDateInTz(now, tz);
  const start = localDateInTz(new Date(startDate), tz);
  const end = localDateInTz(new Date(endDate), tz);

  if (today < start) {
    const days = daysBetweenLocalDates(today, start);
    return {
      phase: "upcoming",
      days,
      label: days === 1 ? "Tomorrow" : `${days} days to go`,
    };
  }

  if (today <= end) {
    // An event is "ongoing" through the whole of its end DAY — a conference
    // that ends this evening has not ended this morning.
    const totalDays = daysBetweenLocalDates(start, end) + 1;
    const day = daysBetweenLocalDates(start, today) + 1;
    return {
      phase: "ongoing",
      day,
      totalDays,
      label: totalDays > 1 ? `Day ${day} of ${totalDays}` : "Today",
    };
  }

  const days = daysBetweenLocalDates(end, today);
  return {
    phase: "past",
    days,
    label: days === 1 ? "Ended yesterday" : `Ended ${days} days ago`,
  };
}
