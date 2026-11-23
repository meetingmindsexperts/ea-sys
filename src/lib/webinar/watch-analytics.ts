/**
 * Watch analytics on our own webinar page (Nov 23, 2026): what the presence
 * heartbeat records beyond minutes watched, and how the console reads it back.
 *
 *   device, browser, system   parsed on the server from the beat's user agent
 *                             (src/analytics/core/user-agent.ts); the text itself
 *                             is never stored. Two devices: the last one wins.
 *   how they watched          "stream" (our player) or "zoom" (the Zoom embed),
 *                             sent by the page with each beat.
 *   playback quality          buffering (a stall, and how long it lasted) and
 *                             reconnects, counted by our stream player and sent
 *                             as the amounts since the last beat that got through.
 *                             The Zoom embed reports none.
 *   minutes watching          the whole minutes (since 1970, UTC) in which a beat
 *                             counted watched time (presence-watch.ts), so the
 *                             console can draw how many were watching each minute.
 *
 * Client-safe: the webinar page imports the tally helpers, so nothing here may
 * import a server module.
 */

export const VIEW_MODES = ["stream", "zoom"] as const;
export type ViewMode = (typeof VIEW_MODES)[number];

/** What the stream player counted since the last beat that got through. */
export interface PlaybackTally {
  stalls: number;
  stallMs: number;
  reconnects: number;
}

export function emptyTally(): PlaybackTally {
  return { stalls: 0, stallMs: 0, reconnects: 0 };
}

export function tallyIsEmpty(t: PlaybackTally): boolean {
  return t.stalls === 0 && t.stallMs === 0 && t.reconnects === 0;
}

/**
 * Takes what a beat carried off the running tally once the beat got through. Not a reset to zero:
 * a stall can end while the beat is in flight, and it must go with the next one.
 */
export function subtractTally(current: PlaybackTally, sent: PlaybackTally): PlaybackTally {
  return {
    stalls: Math.max(0, current.stalls - sent.stalls),
    stallMs: Math.max(0, current.stallMs - sent.stallMs),
    reconnects: Math.max(0, current.reconnects - sent.reconnects),
  };
}

/**
 * Most one beat may add. The numbers come from the attendee's own browser and describe only their own
 * viewing, so this is a sanity bound, not a defence: a tab hidden for a while sends what it gathered in
 * one beat, and a broken or edited page must not write a day of buffering into the report.
 */
export const BEAT_QUALITY_MAX = { stalls: 50, stallSeconds: 600, reconnects: 20 } as const;

export function boundedQuality(t: PlaybackTally | undefined): { stalls: number; stallSeconds: number; reconnects: number } {
  if (!t) return { stalls: 0, stallSeconds: 0, reconnects: 0 };
  return {
    stalls: Math.min(BEAT_QUALITY_MAX.stalls, Math.max(0, Math.floor(t.stalls))),
    stallSeconds: Math.min(BEAT_QUALITY_MAX.stallSeconds, Math.max(0, Math.round(t.stallMs / 1000))),
    reconnects: Math.min(BEAT_QUALITY_MAX.reconnects, Math.max(0, Math.floor(t.reconnects))),
  };
}

/** Whole minutes since 1970 (UTC): the unit of the watching-over-time chart. */
export function epochMinute(date: Date): number {
  return Math.floor(date.getTime() / 60_000);
}

/**
 * The minutes a counted beat adds to the person's list. A counted beat covers the time since the
 * previous one (at most a minute, presence-watch.ts), so it touches the previous beat's minute and this
 * one's. Only minutes not already on the list are returned, so the list holds each minute once.
 */
export function minutesToMark(input: { counted: boolean; previousSeenAt: Date | null; now: Date; known: readonly number[] }): number[] {
  if (!input.counted) return [];
  const touched = new Set<number>([epochMinute(input.now)]);
  if (input.previousSeenAt) touched.add(epochMinute(input.previousSeenAt));
  const known = new Set(input.known);
  return [...touched].filter((m) => !known.has(m)).sort((a, b) => a - b);
}

/** A webinar runs hours, not days: a list spanning more than this is cut to its last day. */
export const TIMELINE_MAX_MINUTES = 24 * 60;

export interface TimelinePoint {
  /** The minute's start, as an ISO time. */
  at: string;
  watching: number;
}

/**
 * How many people were watching in each minute, from the first minute anyone watched to the last,
 * with the quiet minutes in between as 0 (a break, a dropped stream) so the chart shows them.
 */
export function watchingTimeline(rows: readonly { watchedMinutes: readonly number[] }[]): TimelinePoint[] {
  const counts = new Map<number, number>();
  for (const row of rows) {
    for (const m of new Set(row.watchedMinutes)) counts.set(m, (counts.get(m) ?? 0) + 1);
  }
  if (counts.size === 0) return [];
  const minutes = [...counts.keys()];
  const last = Math.max(...minutes);
  const first = Math.max(Math.min(...minutes), last - TIMELINE_MAX_MINUTES + 1);
  const points: TimelinePoint[] = [];
  for (let m = first; m <= last; m++) {
    points.push({ at: new Date(m * 60_000).toISOString(), watching: counts.get(m) ?? 0 });
  }
  return points;
}

export interface BreakdownEntry {
  label: string;
  count: number;
}

/** Counts per value, largest first; a missing value (a beat from before Nov 23, 2026) reads "Unknown". */
export function breakdown(values: readonly (string | null)[]): BreakdownEntry[] {
  const counts = new Map<string, number>();
  for (const v of values) {
    const label = v && v.trim() ? v : "Unknown";
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([label, count]) => ({ label, count }))
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
}

const DEVICE_LABELS: Record<string, string> = { mobile: "Phone", tablet: "Tablet", desktop: "Computer" };

export function deviceLabel(deviceType: string | null): string | null {
  if (!deviceType) return null;
  return DEVICE_LABELS[deviceType] ?? deviceType;
}

const VIEW_MODE_LABELS: Record<string, string> = { stream: "Our stream", zoom: "Zoom" };

export function viewModeLabel(viewMode: string | null): string | null {
  if (!viewMode) return null;
  return VIEW_MODE_LABELS[viewMode] ?? viewMode;
}
