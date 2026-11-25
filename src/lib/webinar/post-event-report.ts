/**
 * The post-event report of a webinar (Nov 23, 2026; owner: "a consolidated post event report which
 * includes attendee count, registrations, Q&A and survey results"). One report, four outputs: the page
 * at /events/[id]/analytics/report and its PDF, Word and CSV files (Nov 25, 2026), all drawn from this
 * shape and from the same words (post-event-report-text.ts), so they never disagree.
 *
 * Written to be forwarded to a client or a sponsor (owner's choice): counts, shares and survey answers
 * only. It carries no attendee's name or email, no asker's name on a question, and survey comments
 * without who wrote them. Typed text (a question, a comment) is the person's own words and can name
 * someone, so (review of cdec0c859): every email address and phone number in it is removed, each is
 * cut to TEXT_MAX_CHARS, the page asks before comments go into a download, and the console's download,
 * which shows no such warning, leaves comments out.
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
    /**
     * Page only: the minute-by-minute record is archived 90 days after the webinar
     * (webinar-presence-archive), so "attended" is then the people marked as having joined, and the
     * minutes, the peak and the devices are no longer known.
     */
    archived: boolean;
  };
  questions: {
    asked: number;
    answered: number;
    /** Most voted first, then oldest first; no asker. Capped at QUESTION_LIST_MAX. */
    items: ReportQuestion[];
  };
  /** Null when the caller may not read survey results (surveys.read). */
  surveys: ReportSurvey[] | null;
  /** False when the survey comments were left out (the console's PDF, or the box unticked). */
  commentsIncluded: boolean;
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
/** A question or a comment is cut to this many characters (a survey answer can hold 10,000). */
export const TEXT_MAX_CHARS = 1_000;

const EMAIL = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
// Seven or more digits with the spaces, dots, dashes and brackets phone numbers are written with.
const PHONE = /\+?\d[\d\s().-]{5,}\d/g;

/**
 * Typed text as the report shows it: email addresses and phone-like numbers removed, whitespace
 * folded to single spaces, cut to TEXT_MAX_CHARS. A licence or registration number typed into a comment is caught as a long number
 * too; a short figure ("2 doses", "in 2026") is left alone.
 */
export function reportText(text: string): string {
  const cleaned = text
    .replace(EMAIL, "[email removed]")
    .replace(PHONE, (m) => (m.replace(/\D/g, "").length >= 7 ? "[number removed]" : m))
    // Line breaks and runs of spaces become one space, as the page shows them: a question typed with
    // ten blank lines ran down the PDF page as stray letters.
    .replace(/\s+/g, " ")
    .trim();
  return cleaned.length > TEXT_MAX_CHARS ? `${cleaned.slice(0, TEXT_MAX_CHARS - 1)}…` : cleaned;
}

/** The share of `part` in `whole`, 0 to 100, rounded; 0 when there is nothing to share. */
export function percentOf(part: number, whole: number): number {
  return whole > 0 ? Math.round((part / whole) * 100) : 0;
}

/** The questions in report order: most voted, then oldest; capped. */
export function orderQuestions<T extends ReportQuestion & { askedAt: Date }>(rows: readonly T[]): ReportQuestion[] {
  return [...rows]
    .sort((a, b) => b.votes - a.votes || a.askedAt.getTime() - b.askedAt.getTime())
    .slice(0, QUESTION_LIST_MAX)
    .map(({ question, answered, votes, source }) => ({ question: reportText(question), answered, votes, source }));
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
