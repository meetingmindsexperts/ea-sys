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
