/**
 * The end-of-webinar survey route (step 4 of several surveys, Oct 6, 2026):
 * the signed-in registrant of the webinar, the room session only, and the one
 * shared submit, so an extra survey never marks CME completion and the CME
 * survey behaves exactly as through its personal link.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockAuth, mockDb } = vi.hoisted(() => ({
  mockAuth: vi.fn(),
  mockDb: {
    event: { findFirst: vi.fn() },
    registration: { findFirst: vi.fn(), update: vi.fn() },
    attendee: { update: vi.fn() },
    survey: { findFirst: vi.fn(), create: vi.fn() },
    surveyResponse: { count: vi.fn(), create: vi.fn() },
    verificationToken: { delete: vi.fn() },
    eventSession: { findFirst: vi.fn() },
    $queryRaw: vi.fn(),
  },
}));

vi.mock("next/server", () => ({
  NextResponse: {
    json: (body: unknown, init?: { status?: number }) => ({ status: init?.status ?? 200, json: async () => body }),
  },
}));
vi.mock("@/lib/auth", () => ({ auth: mockAuth }));
vi.mock("@/lib/db", () => ({ db: mockDb, tenantTransaction: (fn: (tx: typeof mockDb) => unknown) => fn(mockDb) }));
vi.mock("@/lib/logger", () => ({ apiLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock("@/lib/public-event", () => ({ publicEventWhere: vi.fn(async () => ({})) }));
vi.mock("@/lib/security", () => ({ checkRateLimit: () => ({ allowed: true, retryAfterSeconds: 0 }), getClientIp: () => "127.0.0.1" }));
vi.mock("@/lib/tenant-context", () => ({ runWithTenant: (_o: string, fn: () => unknown) => fn() }));

import { GET, POST } from "@/app/api/public/events/[slug]/sessions/[sessionId]/end-survey/route";

const CONFIG = [{ id: "f1", type: "rating_1_to_5", label: "Useful?", required: true }];
const EVENT = (endSurveyId: string | null, extra: Record<string, unknown> = {}) => ({
  id: "ev1",
  organizationId: "org1",
  eventType: "WEBINAR",
  settings: { webinar: { sessionId: "s1", ...(endSurveyId ? { endSurveyId } : {}) } },
  surveyConfig: [{ id: "q1", type: "rating_1_to_5", label: "CME", required: true }],
  surveyIntroHtml: null,
  surveyThankYouHtml: null,
  ...extra,
});
const FB = {
  id: "svy-fb", eventId: "ev1", name: "Webinar feedback", config: CONFIG, introHtml: null, thankYouHtml: "<p>Thanks</p>",
  isActive: true, sortOrder: 1, gatesCertificates: false, responseMode: "ONCE", createdAt: new Date(0), updatedAt: new Date(0),
};
const REG = { id: "reg1", surveyCompletedAt: null, attendee: { id: "att1", tags: [] as string[] } };
const params = { params: Promise.resolve({ slug: "web", sessionId: "s1" }) };
const getReq = () => new Request("http://x/end-survey");
const postReq = (body: unknown) => ({ json: async () => body, headers: new Headers(), url: "http://x/end-survey" }) as unknown as Request;

beforeEach(() => {
  vi.clearAllMocks();
  mockAuth.mockResolvedValue({ user: { id: "u1", role: "REGISTRANT" } });
  mockDb.event.findFirst.mockResolvedValue(EVENT("svy-fb"));
  mockDb.registration.findFirst.mockResolvedValue(REG);
  mockDb.survey.findFirst.mockReset().mockResolvedValue(FB);
  mockDb.surveyResponse.count.mockReset().mockResolvedValue(0);
  mockDb.surveyResponse.create.mockResolvedValue({});
  // The webinar is over unless a test says otherwise.
  mockDb.eventSession.findFirst.mockResolvedValue({ status: "COMPLETED", endTime: new Date(0) });
});

describe("GET end-survey", () => {
  it("needs a signed-in viewer", async () => {
    mockAuth.mockResolvedValue(null);
    expect((await GET(getReq(), params)).status).toBe(401);
  });

  it("answers only for the webinar's room session", async () => {
    mockDb.event.findFirst.mockResolvedValue(EVENT("svy-fb", { settings: { webinar: { sessionId: "other" } } }));
    expect((await GET(getReq(), params)).status).toBe(404);
  });

  it("no survey chosen: nothing pops up", async () => {
    mockDb.event.findFirst.mockResolvedValue(EVENT(null));
    expect(await (await GET(getReq(), params)).json()).toEqual({ survey: null });
  });

  it("someone not registered (e.g. staff testing): nothing pops up", async () => {
    mockDb.registration.findFirst.mockResolvedValue(null);
    expect((await (await GET(getReq(), params)).json()).survey).toBeNull();
  });

  it("returns the chosen survey and whether this viewer already answered it", async () => {
    const body = await (await GET(getReq(), params)).json();
    expect(body.survey.id).toBe("svy-fb");
    expect(body.answered).toBe(false);
  });

  it("the CME survey never pops up, even if it were set", async () => {
    mockDb.event.findFirst.mockResolvedValue(EVENT("svy-cert"));
    mockDb.survey.findFirst.mockResolvedValue({ ...FB, id: "svy-cert", gatesCertificates: true });
    expect((await (await GET(getReq(), params)).json()).survey).toBeNull();
  });

  it("a closed survey: nothing pops up", async () => {
    mockDb.survey.findFirst.mockResolvedValue({ ...FB, isActive: false });
    expect((await (await GET(getReq(), params)).json()).survey).toBeNull();
  });
});

describe("POST end-survey", () => {
  it("records an extra survey's answer and NEVER marks CME completion", async () => {
    const res = await POST(postReq({ answers: { f1: "4" } }), params);
    expect(res.status).toBe(200);
    expect(mockDb.surveyResponse.create.mock.calls[0][0].data).toMatchObject({ surveyId: "svy-fb", registrationId: "reg1" });
    expect(mockDb.registration.update).not.toHaveBeenCalled();
    expect(mockDb.attendee.update).not.toHaveBeenCalled();
  });

  it("NEVER the CME survey, even if it were set: refused (410), nothing written (review of step 4)", async () => {
    mockDb.event.findFirst.mockResolvedValue(EVENT("svy-cert"));
    mockDb.survey.findFirst.mockResolvedValue({ ...FB, id: "svy-cert", gatesCertificates: true });
    const res = await POST(postReq({ answers: { q1: "5" } }), params);
    expect(res.status).toBe(410);
    expect(mockDb.surveyResponse.create).not.toHaveBeenCalled();
    expect(mockDb.registration.update).not.toHaveBeenCalled();
  });

  it("refuses answers while the webinar is still live (409)", async () => {
    mockDb.eventSession.findFirst.mockResolvedValue({ status: "LIVE", endTime: new Date(0) });
    expect((await POST(postReq({ answers: { f1: "4" } }), params)).status).toBe(409);
    mockDb.eventSession.findFirst.mockResolvedValue({ status: "SCHEDULED", endTime: new Date(Date.now() + 3600_000) });
    expect((await POST(postReq({ answers: { f1: "4" } }), params)).status).toBe(409);
    expect(mockDb.surveyResponse.create).not.toHaveBeenCalled();
  });

  it("looks up the viewer's own, non-cancelled registration, oldest first", async () => {
    await POST(postReq({ answers: { f1: "4" } }), params);
    expect(mockDb.registration.findFirst.mock.calls[0][0]).toMatchObject({
      where: { eventId: "ev1", userId: "u1", status: { not: "CANCELLED" } },
      orderBy: { createdAt: "asc" },
    });
  });

  it("refuses someone not registered (403)", async () => {
    mockDb.registration.findFirst.mockResolvedValue(null);
    expect((await POST(postReq({ answers: { f1: "4" } }), params)).status).toBe(403);
    expect(mockDb.surveyResponse.create).not.toHaveBeenCalled();
  });

  it("a closed survey refuses answers (410)", async () => {
    mockDb.survey.findFirst.mockResolvedValue({ ...FB, isActive: false });
    expect((await POST(postReq({ answers: { f1: "4" } }), params)).status).toBe(410);
  });

  it("invalid answers are refused (400)", async () => {
    expect((await POST(postReq({ answers: { f1: "9" } }), params)).status).toBe(400);
  });
});
