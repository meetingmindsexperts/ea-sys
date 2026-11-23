/**
 * The post-event report of a webinar (Nov 23, 2026; owner: "a consolidated post event report which
 * includes attendee count, registrations, Q&A and survey results"). One report, two outputs: the page
 * at /events/[id]/analytics/report and its PDF, both drawn from this shape, so they never disagree.
 *
 * Written to be forwarded to a client or a sponsor (owner's choice): counts, shares and survey answers
 * only. It carries no attendee's name or email, no asker's name on a question, and survey comments
 * without who wrote them. A comment is the respondent's own text, so it can name someone; that is the
 * one personal detail it can hold, and the page says so.
 *
 * Client-safe: the page imports the types and the small rules here; the reads are in
 * post-event-report-server.ts.
 */

export interface ReportBreakdown {
  label: string;
  count: number;
}

export interface PostEventReport {
  generatedAt: string;
  event: {
    id: string;
    name: string;
    timezone: string;
    /** The webinar's own session, when it has one. */
    startTime: string | null;
    endTime: string | null;
    /** "ended" once the webinar is over; otherwise the figures are so far. */
    status: "scheduled" | "live" | "ended";
  };
  registrations: {
    /** Registrations not cancelled. Faculty (speakers' own registrations) are not delegates. */
    registered: number;
    /** Confirmed or checked in: the people expected to attend. */
    confirmed: number;
    pending: number;
    cancelled: number;
    byType: ReportBreakdown[];
  };
  attendance: {
    /** Where the count comes from: our own page (custom stream, partner) or Zoom's report. */
    source: "page" | "zoom";
    attended: number;
    /** Share of the confirmed registrations, 0 to 100. */
    attendanceRate: number;
    avgWatchSeconds: number;
    totalWatchSeconds: number;
    /** The most people watching at once, and when (page: per minute; Zoom: per join and leave). */
    peak: number;
    peakAt: string | null;
    /** Page only: phone, tablet, computer. Empty for Zoom. */
    devices: ReportBreakdown[];
  };
  questions: {
    asked: number;
    answered: number;
    /** Most voted first, then oldest first; no asker. Capped at QUESTION_LIST_MAX. */
    items: ReportQuestion[];
  };
  /** Null when the caller may not read survey results (surveys.read). */
  surveys: ReportSurvey[] | null;
}

export interface ReportQuestion {
  question: string;
  answered: boolean;
  votes: number;
  /** "page": asked on our player; "zoom": asked in Zoom's Q&A. */
  source: "page" | "zoom";
}

export type ReportSurveyQuestion =
  | { type: "rating"; label: string; count: number; mean: number | null; distribution: number[] }
  | { type: "choice"; label: string; count: number; options: ReportBreakdown[] }
  | { type: "text"; label: string; count: number; comments: string[] };

export interface ReportSurvey {
  name: string;
  responses: number;
  questions: ReportSurveyQuestion[];
}

/** A report lists this many questions; the rest are counted, not listed. */
export const QUESTION_LIST_MAX = 200;
/** A text question lists this many comments, the newest first. */
export const COMMENTS_PER_QUESTION_MAX = 50;

/** The share of `part` in `whole`, 0 to 100, rounded; 0 when there is nothing to share. */
export function percentOf(part: number, whole: number): number {
  return whole > 0 ? Math.round((part / whole) * 100) : 0;
}

/** The questions in report order: most voted, then oldest; capped. */
export function orderQuestions<T extends ReportQuestion & { askedAt: Date }>(rows: readonly T[]): ReportQuestion[] {
  return [...rows]
    .sort((a, b) => b.votes - a.votes || a.askedAt.getTime() - b.askedAt.getTime())
    .slice(0, QUESTION_LIST_MAX)
    .map(({ question, answered, votes, source }) => ({ question, answered, votes, source }));
}

/** The most watching at once on our page, from the per-minute chart. */
export function peakOfTimeline(points: readonly { at: string; watching: number }[]): { peak: number; peakAt: string | null } {
  let best: { at: string; watching: number } | null = null;
  for (const p of points) {
    if (best === null || p.watching > best.watching) best = p;
  }
  return { peak: best?.watching ?? 0, peakAt: best && best.watching > 0 ? best.at : null };
}

/** Seconds as "1h 05m", "12m", "45s": the report's one duration format. */
export function reportDuration(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (h === 0) return `${m}m`;
  return `${h}h ${String(m).padStart(2, "0")}m`;
}
