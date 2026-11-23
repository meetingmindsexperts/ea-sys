/**
 * A webinar's post-event report (Nov 23, 2026): the rules in post-event-report.ts, the shared Zoom
 * attendance figures, the reads (with the database mocked) and the PDF (rendered for real).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  db: {
    eventSession: { findFirst: vi.fn() },
    registration: { groupBy: vi.fn(), count: vi.fn() },
    ticketType: { findMany: vi.fn() },
    webinarPresence: { groupBy: vi.fn(), findMany: vi.fn() },
    zoomAttendance: { findMany: vi.fn() },
    webinarViewerQuestion: { findMany: vi.fn() },
    webinarQuestion: { findMany: vi.fn() },
    surveyResponse: { findMany: vi.fn() },
  },
  surveys: { listSurveys: vi.fn(), resolveReportSurvey: vi.fn() },
}));
vi.mock("@/lib/db", () => ({ db: h.db }));
vi.mock("@/lib/logger", () => ({ apiLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock("@/services/survey-service", () => ({
  listSurveys: (...a: unknown[]) => h.surveys.listSurveys(...a),
  resolveReportSurvey: (...a: unknown[]) => h.surveys.resolveReportSurvey(...a),
  parseStoredSurveyConfig: (raw: unknown) => (Array.isArray(raw) ? raw : null),
}));

import {
  orderQuestions,
  peakOfTimeline,
  percentOf,
  QUESTION_LIST_MAX,
  reportDuration,
  reportText,
  TEXT_MAX_CHARS,
  type PostEventReport,
} from "@/lib/webinar/post-event-report";
import { zoomAttendanceFigures, computePeakConcurrent } from "@/lib/webinar/zoom-attendance-kpis";
import { loadPostEventReport } from "@/lib/webinar/post-event-report-server";
import { generatePostEventReportPdf } from "@/lib/webinar/post-event-report-pdf";
import { EXCLUDE_FACULTY_WHERE } from "@/lib/faculty-filter";

const at = (m: number) => new Date(Date.UTC(2026, 10, 20, 10, m));

describe("the report's rules", () => {
  it("shares, durations and the peak", () => {
    expect(percentOf(1, 3)).toBe(33);
    expect(percentOf(5, 0)).toBe(0);
    expect(reportDuration(45)).toBe("45s");
    expect(reportDuration(12 * 60)).toBe("12m");
    expect(reportDuration(3600 + 5 * 60)).toBe("1h 05m");
    expect(peakOfTimeline([{ at: "a", watching: 2 }, { at: "b", watching: 5 }, { at: "c", watching: 5 }])).toEqual({ peak: 5, peakAt: "b" });
    expect(peakOfTimeline([])).toEqual({ peak: 0, peakAt: null });
  });

  it("questions: most voted first, then oldest, never the asker, capped", () => {
    const rows = [
      { question: "late, popular", answered: false, votes: 3, source: "page" as const, askedAt: at(9), askerName: "X" },
      { question: "early", answered: true, votes: 0, source: "zoom" as const, askedAt: at(1), askerName: "Y" },
      { question: "late", answered: false, votes: 0, source: "page" as const, askedAt: at(5), askerName: "Z" },
    ];
    const ordered = orderQuestions(rows);
    expect(ordered.map((q) => q.question)).toEqual(["late, popular", "early", "late"]);
    expect(JSON.stringify(ordered)).not.toContain("askerName");
    const many = Array.from({ length: QUESTION_LIST_MAX + 5 }, (_, i) => ({ ...rows[2], askedAt: at(i) }));
    expect(orderQuestions(many)).toHaveLength(QUESTION_LIST_MAX);
  });

  it("Zoom's figures: one person per address, the peak by join and leave", () => {
    const rows = [
      { id: "1", email: "A@x.com", joinTime: at(0), leaveTime: at(30), durationSeconds: 1800 },
      { id: "2", email: "a@x.com", joinTime: at(40), leaveTime: at(50), durationSeconds: 600 },
      { id: "3", email: null, joinTime: at(10), leaveTime: at(45), durationSeconds: 2100 },
    ];
    expect(zoomAttendanceFigures(rows, 4)).toEqual({
      registered: 4,
      attended: 2,
      attendanceRate: 50,
      avgWatchSeconds: 1500,
      totalWatchSeconds: 4500,
      peakConcurrent: 2,
    });
    expect(computePeakConcurrent([])).toBe(0);
  });
});

const EVENT = {
  id: "ev1",
  name: "Webinar",
  timezone: "Asia/Dubai",
  settings: { webinar: { sessionId: "s1", viewingMode: "hls" } },
  surveyConfig: null,
  surveyIntroHtml: null,
  surveyThankYouHtml: null,
};

describe("the reads", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.db.eventSession.findFirst.mockResolvedValue({ startTime: at(0), endTime: at(60), status: "COMPLETED" });
    h.db.registration.groupBy.mockImplementation(async (args: { by: string[] }) =>
      args.by[0] === "status"
        ? [
            { status: "CONFIRMED", _count: { _all: 8 } },
            { status: "CHECKED_IN", _count: { _all: 2 } },
            { status: "PENDING", _count: { _all: 3 } },
            { status: "CANCELLED", _count: { _all: 4 } },
          ]
        : [{ ticketTypeId: "t1", _count: { _all: 13 } }],
    );
    h.db.ticketType.findMany.mockResolvedValue([{ id: "t1", name: "Delegate" }]);
    h.db.webinarPresence.groupBy.mockResolvedValue([{ phase: "joined", _count: { _all: 5 }, _sum: { watchedSeconds: 5 * 1800 } }]);
    h.db.webinarPresence.findMany.mockResolvedValue([
      { phase: "joined", deviceType: "mobile", browser: "Safari", os: "iOS", viewMode: "stream", stallCount: 0, stallSeconds: 0, reconnectCount: 0, watchedMinutes: [100, 101] },
      { phase: "joined", deviceType: "desktop", browser: "Chrome", os: "Windows", viewMode: "stream", stallCount: 0, stallSeconds: 0, reconnectCount: 0, watchedMinutes: [101] },
    ]);
    h.db.zoomAttendance.findMany.mockResolvedValue([]);
    h.db.webinarViewerQuestion.findMany.mockResolvedValue([
      { question: "Dose?", status: "ANSWERED", createdAt: at(10), _count: { votes: 2 } },
    ]);
    h.db.webinarQuestion.findMany.mockResolvedValue([{ question: "Zoom one", answer: null, askedAt: at(5) }]);
    h.surveys.listSurveys.mockResolvedValue([{ id: "sv1", responseCount: 2 }, { id: "sv2", responseCount: 0 }]);
    h.surveys.resolveReportSurvey.mockResolvedValue({
      survey: { id: "sv1", name: "CME survey" },
      rawConfig: [
        { id: "q1", type: "rating_1_to_5", label: "Overall" },
        { id: "q2", type: "single_select", label: "Useful?", options: ["Yes", "No"] },
        { id: "q3", type: "text", label: "Comments" },
      ],
      where: { surveyId: "sv1" },
    });
    h.db.surveyResponse.findMany.mockResolvedValue([
      { id: "r1", submittedAt: at(70), answers: { q1: 5, q2: "Yes", q3: "Great" } },
      { id: "r2", submittedAt: at(65), answers: { q1: 4, q2: "Maybe" } },
    ]);
  });

  it("counts delegates only (faculty excluded), confirmed as the attendance base, our page for a custom stream", async () => {
    const r = await loadPostEventReport(EVENT, { includeSurveys: true, includeComments: true });
    expect(h.db.registration.groupBy.mock.calls[0][0].where).toMatchObject({ eventId: "ev1", ...EXCLUDE_FACULTY_WHERE });
    expect(r.registrations).toEqual({ registered: 13, confirmed: 10, pending: 3, cancelled: 4, byType: [{ label: "Delegate", count: 13 }] });
    expect(r.attendance).toMatchObject({ source: "page", attended: 5, attendanceRate: 50, avgWatchSeconds: 1800, peak: 2 });
    expect(r.attendance.devices.map((d) => d.label)).toEqual(["Computer", "Phone"]);
    expect(h.db.zoomAttendance.findMany).not.toHaveBeenCalled();
    expect(r.event.status).toBe("ended");
  });

  it("a dismissed question is left out; Zoom's and our player's questions are both counted", async () => {
    const r = await loadPostEventReport(EVENT, { includeSurveys: false, includeComments: true });
    expect(h.db.webinarViewerQuestion.findMany.mock.calls[0][0].where).toMatchObject({ status: { not: "DISMISSED" } });
    expect(r.questions).toMatchObject({ asked: 2, answered: 1 });
    expect(r.questions.items[0]).toEqual({ question: "Dose?", answered: true, votes: 2, source: "page" });
  });

  it("surveys: only those answered, options in the survey's order with renamed answers kept, comments without ids", async () => {
    const r = await loadPostEventReport(EVENT, { includeSurveys: true, includeComments: true });
    expect(h.surveys.resolveReportSurvey).toHaveBeenCalledTimes(1);
    const s = r.surveys?.[0];
    expect(s).toMatchObject({ name: "CME survey", responses: 2 });
    expect(s?.questions[0]).toMatchObject({ type: "rating", mean: 4.5 });
    expect(s?.questions[1]).toEqual({
      type: "choice",
      label: "Useful?",
      count: 2,
      options: [
        { label: "Yes", count: 1 },
        { label: "No", count: 0 },
        { label: "Maybe", count: 1 },
      ],
    });
    expect(s?.questions[2]).toEqual({ type: "text", label: "Comments", count: 1, comments: ["Great"] });
  });

  it("no survey results for a caller who may not read them", async () => {
    const r = await loadPostEventReport(EVENT, { includeSurveys: false, includeComments: true });
    expect(r.surveys).toBeNull();
    expect(h.surveys.listSurveys).not.toHaveBeenCalled();
  });

  it("a webinar run on Zoom counts Zoom's report", async () => {
    h.db.zoomAttendance.findMany.mockResolvedValue([
      { id: "1", email: "a@x.com", joinTime: at(0), leaveTime: at(30), durationSeconds: 1800 },
    ]);
    const r = await loadPostEventReport({ ...EVENT, settings: { webinar: { sessionId: "s1", viewingMode: "embed" } } }, { includeSurveys: false, includeComments: true });
    expect(r.attendance).toMatchObject({ source: "zoom", attended: 1, attendanceRate: 10, devices: [] });
    expect(h.db.webinarPresence.findMany).not.toHaveBeenCalled();
  });

  it("page attendance leaves faculty out; votes leave out cancelled registrations", async () => {
    await loadPostEventReport(EVENT, { includeSurveys: false, includeComments: true });
    expect(h.db.webinarPresence.groupBy.mock.calls[0][0].where).toMatchObject({ registration: EXCLUDE_FACULTY_WHERE });
    expect(h.db.webinarViewerQuestion.findMany.mock.calls[0][0].select._count).toEqual({
      select: { votes: { where: { registration: { status: { not: "CANCELLED" } } } } },
    });
  });

  it("more than 90 days after the webinar: the joined marker counts attendance, and says the rest is archived", async () => {
    h.db.eventSession.findFirst.mockResolvedValue({ startTime: new Date("2026-01-01T10:00:00Z"), endTime: new Date("2026-01-01T11:00:00Z"), status: "COMPLETED" });
    h.db.registration.count.mockResolvedValue(7);
    const r = await loadPostEventReport(EVENT, { includeSurveys: false, includeComments: true });
    expect(r.attendance).toMatchObject({ source: "page", attended: 7, archived: true, avgWatchSeconds: 0, devices: [] });
    expect(h.db.registration.count.mock.calls[0][0].where).toMatchObject({ webinarFirstJoinedAt: { not: null }, ...EXCLUDE_FACULTY_WHERE });
    expect(h.db.webinarPresence.findMany).not.toHaveBeenCalled();
  });

  it("comments left out when not asked for, and cleaned when they are", async () => {
    h.db.surveyResponse.findMany.mockResolvedValue([{ id: "r1", submittedAt: at(70), answers: { q3: "call 0501234567" } }]);
    const without = await loadPostEventReport(EVENT, { includeSurveys: true, includeComments: false });
    expect(without.commentsIncluded).toBe(false);
    expect(without.surveys?.[0].questions[2]).toMatchObject({ type: "text", count: 1, comments: [] });
    const withComments = await loadPostEventReport(EVENT, { includeSurveys: true, includeComments: true });
    expect(withComments.surveys?.[0].questions[2]).toMatchObject({ comments: ["call [number removed]"] });
  });

  it("Zoom's average is per person, not per join", async () => {
    h.db.zoomAttendance.findMany.mockResolvedValue([
      { id: "1", email: "a@x.com", joinTime: at(0), leaveTime: at(10), durationSeconds: 600 },
      { id: "2", email: "a@x.com", joinTime: at(20), leaveTime: at(30), durationSeconds: 600 },
    ]);
    const r = await loadPostEventReport({ ...EVENT, settings: { webinar: { sessionId: "s1", viewingMode: "embed" } } }, { includeSurveys: false, includeComments: true });
    expect(r.attendance).toMatchObject({ attended: 1, avgWatchSeconds: 1200 });
  });
});


describe("review of cdec0c859", () => {
  it("typed text loses email addresses and phone or licence numbers, keeps short figures, and is cut", () => {
    expect(reportText("Mail me at dr.ali@clinic.ae or +971 50 123 4567")).toBe("Mail me at [email removed] or [number removed]");
    expect(reportText("Licence 12345678, 2 doses in 2026")).toBe("Licence [number removed], 2 doses in 2026");
    expect(reportText("x".repeat(TEXT_MAX_CHARS + 50))).toHaveLength(TEXT_MAX_CHARS);
  });
});

describe("the PDF", () => {
  it("renders, typed text the font cannot draw included", async () => {
    const report: PostEventReport = {
      generatedAt: at(90).toISOString(),
      event: { id: "ev1", name: "Improving Outcomes in β-Thalassemia", timezone: "Asia/Dubai", startTime: at(0).toISOString(), endTime: at(60).toISOString(), status: "ended" },
      registrations: { registered: 13, confirmed: 10, pending: 3, cancelled: 4, byType: [{ label: "Delegate", count: 13 }] },
      attendance: { source: "page", attended: 5, attendanceRate: 50, avgWatchSeconds: 1800, totalWatchSeconds: 9000, peak: 4, peakAt: at(20).toISOString(), devices: [{ label: "Phone", count: 3 }], archived: false },
      questions: { asked: 1, answered: 1, items: [{ question: "ما الجرعة؟ 💊", answered: true, votes: 2, source: "page" }] },
      surveys: [
        {
          name: "CME survey",
          responses: 2,
          questions: [
            { type: "rating", label: "Overall", count: 2, mean: 4.5, distribution: [0, 0, 0, 1, 1] },
            { type: "choice", label: "Useful?", count: 2, options: [{ label: "Yes", count: 2 }] },
            { type: "text", label: "Comments", count: 1, comments: ["“Great” session"] },
          ],
        },
      ],
      commentsIncluded: true,
    };
    const pdf = await generatePostEventReportPdf(report, {
      name: "MM Group",
      companyName: null,
      address: null,
      city: null,
      zipCode: null,
      country: null,
      logoPath: null,
    });
    expect(pdf.subarray(0, 5).toString()).toBe("%PDF-");
    expect(pdf.length).toBeGreaterThan(2_000);
  });
});
