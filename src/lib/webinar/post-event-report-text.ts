/**
 * The post-event report's words, shared by its three files (Nov 25, 2026): the PDF, the Word copy an
 * organiser edits before forwarding it, and the CSV for the numbers. One place, so the three never
 * say different things. Client-safe (pure strings over the report's shape).
 */
import { formatDateTimeInTz } from "@/lib/event-time";
import { reportDuration, type PostEventReport, type ReportBreakdown, type ReportQuestion, type ReportSurvey } from "./post-event-report";

export const REPORT_DOCUMENT_TITLE = "Post-event report";

export const NOT_ENDED_NOTE = "The webinar has not ended yet: these figures are so far.";

export const PRIVACY_NOTE =
  "No attendee is named. Questions and comments are attendees' own words, with email addresses and phone numbers removed.";

export const ARCHIVED_NOTE =
  "This webinar is more than 90 days old: the minute-by-minute record has been archived, so the time watched, the peak and the devices are not shown.";

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** "Webinar: 24 Nov 2026, 20:00 (Asia/Dubai)   ·   Report made ..." */
export function reportWhenLine(r: PostEventReport): string {
  const tz = r.event.timezone;
  const parts: string[] = [];
  if (r.event.startTime) parts.push(`Webinar: ${formatDateTimeInTz(new Date(r.event.startTime), tz)} (${tz})`);
  parts.push(`Report made ${formatDateTimeInTz(new Date(r.generatedAt), tz)}`);
  return parts.join("   ·   ");
}

export function glanceTiles(r: PostEventReport): { label: string; value: string }[] {
  return [
    { label: "Registered", value: String(r.registrations.registered) },
    { label: "Attended", value: `${r.attendance.attended} (${r.attendance.attendanceRate}%)` },
    { label: "Average watched", value: reportDuration(r.attendance.avgWatchSeconds) },
    { label: "Most watching at once", value: String(r.attendance.peak) },
    { label: "Questions asked", value: String(r.questions.asked) },
  ];
}

export function registrationsLine(r: PostEventReport): string {
  const g = r.registrations;
  return `${g.registered} registered: ${g.confirmed} confirmed, ${g.pending} pending. ${g.cancelled} cancelled (not counted).`;
}

export function attendanceSourceLine(r: PostEventReport): string {
  return r.attendance.source === "page"
    ? "Counted on the webinar page: people who reached the live view, and the minutes they watched while it was open."
    : "From Zoom's participant report.";
}

export function attendanceLine(r: PostEventReport): string {
  const a = r.attendance;
  const watched = a.archived ? "" : ` Average watched ${reportDuration(a.avgWatchSeconds)}, ${reportDuration(a.totalWatchSeconds)} in all.`;
  return `${a.attended} attended, ${a.attendanceRate}% of the ${r.registrations.confirmed} confirmed registrations.${watched} ${attendanceSourceLine(r)}`;
}

export function questionsLine(r: PostEventReport): string {
  return r.questions.asked === 0 ? "No questions were asked." : `${r.questions.asked} asked, ${r.questions.answered} answered.`;
}

/** "answered, 3 votes", or "" for an unanswered question nobody voted for. */
export function questionTags(q: ReportQuestion): string {
  return [q.answered ? "answered" : null, q.votes > 0 ? plural(q.votes, "vote") : null].filter(Boolean).join(", ");
}

/** Said under the list when more were asked than it shows. */
export function questionsListedNote(r: PostEventReport): string | null {
  return r.questions.items.length < r.questions.asked ? `The first ${r.questions.items.length} are listed.` : null;
}

export function surveyHeading(s: ReportSurvey): string {
  return `${s.name}: ${plural(s.responses, "response")}`;
}

/** A rating question's rows, five stars first. */
export function ratingRows(distribution: readonly number[]): ReportBreakdown[] {
  return [5, 4, 3, 2, 1].map((stars) => ({ label: plural(stars, "star"), count: distribution[stars - 1] ?? 0 }));
}

export function ratingLine(mean: number | null, count: number): string {
  return `Average ${mean === null ? "no answers" : `${mean.toFixed(1)} out of 5`} (${plural(count, "answer")})`;
}

export function commentsLeftOutLine(count: number): string {
  return `${plural(count, "comment")}, left out of this copy.`;
}

/** Said under the comments when only the newest are shown. */
export function commentsShownNote(shown: number, count: number): string | null {
  return shown < count ? `The newest ${shown} of ${count} comments.` : null;
}
