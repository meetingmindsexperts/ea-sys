/**
 * CALENDAR DATES for the HR module. Everything here works on `YYYY-MM-DD`
 * strings, never on `Date` objects.
 *
 * WHY A STRING AND NOT A DATE. A leave day is a calendar date, not an instant.
 * `Date` cannot represent that: it always carries a timezone, so the same value
 * is a different day depending on who reads it. The classic failure is
 * `getDay()`, which answers in the reader's local zone, so a weekend silently
 * moves by one day on a machine set to anything other than UTC. A string cannot
 * carry a timezone and therefore cannot drift.
 *
 * Prisma returns a `@db.Date` column as a `Date` at UTC midnight, so the
 * conversion at that boundary is exact in both directions. Those two functions
 * are the ONLY place a `Date` appears in this module.
 *
 * ISO strings also sort lexically in date order, which is why comparison here is
 * plain string comparison and needs no parsing at all.
 */

import { z } from "zod";

/** A calendar date with no time and no timezone: `YYYY-MM-DD`. */
export type CalendarDate = string;

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MS_PER_DAY = 86_400_000;

/** True when the string is a well-formed, real calendar date. */
export function isCalendarDate(value: unknown): value is CalendarDate {
  if (typeof value !== "string" || !ISO_DATE_RE.test(value)) return false;
  // Round-trip guard: `Date.UTC` rolls over silently, so "2026-02-31" would
  // otherwise parse happily as March 3. Reading it back and comparing is the
  // only check that catches a right-shaped impossible date, and those arrive
  // from spreadsheet imports rather than from date pickers.
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return (
    !Number.isNaN(parsed.getTime()) &&
    parsed.toISOString().slice(0, 10) === value
  );
}

/** Prisma boundary: a `@db.Date` value (UTC midnight) to a calendar date. */
export function toCalendarDate(value: Date): CalendarDate {
  return value.toISOString().slice(0, 10);
}

/** Prisma boundary: a calendar date to the UTC-midnight `Date` a column wants. */
export function fromCalendarDate(value: CalendarDate): Date {
  if (!isCalendarDate(value)) {
    throw new Error(`hr-date: not a calendar date: ${JSON.stringify(value)}`);
  }
  return new Date(`${value}T00:00:00.000Z`);
}

/**
 * Day of week: 0 Sunday through 6 Saturday, matching `Date.prototype.getUTCDay`.
 * Computed in UTC by construction, so it is the same answer on every machine.
 */
export function dayOfWeek(date: CalendarDate): number {
  return fromCalendarDate(date).getUTCDay();
}

/** Shift a calendar date by whole days. Negative moves backwards. */
export function addDays(date: CalendarDate, days: number): CalendarDate {
  const shifted = new Date(fromCalendarDate(date).getTime() + days * MS_PER_DAY);
  return shifted.toISOString().slice(0, 10);
}

/** Whole days from `a` to `b`, negative when `b` precedes `a`. */
export function daysBetween(a: CalendarDate, b: CalendarDate): number {
  return Math.round(
    (fromCalendarDate(b).getTime() - fromCalendarDate(a).getTime()) / MS_PER_DAY,
  );
}

/** The four-digit year. */
export function yearOf(date: CalendarDate): number {
  return Number(date.slice(0, 4));
}

/**
 * Every date from `from` to `to`, inclusive. Returns nothing when `to` precedes
 * `from` rather than looping forever, because a reversed range is a caller bug
 * and an empty result is the safe way to surface it.
 */
export function eachDate(from: CalendarDate, to: CalendarDate): CalendarDate[] {
  const out: CalendarDate[] = [];
  if (daysBetween(from, to) < 0) return out;
  for (let d = from; daysBetween(d, to) >= 0; d = addDays(d, 1)) out.push(d);
  return out;
}

/**
 * Inclusive range test. Plain string comparison: ISO dates sort lexically in
 * date order, so this needs no parsing and cannot mis-handle a boundary.
 */
export function isWithin(
  date: CalendarDate,
  from: CalendarDate | null | undefined,
  to: CalendarDate | null | undefined,
): boolean {
  if (from && date < from) return false;
  if (to && date > to) return false;
  return true;
}

/** Today, in the given IANA timezone. HR reads dates in the org's own week. */
export function todayInTimezone(timeZone: string): CalendarDate {
  // `en-CA` formats as YYYY-MM-DD, which is the shape we want; the alternative
  // is assembling parts by hand and getting the zero-padding wrong.
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

/**
 * The Zod schema for a calendar date arriving over HTTP.
 *
 * Every HR route used to carry its own `/^\d{4}-\d{2}-\d{2}$/`, six copies of
 * it, and a regex only says the string is the right SHAPE. `2026-02-31` passed
 * all six, then threw inside `fromCalendarDate` further down the handler and
 * came back as a 500 with an error-level log, which pages. A date that cannot
 * exist is a bad request, not an outage.
 *
 * It reuses `isCalendarDate`, so the round-trip realness check has one
 * definition rather than being re-derived per route, and a seventh route gets
 * it by importing rather than by remembering.
 */
export const calendarDateSchema = z
  .string()
  .refine(isCalendarDate, "Expected a real date in YYYY-MM-DD form");
