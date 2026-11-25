/**
 * The post-event report as a CSV (Nov 25, 2026), for working with the numbers in a spreadsheet. The
 * report's sections are different shapes, so it is one long table with the same five columns
 * throughout (Section, Item, Answer, Count, Share), which sorts and filters in Excel without a
 * second header row in the middle. Same report and same rules as the PDF (no attendee named,
 * comments only when asked); every cell goes through escapeCsvCell, since questions and comments are
 * typed by attendees and a leading "=" must never run as a formula. Times watched are in minutes,
 * so they add up. Starts with a byte order mark so Excel reads Arabic and accents. Client-safe.
 */
import { toCsv } from "@/lib/csv-escape";
import { formatDateTimeInTz } from "@/lib/event-time";
import { percentOf, type PostEventReport, type ReportBreakdown, type ReportSurvey } from "./post-event-report";
import { ARCHIVED_NOTE, attendanceSourceLine, NOT_ENDED_NOTE, PRIVACY_NOTE, questionsListedNote, ratingRows, commentsShownNote, commentsLeftOutLine } from "./post-event-report-text";

export const POST_EVENT_REPORT_CSV_HEADER = ["Section", "Item", "Answer", "Count", "Share (%)"] as const;

type Row = [section: string, item: string, answer: string, count: number | string, share: number | string];

const BOM = "﻿";
const STATUS_WORD = { scheduled: "Not started", live: "Live", ended: "Ended" } as const;

const minutes = (seconds: number) => Math.round(seconds / 6) / 10;

function breakdownRows(section: string, item: (b: ReportBreakdown) => [string, string], rows: readonly ReportBreakdown[], total: number): Row[] {
  return rows.map((b) => [section, ...item(b), b.count, percentOf(b.count, total)]);
}

function reportRows(r: PostEventReport): Row[] {
  const tz = r.event.timezone;
  const rows: Row[] = [["Report", "Webinar", r.event.name, "", ""]];
  if (r.event.startTime) rows.push(["Report", "Starts", `${formatDateTimeInTz(new Date(r.event.startTime), tz)} (${tz})`, "", ""]);
  rows.push(["Report", "Report made", formatDateTimeInTz(new Date(r.generatedAt), tz), "", ""]);
  rows.push(["Report", "Status", STATUS_WORD[r.event.status], "", ""]);
  if (r.event.status !== "ended") rows.push(["Report", "Note", NOT_ENDED_NOTE, "", ""]);
  rows.push(["Report", "Note", PRIVACY_NOTE, "", ""]);
  return rows;
}

function registrationRows(r: PostEventReport): Row[] {
  const g = r.registrations;
  return [
    ["Registrations", "Registered", "", g.registered, ""],
    ["Registrations", "Confirmed", "", g.confirmed, ""],
    ["Registrations", "Pending", "", g.pending, ""],
    ["Registrations", "Cancelled (not counted)", "", g.cancelled, ""],
    ...breakdownRows("Registrations by type", (b) => [b.label, ""], g.byType, g.registered),
  ];
}

function attendanceRows(r: PostEventReport): Row[] {
  const a = r.attendance;
  const rows: Row[] = [
    ["Attendance", "Attended (share of confirmed registrations)", "", a.attended, a.attendanceRate],
    ["Attendance", "Counted from", attendanceSourceLine(r), "", ""],
  ];
  if (a.archived) return [...rows, ["Attendance", "Note", ARCHIVED_NOTE, "", ""]];
  rows.push(
    ["Attendance", "Average watched (minutes)", "", minutes(a.avgWatchSeconds), ""],
    ["Attendance", "Total watched (minutes)", "", minutes(a.totalWatchSeconds), ""],
    ["Attendance", "Most watching at once", a.peakAt ? formatDateTimeInTz(new Date(a.peakAt), r.event.timezone) : "", a.peak, ""],
  );
  return [...rows, ...breakdownRows("Watched on", (b) => [b.label, ""], a.devices, a.attended)];
}

function questionRows(r: PostEventReport): Row[] {
  const q = r.questions;
  const rows: Row[] = [
    ["Questions", "Asked", "", q.asked, ""],
    ["Questions", "Answered", "", q.answered, ""],
  ];
  // The count of a question is its votes.
  for (const item of q.items) {
    const where = item.source === "zoom" ? ", asked in Zoom" : "";
    rows.push(["Question (count is votes)", item.question, `${item.answered ? "Answered" : "Not answered"}${where}`, item.votes, ""]);
  }
  const listed = questionsListedNote(r);
  if (listed) rows.push(["Questions", "Note", listed, "", ""]);
  return rows;
}

function surveyRows(s: ReportSurvey, commentsIncluded: boolean): Row[] {
  const section = `Survey: ${s.name}`;
  const rows: Row[] = [[section, "Responses", "", s.responses, ""]];
  for (const q of s.questions) {
    if (q.type === "rating") {
      rows.push([section, q.label, "Average (out of 5)", q.mean === null ? "" : Number(q.mean.toFixed(1)), ""]);
      rows.push(...breakdownRows(section, (b) => [q.label, b.label], ratingRows(q.distribution), q.count));
    } else if (q.type === "choice") {
      rows.push(...breakdownRows(section, (b) => [q.label, b.label], q.options, q.count));
    } else if (!commentsIncluded) {
      rows.push([section, q.label, commentsLeftOutLine(q.count), q.count, ""]);
    } else {
      rows.push(...q.comments.map((c): Row => [section, q.label, c, "", ""]));
      const shown = commentsShownNote(q.comments.length, q.count);
      if (shown) rows.push([section, q.label, shown, q.count, ""]);
    }
  }
  return rows;
}

export function postEventReportCsv(r: PostEventReport): string {
  const rows: (readonly (string | number)[])[] = [
    POST_EVENT_REPORT_CSV_HEADER,
    ...reportRows(r),
    ...registrationRows(r),
    ...attendanceRows(r),
    ...questionRows(r),
    ...(r.surveys ?? []).flatMap((s) => surveyRows(s, r.commentsIncluded)),
  ];
  return BOM + toCsv(rows, "\r\n") + "\r\n";
}
