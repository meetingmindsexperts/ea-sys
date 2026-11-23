/**
 * The reads behind the post-event report (post-event-report.ts holds the shape and the rules). Called
 * by GET /api/events/[eventId]/webinar/post-event-report inside the caller's tenant lane, after the
 * route has found the event through its gate. Every figure comes from the rule that already decides
 * it elsewhere: the console's which-report-applies (partner or custom stream: our page; otherwise
 * Zoom), the page attendance summary and watch analytics, Zoom's attendance figures, the survey
 * service's scoping and aggregation.
 */
import { db } from "@/lib/db";
import { EXCLUDE_FACULTY_WHERE } from "@/lib/faculty-filter";
import { readWebinarSettings } from "@/lib/webinar";
import { webinarVideoSource } from "@/lib/webinar/video-source";
import { webinarStatusFromTimes } from "@/lib/webinar/console-rules";
import { presenceSummaryFromGroups, watchAnalytics } from "@/lib/webinar/presence-report";
import { zoomAttendanceFigures } from "@/lib/webinar/zoom-attendance-kpis";
import { aggregateSurvey, type QuestionAggregate } from "@/lib/survey/aggregate";
import type { SurveyAnswerValue } from "@/lib/survey/schema";
import {
  listSurveys,
  parseStoredSurveyConfig,
  resolveReportSurvey,
  type EventSurveyColumns,
} from "@/services/survey-service";
import { resolveTimezone } from "@/lib/event-time";
import {
  COMMENTS_PER_QUESTION_MAX,
  orderQuestions,
  peakOfTimeline,
  percentOf,
  type PostEventReport,
  type ReportBreakdown,
  type ReportSurvey,
  type ReportSurveyQuestion,
} from "@/lib/webinar/post-event-report";

/** One report reads at most this many presence rows, as the attendance report does. */
const REPORT_MAX_ROWS = 20_000;

export interface ReportEvent extends EventSurveyColumns {
  id: string;
  name: string;
  timezone: string | null;
  settings: unknown;
}

export async function loadPostEventReport(event: ReportEvent, opts: { includeSurveys: boolean }): Promise<PostEventReport> {
  const webinar = readWebinarSettings(event.settings);
  const sessionId = webinar?.sessionId ?? null;
  const ourPage = webinarVideoSource(event.settings) === "external" || webinar?.viewingMode === "hls";

  const [session, registrations, attendance, questions, surveys] = await Promise.all([
    sessionId
      ? db.eventSession.findFirst({ where: { id: sessionId, eventId: event.id }, select: { startTime: true, endTime: true, status: true } })
      : Promise.resolve(null),
    loadRegistrations(event.id),
    loadAttendance(event.id, sessionId, ourPage),
    loadQuestions(event.id, sessionId),
    opts.includeSurveys ? loadSurveys(event) : Promise.resolve(null),
  ]);

  const confirmed = registrations.confirmed;
  return {
    generatedAt: new Date().toISOString(),
    event: {
      id: event.id,
      name: event.name,
      timezone: resolveTimezone(event.timezone),
      startTime: session?.startTime.toISOString() ?? null,
      endTime: session?.endTime.toISOString() ?? null,
      status: webinarStatusFromTimes(session?.startTime.toISOString(), session?.endTime.toISOString(), session?.status),
    },
    registrations,
    attendance: { ...attendance, attendanceRate: percentOf(attendance.attended, confirmed) },
    questions,
    surveys,
  };
}

async function loadRegistrations(eventId: string): Promise<PostEventReport["registrations"]> {
  const where = { eventId, ...EXCLUDE_FACULTY_WHERE };
  const [byStatus, byType] = await Promise.all([
    db.registration.groupBy({ by: ["status"], where, _count: { _all: true } }),
    db.registration.groupBy({ by: ["ticketTypeId"], where: { ...where, status: { not: "CANCELLED" } }, _count: { _all: true } }),
  ]);
  const count = (statuses: string[]) =>
    byStatus.filter((g) => statuses.includes(g.status)).reduce((n, g) => n + g._count._all, 0);
  const typeIds = byType.map((g) => g.ticketTypeId).filter((id): id is string => Boolean(id));
  const types = typeIds.length
    ? await db.ticketType.findMany({ where: { id: { in: typeIds }, eventId }, select: { id: true, name: true } })
    : [];
  const names = new Map(types.map((t) => [t.id, t.name]));
  const typeRows: ReportBreakdown[] = byType
    .map((g) => ({ label: (g.ticketTypeId && names.get(g.ticketTypeId)) || "No registration type", count: g._count._all }))
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
  return {
    registered: byStatus.reduce((n, g) => n + g._count._all, 0) - count(["CANCELLED"]),
    confirmed: count(["CONFIRMED", "CHECKED_IN"]),
    pending: count(["PENDING", "WAITLISTED"]),
    cancelled: count(["CANCELLED"]),
    byType: typeRows,
  };
}

type AttendanceWithoutRate = Omit<PostEventReport["attendance"], "attendanceRate">;

async function loadAttendance(eventId: string, sessionId: string | null, ourPage: boolean): Promise<AttendanceWithoutRate> {
  const empty: AttendanceWithoutRate = {
    source: ourPage ? "page" : "zoom",
    attended: 0,
    avgWatchSeconds: 0,
    totalWatchSeconds: 0,
    peak: 0,
    peakAt: null,
    devices: [],
  };
  if (!sessionId) return empty;
  return ourPage ? pageAttendance(eventId, sessionId) : zoomAttendance(eventId, sessionId);
}

