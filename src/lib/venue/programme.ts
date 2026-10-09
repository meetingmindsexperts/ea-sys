/**
 * The event's programme inside the online venue (docs/EVENT_BLUEPRINT_PLAN.md,
 * phase 6 step 4): which room each session is in, and the sponsors in the
 * order they take stands. Pure; the data comes from venue-programme-service.
 *
 * A session is in a room when its location or its track has the room's name
 * (owner ruling, Oct 9 2026). Teams name tracks after rooms far more often
 * than they fill in a location, so both count, and the location wins when the
 * two disagree because it is the more specific of the two. A location like
 * "Main Hall — Al Majlis" also matches "Main Hall".
 */
import { SPONSOR_TIERS, type SponsorEntry } from "@/lib/webinar";

export const MAX_VENUE_SESSIONS = 400;
export const MAX_VENUE_SPONSORS = 60;
/** The sessions the AI attendees are told about: one day's, at most this many. */
export const MAX_AI_SESSIONS = 40;

export interface VenueRoomRef { id: string; name: string }

export interface SessionInput {
  name: string;
  startTime: Date;
  endTime: Date;
  location: string | null;
  track: string | null;
}

export interface VenueSession {
  /** The venue room's id, or null when the session names no room. */
  room: string | null;
  title: string;
  start: string;
  end: string;
  track?: string;
  /** The location as the team wrote it, kept only for sessions that match no room. */
  where?: string;
}

export interface VenueSponsor { name: string; tier?: string; logo?: string; website?: string; about?: string }

export interface VenueProgramme { v: 1; tz: string; sessions: VenueSession[]; sponsors: VenueSponsor[] }

const norm = (s: string) =>
  s.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9؀-ۿ]+/g, " ").trim().replace(/^the /, "");

/** The room a location or track names, or null. */
export function matchRoom(rooms: VenueRoomRef[], text: string | null | undefined): string | null {
  const raw = text?.trim();
  if (!raw) return null;
  // "Main Hall — Al Majlis", "Hall B (moved)", "Hall C, level 2": the room is the part before the separator.
  const candidates = [raw, raw.split(/\s[—–-]\s|[,(|]/)[0]].map(norm).filter(Boolean);
  for (const c of candidates) {
    const hit = rooms.find((r) => norm(r.name) === c);
    if (hit) return hit.id;
  }
  return null;
}

/** The room a session is in: its location first, then its track. */
export function roomOfSession(rooms: VenueRoomRef[], s: Pick<SessionInput, "location" | "track">): string | null {
  return matchRoom(rooms, s.location) ?? matchRoom(rooms, s.track);
}

const clip = (s: string | null | undefined, n: number) => (s ? s.trim().slice(0, n) : undefined);
const tierRank = (t?: string) => {
  const i = (SPONSOR_TIERS as readonly string[]).indexOf(t ?? "");
  return i < 0 ? SPONSOR_TIERS.length : i;
};
/** A link the page may open: http(s) only. */
const safeUrl = (u?: string) => (u && /^https?:\/\//i.test(u.trim()) ? u.trim().slice(0, 300) : undefined);
/** A logo the page may load: our own uploads or an https image. */
const safeLogo = (u?: string) => (u && (/^\/uploads\//.test(u) || /^https:\/\//i.test(u)) ? u.trim().slice(0, 300) : undefined);

/** Sponsors in the order they take stands: by tier (platinum first), then the team's own order. */
export function orderSponsors(list: SponsorEntry[]): VenueSponsor[] {
  return list
    .map((s, i) => ({ s, i }))
    .sort((a, b) => tierRank(a.s.tier) - tierRank(b.s.tier) || a.i - b.i)
    .slice(0, MAX_VENUE_SPONSORS)
    .map(({ s }) => ({
      name: s.name.trim().slice(0, 80),
      ...(s.tier && { tier: s.tier }),
      ...(safeLogo(s.logoUrl) && { logo: safeLogo(s.logoUrl) }),
      ...(safeUrl(s.websiteUrl) && { website: safeUrl(s.websiteUrl) }),
      ...(s.description?.trim() && { about: s.description.trim().slice(0, 400) }),
    }));
}

export function buildProgramme(rooms: VenueRoomRef[], sessions: SessionInput[], sponsors: SponsorEntry[], tz: string): VenueProgramme {
  const out = sessions
    .slice()
    .sort((a, b) => a.startTime.getTime() - b.startTime.getTime())
    .slice(0, MAX_VENUE_SESSIONS)
    .map((s): VenueSession => {
      const room = roomOfSession(rooms, s);
      return {
        room,
        title: s.name.trim().slice(0, 140),
        start: s.startTime.toISOString(),
        end: s.endTime.toISOString(),
        ...(clip(s.track, 80) && { track: clip(s.track, 80) }),
        ...(!room && (clip(s.location, 80) || clip(s.track, 80)) && { where: clip(s.location, 80) || clip(s.track, 80) }),
      };
    });
  return { v: 1, tz, sessions: out, sponsors: orderSponsors(sponsors) };
}

/** YYYY-MM-DD of an instant in the event's timezone. */
export function dayIn(tz: string, at: Date): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(at);
}
const hm = (tz: string, iso: string) => new Intl.DateTimeFormat("en-GB", { timeZone: tz, hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(iso));

/**
 * The day the venue talks about: today when the programme has sessions today,
 * else the first day before the event starts, else the last day after it.
 */
export function programmeDay(p: VenueProgramme, now: Date): string | null {
  const days = [...new Set(p.sessions.map((s) => dayIn(p.tz, new Date(s.start))))].sort();
  if (!days.length) return null;
  const today = dayIn(p.tz, now);
  if (days.includes(today)) return today;
  return today < days[0] ? days[0] : (days.filter((d) => d < today).pop() ?? days[0]);
}

/**
 * What the AI attendees are told: one day's sessions room by room and the
 * sponsors with stands. Only text the event team entered, clipped; null when
 * there is nothing to tell (the AI then says it has no programme).
 */
export function programmeForAi(p: VenueProgramme, rooms: VenueRoomRef[], now: Date, stands: number): string | null {
  const day = programmeDay(p, now);
  const todays = day ? p.sessions.filter((s) => s.room && dayIn(p.tz, new Date(s.start)) === day).slice(0, MAX_AI_SESSIONS) : [];
  const withStands = p.sponsors.slice(0, stands);
  if (!todays.length && !withStands.length) return null;
  const lines: string[] = [];
  if (todays.length) {
    const label = new Intl.DateTimeFormat("en-GB", { timeZone: p.tz, weekday: "long", day: "numeric", month: "long" }).format(new Date(todays[0].start));
    lines.push(`The programme for ${label}, room by room (times are local):`);
    for (const r of rooms) {
      const mine = todays.filter((s) => s.room === r.id);
      if (mine.length) lines.push(`${r.name}: ${mine.map((s) => `${hm(p.tz, s.start)}-${hm(p.tz, s.end)} ${s.title}${s.track && norm(s.track) !== norm(r.name) ? ` (${s.track} track)` : ""}`).join("; ")}.`);
    }
  }
  if (withStands.length) lines.push(`Sponsors with stands in the exhibition: ${withStands.map((s) => s.name).join(", ")}.`);
  return lines.join("\n");
}
