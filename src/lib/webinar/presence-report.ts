/**
 * The attendance report from our own webinar page (Nov 16, 2026; external
 * streams step 6, docs/EXTERNAL_STREAM_AND_PRERECORDED_PLAN.md §4.8): one line
 * per registration that opened the webinar page, with when they first came,
 * when they were last seen, how many times they joined, and the minutes they
 * watched while the room was open (presence-watch.ts).
 *
 * For a webinar a partner streams in this is the only attendance there is; for
 * one of ours in custom-stream mode it is the audience, where Zoom's report
 * sees only the speakers. Times are in the event's timezone, named in the
 * header, because the people reading the file are in that timezone.
 */
import { toCsv } from "@/lib/csv-escape";
import { localDateTimeInTz } from "@/lib/event-time";

export interface PresenceReportRow {
  name: string;
  email: string | null;
  serialId: number | null;
  firstJoinedAt: Date;
  lastSeenAt: Date;
  /** Admitted from the lobby, plus each return after an absence. 0 while only ever in the lobby. */
  timesJoined: number;
  watchedSeconds: number;
  /** "joined": reached the live view at least once; "lobby": never left the waiting room. */
  phase: string;
}

export interface PresenceReportSummary {
  /** Registrations that opened the webinar page. */
  opened: number;
  /** Of those, the ones who reached the live view. */
  joined: number;
  totalWatchedSeconds: number;
  /** Average over the people who joined; 0 when nobody did. */
  avgWatchedSeconds: number;
}

/** A lobby row's joinCount starts at 1 for the first beat; it has not joined until it was admitted. */
export function timesJoined(row: { phase: string; joinCount: number }): number {
  return row.phase === "joined" ? row.joinCount : 0;
}

export function presenceReportSummary(rows: readonly Pick<PresenceReportRow, "phase" | "watchedSeconds">[]): PresenceReportSummary {
  const joinedRows = rows.filter((r) => r.phase === "joined");
  const totalWatchedSeconds = joinedRows.reduce((sum, r) => sum + r.watchedSeconds, 0);
  return {
    opened: rows.length,
    joined: joinedRows.length,
    totalWatchedSeconds,
    avgWatchedSeconds: joinedRows.length > 0 ? Math.round(totalWatchedSeconds / joinedRows.length) : 0,
  };
}

function inZone(date: Date, timezone: string): string {
  return localDateTimeInTz(date, timezone).replace("T", " ");
}

/** The CSV, escaped against formula injection (attendee names are typed by the public). */
export function presenceReportCsv(rows: readonly PresenceReportRow[], timezone: string): string {
  const header = [
    "Name",
    "Email",
    "Registration #",
    `First on the page (${timezone})`,
    `Last seen (${timezone})`,
    "Times joined",
    "Minutes watched",
  ];
  const lines = rows.map((r) => [
    r.name,
    r.email,
    r.serialId ? String(r.serialId).padStart(3, "0") : null,
    inZone(r.firstJoinedAt, timezone),
    inZone(r.lastSeenAt, timezone),
    r.timesJoined,
    Math.round(r.watchedSeconds / 60),
  ]);
  return toCsv([header, ...lines]);
}