async function pageAttendance(eventId: string, sessionId: string): Promise<AttendanceWithoutRate> {
  const where = { sessionId, eventId };
  const [groups, watched] = await Promise.all([
    db.webinarPresence.groupBy({ by: ["phase"], where, _count: { _all: true }, _sum: { watchedSeconds: true } }),
    db.webinarPresence.findMany({
      where: { ...where, phase: "joined" },
      select: {
        phase: true,
        deviceType: true,
        browser: true,
        os: true,
        viewMode: true,
        stallCount: true,
        stallSeconds: true,
        reconnectCount: true,
        watchedMinutes: true,
      },
      take: REPORT_MAX_ROWS,
    }),
  ]);
  const summary = presenceSummaryFromGroups(groups);
  const analytics = watchAnalytics(watched);
  return {
    source: "page",
    attended: summary.joined,
    avgWatchSeconds: summary.avgWatchedSeconds,
    totalWatchSeconds: summary.totalWatchedSeconds,
    ...peakOfTimeline(analytics.timeline),
    devices: analytics.devices,
  };
}

async function zoomAttendance(eventId: string, sessionId: string): Promise<AttendanceWithoutRate> {
  const rows = await db.zoomAttendance.findMany({
    where: { eventId, sessionId },
    select: { id: true, email: true, joinTime: true, leaveTime: true, durationSeconds: true },
    take: REPORT_MAX_ROWS,
  });
  // The rate is taken against the same confirmed count as the rest of the report, so the registered
  // figure passed here is not used.
  const figures = zoomAttendanceFigures(rows, 0);
  return {
    source: "zoom",
    attended: figures.attended,
    avgWatchSeconds: figures.avgWatchSeconds,
    totalWatchSeconds: figures.totalWatchSeconds,
    peak: figures.peakConcurrent,
    peakAt: null,
    devices: [],
  };
}

async function loadQuestions(eventId: string, sessionId: string | null): Promise<PostEventReport["questions"]> {
  if (!sessionId) return { asked: 0, answered: 0, items: [] };
  const [viewer, zoom] = await Promise.all([
    // A dismissed question is the moderator's no (spam, a duplicate): not part of the report.
    db.webinarViewerQuestion.findMany({
      where: { eventId, sessionId, status: { not: "DISMISSED" } },
      select: { question: true, status: true, createdAt: true, _count: { select: { votes: true } } },
      take: REPORT_MAX_ROWS,
    }),
    db.webinarQuestion.findMany({
      where: { zoomMeeting: { sessionId, eventId } },
      select: { question: true, answer: true, askedAt: true },
      take: REPORT_MAX_ROWS,
    }),
  ]);
  const rows = [
    ...viewer.map((q) => ({
      question: q.question,
      answered: q.status === "ANSWERED",
      votes: q._count.votes,
      source: "page" as const,
      askedAt: q.createdAt,
    })),
    ...zoom.map((q) => ({
      question: q.question,
      answered: Boolean(q.answer && q.answer.trim()),
      votes: 0,
      source: "zoom" as const,
      askedAt: q.askedAt,
    })),
  ];
  return { asked: rows.length, answered: rows.filter((r) => r.answered).length, items: orderQuestions(rows) };
}

async function loadSurveys(event: ReportEvent): Promise<ReportSurvey[]> {
  const listed = await listSurveys(event.id, event);
  // An event from before several surveys (no Survey rows) still has its one survey on the event.
  const ids: (string | undefined)[] = listed.length ? listed.filter((s) => s.responseCount > 0).map((s) => s.id) : [undefined];
  const out: ReportSurvey[] = [];
  for (const surveyId of ids) {
    const report = await resolveReportSurvey(event, surveyId);
    if (!report) continue;
    const responses = await db.surveyResponse.findMany({
      where: report.where,
      orderBy: { submittedAt: "desc" },
      select: { id: true, submittedAt: true, answers: true },
      take: REPORT_MAX_ROWS,
    });
    if (responses.length === 0) continue;
    const config = parseStoredSurveyConfig(report.rawConfig, { eventId: event.id, surveyId: report.survey?.id }) ?? [];
    const aggregates = aggregateSurvey(
      config,
      responses.map((r) => ({ id: r.id, submittedAt: r.submittedAt, answers: (r.answers ?? {}) as Record<string, SurveyAnswerValue> })),
    );
    out.push({ name: report.survey?.name ?? "Survey", responses: responses.length, questions: aggregates.map(reportQuestion) });
  }
  return out;
}

/** A survey question for the report: no response ids, comments newest first and capped. */
function reportQuestion(a: QuestionAggregate): ReportSurveyQuestion {
  if (a.type === "rating_1_to_5") {
    return { type: "rating", label: a.label, count: a.count, mean: a.mean, distribution: [...a.distribution] };
  }
  if (a.type === "single_select") {
    // The survey's own option order (a scale reads in order), then answers to an option renamed or
    // removed while the survey was open, so the options add up to the answers.
    const options = [...Object.entries(a.counts), ...Object.entries(a.orphaned)].map(([label, count]) => ({ label, count }));
    return { type: "choice", label: a.label, count: a.count, options };
  }
  const comments = [...a.responses]
    .sort((x, y) => y.submittedAt.getTime() - x.submittedAt.getTime())
    .slice(0, COMMENTS_PER_QUESTION_MAX)
    .map((r) => r.value);
  return { type: "text", label: a.label, count: a.count, comments };
}
