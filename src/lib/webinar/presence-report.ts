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
import {
  breakdown,
  deviceLabel,
  viewModeLabel,
  watchingTimeline,
  type BreakdownEntry,
  type TimelinePoint,
} from "@/lib/webinar/watch-analytics";

export interface PresenceReportRow {
  name: string;
  email: string | null;
  serialId: number | null;
  firstJoinedAt: Date;
  lastSeenAt: Date;
  /** The first time in the live view, plus each return after an absence. 0 while only ever in the lobby. */
  timesJoined: number;
  watchedSeconds: number;
  /** "joined": reached the live view at least once; "lobby": never left the waiting room. */
  phase: string;
  // Watch analytics (Nov 23, 2026; watch-analytics.ts). Null on rows from before that day.
  deviceType: string | null;
  browser: string | null;
  os: string | null;
  viewMode: string | null;
  stallCount: number;
  stallSeconds: number;
  reconnectCount: number;
  watchedMinutes: readonly number[];
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

/**
 * A row's joinCount is 1 from its first beat, but that join is counted only once the person reached the
 * live view. Rows written before Nov 16, 2026 also added one on admission from the lobby, so an earlier
 * webinar can read one too high.
 */
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

/** The same summary from the database's per-phase counts and sums (the console's polled view). */
export function presenceSummaryFromGroups(
  groups: readonly { phase: string; _count: { _all: number }; _sum: { watchedSeconds: number | null } }[],
): PresenceReportSummary {
  const opened = groups.reduce((n, g) => n + g._count._all, 0);
  const joinedGroup = groups.find((g) => g.phase === "joined");
  const joined = joinedGroup?._count._all ?? 0;
  const totalWatchedSeconds = joinedGroup?._sum.watchedSeconds ?? 0;
  return { opened, joined, totalWatchedSeconds, avgWatchedSeconds: joined > 0 ? Math.round(totalWatchedSeconds / joined) : 0 };
}

function inZone(date: Date, timezone: string): string {
  return localDateTimeInTz(date, timezone).replace("T", " ");
}

/**
 * The minutes a person was watching, as time ranges in the event's timezone ("10:02-10:15, 10:20-10:45").
 * A range ends at the end of its last minute.
 */
export function watchingRanges(minutes: readonly number[], timezone: string): string {
  const sorted = [...new Set(minutes)].sort((a, b) => a - b);
  if (sorted.length === 0) return "";
  const ranges: [number, number][] = [];
  for (const m of sorted) {
    const last = ranges[ranges.length - 1];
    if (last && m === last[1] + 1) last[1] = m;
    else ranges.push([m, m]);
  }
  const clock = (m: number) => localDateTimeInTz(new Date(m * 60_000), timezone).slice(11, 16);
  return ranges.map(([from, to]) => `${clock(from)}-${clock(to + 1)}`).join(", ");
}

/** The CSV, escaped against formula injection (attendee names are typed by the public). */
export function presenceReportCsv(rows: readonly PresenceReportRow[], timezone: string): string {
  const header = [
    "Name",
    "Email",
    "Registration #",
    `First on the page (${timezone})`,
    `Last on the page (${timezone})`,
    "Times joined",
    "Minutes watched",
    `Watching (${timezone})`,
    "Watched via",
    "Device",
    "Browser",
    "System",
    "Times buffering",
    "Seconds buffering",
    "Reconnects",
  ];
  const lines = rows.map((r) => [
    r.name,
    r.email,
    r.serialId ? String(r.serialId).padStart(3, "0") : null,
    inZone(r.firstJoinedAt, timezone),
    inZone(r.lastSeenAt, timezone),
    r.timesJoined,
    Math.round(r.watchedSeconds / 60),
    watchingRanges(r.watchedMinutes, timezone),
    viewModeLabel(r.viewMode),
    deviceLabel(r.deviceType),
    r.browser,
    r.os,
    r.stallCount,
    r.stallSeconds,
    r.reconnectCount,
  ]);
  return toCsv([header, ...lines]);
}

/** How our stream played on one system, for the people who watched it there. */
export interface PlaybackBySystem {
  system: string;
  viewers: number;
  /** Viewers who buffered at least once. */
  buffered: number;
  stallSeconds: number;
  reconnects: number;
}

/** The console's watch analytics (?view=analytics): no names, everyone who reached the live view. */
export interface WatchAnalytics {
  /** People who reached the live view: everything below counts them. */
  watched: number;
  devices: BreakdownEntry[];
  browsers: BreakdownEntry[];
  systems: BreakdownEntry[];
  viewModes: BreakdownEntry[];
  playback: {
    /** People who watched on our stream player (the only one that reports buffering). */
    streamViewers: number;
    buffered: number;
    stallSeconds: number;
    reconnects: number;
    bySystem: PlaybackBySystem[];
  };
  timeline: TimelinePoint[];
}

export type WatchAnalyticsRow = Pick<
  PresenceReportRow,
  "phase" | "deviceType" | "browser" | "os" | "viewMode" | "stallCount" | "stallSeconds" | "reconnectCount" | "watchedMinutes"
>;

export function watchAnalytics(rows: readonly WatchAnalyticsRow[]): WatchAnalytics {
  const watchedRows = rows.filter((r) => r.phase === "joined");
  const streamRows = watchedRows.filter((r) => r.viewMode === "stream");
  const bySystem = new Map<string, PlaybackBySystem>();
  for (const r of streamRows) {
    const system = r.os ?? "Unknown";
    const entry = bySystem.get(system) ?? { system, viewers: 0, buffered: 0, stallSeconds: 0, reconnects: 0 };
    entry.viewers += 1;
    if (r.stallCount > 0) entry.buffered += 1;
    entry.stallSeconds += r.stallSeconds;
    entry.reconnects += r.reconnectCount;
    bySystem.set(system, entry);
  }
  return {
    watched: watchedRows.length,
    devices: breakdown(watchedRows.map((r) => deviceLabel(r.deviceType))),
    browsers: breakdown(watchedRows.map((r) => r.browser)),
    systems: breakdown(watchedRows.map((r) => r.os)),
    viewModes: breakdown(watchedRows.map((r) => viewModeLabel(r.viewMode))),
    playback: {
      streamViewers: streamRows.length,
      buffered: streamRows.filter((r) => r.stallCount > 0).length,
      stallSeconds: streamRows.reduce((n, r) => n + r.stallSeconds, 0),
      reconnects: streamRows.reduce((n, r) => n + r.reconnectCount, 0),
      bySystem: [...bySystem.values()].sort((a, b) => b.viewers - a.viewers || a.system.localeCompare(b.system)),
    },
    timeline: watchingTimeline(watchedRows),
  };
}
