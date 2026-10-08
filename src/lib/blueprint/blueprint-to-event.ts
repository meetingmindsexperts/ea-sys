/**
 * What an approved blueprint becomes in EA-SYS (plan §4.5), as pure data:
 * the event, its sessions and its sponsors. Reads the SANITISED blueprint
 * (vendor-rules.ts), so every field already has its type.
 *
 * Owner rulings (Oct 8, 2026):
 *  - the event needs a real start date: a vague "When" ("March 2027",
 *    "spring") refuses approval with DATES_NEEDED rather than inventing one;
 *  - Format: In person = CONFERENCE, Hybrid = HYBRID, Virtual = WEBINAR (its
 *    Zoom webinar is provisioned, as when an organiser picks Webinar), Online
 *    world only = CONFERENCE (the 3D venue is its online part, no Zoom).
 *
 * Named people in the brief carry no email address, so they stay in the
 * brief rather than becoming speakers (plan §4.5: only rows with an email).
 */
import type { EventType } from "@prisma/client";
import { wallTimeInTzToDate } from "@/lib/event-time";
import type { ReadDate } from "./vendor-rules";

const FORMAT_TO_TYPE: Record<string, EventType> = {
  "In person": "CONFERENCE",
  Hybrid: "HYBRID",
  Virtual: "WEBINAR",
  "Online world only": "CONFERENCE",
};

/**
 * The brief's partner tiers (Title, Platinum, Gold, Silver, Bronze, Exhibitor,
 * Media, Supporter) as EA-SYS sponsor tiers (SPONSOR_TIERS, lowercase). Found
 * in the approval walkthrough: "Gold" as written was refused, so the sponsor
 * was never added.
 */
const PARTNER_TIER: Record<string, string> = {
  title: "platinum",
  platinum: "platinum",
  gold: "gold",
  silver: "silver",
  bronze: "bronze",
  exhibitor: "exhibitor",
  media: "partner",
  supporter: "partner",
  partner: "partner",
};

const WORD_DAYS: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7 };
const MAX_DAYS = 14;
const DEFAULT_SESSION_MINUTES = 60;

export interface PlannedSession {
  name: string;
  startTime: Date;
  endTime: Date;
  location: string | null;
  description: string | null;
}

export interface EventPlan {
  event: {
    name: string;
    startDate: Date;
    endDate: Date;
    eventType: EventType | null;
    description: string | null;
    venue: string | null;
  };
  sessions: PlannedSession[];
  sponsors: { name: string; tier: string | null }[];
  /** What stayed in the brief, and why: shown in the approval record. */
  skipped: string[];
}

export type EventPlanResult = { ok: true; plan: EventPlan } | { ok: false; code: "DATES_NEEDED"; message: string };

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj => (v && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : {});
const text = (v: unknown, max: number): string => (typeof v === "string" ? v.trim().slice(0, max) : "");
const rows = (v: unknown): Obj[] => (Array.isArray(v) ? v.map(obj) : []);
const pad = (n: number) => String(n).padStart(2, "0");

/** "2 days", "a two-day congress", "3-day": the number of days, else 1. */
export function daysFrom(duration: string): number {
  const t = duration.toLowerCase();
  const digit = t.match(/(\d+)\s*-?\s*days?\b/);
  if (digit) return Math.min(MAX_DAYS, Math.max(1, Number(digit[1])));
  const word = t.match(/\b(one|two|three|four|five|six|seven)\s*-?\s*days?\b/);
  return word ? WORD_DAYS[word[1]] : 1;
}

/** The calendar day `offset` days after y-m-d, as YYYY-MM-DD. */
function dayAfter(y: number, m: number, d: number, offset: number): string {
  const t = new Date(Date.UTC(y, m - 1, d + offset));
  return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`;
}

/**
 * The programme rows as sessions on the first day: each starts at its HH:MM,
 * ends when the next one starts (or after an hour), never past the day's end.
 * Rows with no title or no readable time are skipped and named.
 */
function plannedSessions(programme: Obj[], day1: string, timeZone: string, skipped: string[]): PlannedSession[] {
  const timed = programme
    .map((r) => ({ r, time: text(r.time, 10).match(/^(\d{1,2})[:.](\d{2})$/) }))
    .filter(({ r, time }) => {
      const title = text(r.title, 200);
      if (!title) return false;
      if (time && Number(time[1]) < 24 && Number(time[2]) < 60) return true;
      skipped.push(`Programme item "${title}": no time like 09:00, so not added to the agenda`);
      return false;
    })
    .map(({ r, time }) => ({ r, start: wallTimeInTzToDate(`${day1}T${pad(Number(time![1]))}:${time![2]}`, timeZone) }))
    .sort((a, b) => a.start.getTime() - b.start.getTime());

  const dayEnd = wallTimeInTzToDate(`${day1}T23:59`, timeZone);
  return timed.map(({ r, start }, i) => {
    const next = timed[i + 1]?.start;
    const fallback = new Date(start.getTime() + DEFAULT_SESSION_MINUTES * 60_000);
    const end = next && next > start ? next : fallback;
    const who = text(r.who, 200);
    return {
      name: text(r.title, 200),
      startTime: start,
      endTime: end > dayEnd ? dayEnd : end,
      location: text(r.space, 120) || null,
      description: who ? `With: ${who}` : null,
    };
  });
}

/** The event plan for a sanitised, complete blueprint. */
export function planEventFromBlueprint(data: unknown, when: ReadDate, timeZone: string): EventPlanResult {
  const s = obj(data);
  const basics = obj(s.basics);
  if ("invalid" in when || when.approx || when.yearOnly) {
    return {
      ok: false,
      code: "DATES_NEEDED",
      message: 'Put an exact start date in "When" (for example 4 March 2027) before approving: the event needs real dates.',
    };
  }

  const skipped: string[] = [];
  const days = daysFrom(text(basics.duration, 200));
  const day1 = dayAfter(when.y, when.m, when.d, 0);
  const lastDay = dayAfter(when.y, when.m, when.d, days - 1);
  const look = obj(s.look);
  const people = obj(s.people);
  const partners = obj(s.partners);

  const named = rows(people.hosts).filter((h) => text(h.name, 120)).length;
  if (named) skipped.push(`${named} named ${named === 1 ? "person" : "people"}: no email address in the brief, so not added as speakers`);

  const sponsors =
    partners.has === "yes"
      ? rows(partners.list)
          .map((p) => ({ name: text(p.name, 120), tier: PARTNER_TIER[text(p.tier, 40).toLowerCase()] ?? null }))
          .filter((p) => p.name)
      : [];

  return {
    ok: true,
    plan: {
      event: {
        name: text(basics.title, 255),
        startDate: wallTimeInTzToDate(`${day1}T00:00`, timeZone),
        endDate: wallTimeInTzToDate(`${lastDay}T23:59`, timeZone),
        eventType: FORMAT_TO_TYPE[text(s.format, 40)] ?? null,
        description: text(basics.purpose, 2000) || null,
        venue: text(look.venueName, 255) || text(basics.location, 255) || null,
      },
      sessions: plannedSessions(rows(obj(s.programme).rows), day1, timeZone, skipped),
      sponsors,
      skipped,
    },
  };
}
