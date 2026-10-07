/**
 * The survey routes (multi-survey step 2, Oct 6, 2026) and the CME lock at the
 * HTTP edge: a request that carries a certificate flag is refused (.strict(),
 * never silently ignored), and the CME survey cannot be edited or deleted
 * through the generic survey route.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockAuth, mockDb } = vi.hoisted(() => ({
  mockAuth: vi.fn(),
  mockDb: {
    event: { findFirst: vi.fn() },
    survey: { findFirst: vi.fn(), create: vi.fn(), update: vi.fn(), delete: vi.fn() },
    surveyResponse: { count: vi.fn() },
    auditLog: { create: vi.fn() },
    $queryRaw: vi.fn(),
  },
}));

vi.mock("next/server", () => ({
  NextResponse: {
    json: (body: unknown, init?: { status?: number }) => ({ status: init?.status ?? 200, json: async () => body }),
  },
}));
vi.mock("@/lib/auth", () => ({ auth: mockAuth }));
vi.mock("@/lib/db", () => ({
  db: mockDb,
  tenantTransaction: (fn: (tx: typeof mockDb) => unknown) => fn(mockDb),
}));
vi.mock("@/lib/logger", () => ({ apiLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock("@/lib/tenant-context", () => ({ runWithTenant: (_org: string, fn: () => unknown) => fn() }));
vi.mock("@/lib/permissions/require-permission", () => ({
  requirePermission: () => ({ ok: true, eventWhere: { id: "ev1" } }),
}));

import { POST as createRoute } from "@/app/api/events/[eventId]/surveys/route";
import { PUT as updateRoute, DELETE as deleteRoute } from "@/app/api/events/[eventId]/surveys/[surveyId]/route";
import { POST as duplicateRoute } from "@/app/api/events/[eventId]/surveys/[surveyId]/duplicate/route";

const CONFIG = [{ id: "q1", type: "rating_1_to_5", label: "Overall", required: true }];
const req = (body?: unknown) => ({ json: async () => body }) as unknown as Request;
const evParams = { params: Promise.resolve({ eventId: "ev1" }) };
const svParams = (surveyId: string) => ({ params: Promise.resolve({ eventId: "ev1", surveyId }) });

beforeEach(() => {
  vi.clearAllMocks();
  mockAuth.mockResolvedValue({ user: { id: "u1", role: "ADMIN", organizationId: "org1" } });
  mockDb.event.findFirst.mockResolvedValue({ id: "ev1", organizationId: "org1" });
  mockDb.survey.create.mockResolvedValue({ id: "svy-new" });
  mockDb.surveyResponse.count.mockResolvedValue(0);
});

describe("POST /surveys", () => {
  it("creates an extra survey, never a certificate one", async () => {
    mockDb.survey.findFirst.mockResolvedValueOnce(null);
    const res = await createRoute(req({ name: "Webinar feedback", config: CONFIG }), evParams);
    expect(res.status).toBe(201);
    expect(mockDb.survey.create.mock.calls[0][0].data.gatesCertificates).toBe(false);
  });

  it("refuses a request that tries to send a certificate flag (400, not ignored)", async () => {
    const res = await createRoute(req({ name: "Sneaky", config: CONFIG, gatesCertificates: true }), evParams);
    expect(res.status).toBe(400);
    expect(mockDb.survey.create).not.toHaveBeenCalled();
  });
});

describe("PUT / DELETE /surveys/[surveyId] on the CME survey", () => {
  it("refuses a certificate flag in an edit (400)", async () => {
    const res = await updateRoute(req({ gatesCertificates: false }), svParams("svy-cert"));
    expect(res.status).toBe(400);
    expect(mockDb.survey.update).not.toHaveBeenCalled();
  });

  it("refuses editing the CME survey through the generic route (409)", async () => {
    mockDb.survey.findFirst.mockResolvedValueOnce({ id: "svy-cert", gatesCertificates: true });
    const res = await updateRoute(req({ name: "Renamed" }), svParams("svy-cert"));
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe("CERTIFICATE_SURVEY_LOCKED");
    expect(mockDb.survey.update).not.toHaveBeenCalled();
  });

  it("refuses deleting the CME survey (409), even with no answers", async () => {
    mockDb.survey.findFirst.mockResolvedValueOnce({ id: "svy-cert", eventId: "ev1", gatesCertificates: true, name: "Post-event survey" });
    const res = await deleteRoute(req(), svParams("svy-cert"));
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe("CERTIFICATE_SURVEY_LOCKED");
    expect(mockDb.survey.delete).not.toHaveBeenCalled();
  });
});

describe("POST /surveys/[surveyId]/duplicate (Oct 7, 2026)", () => {
  const row = (over: Record<string, unknown>) => ({
    id: "svy-src",
    eventId: "ev1",
    name: "Post-event survey",
    config: CONFIG,
    introHtml: "<p>Intro</p>",
    thankYouHtml: null,
    isActive: true,
    sortOrder: 1,
    gatesCertificates: false,
    responseMode: "ONCE_PER_DAY",
    createdAt: new Date(),
    updatedAt: new Date(),
    ...over,
  });

  it("copies the CME survey into a closed EXTRA survey, from the live event columns", async () => {
    const live = [{ id: "q9", type: "text", label: "Live question", required: false }];
    mockDb.event.findFirst.mockResolvedValueOnce({
      id: "ev1",
      organizationId: "org1",
      surveyConfig: live,
      surveyIntroHtml: "<p>Live intro</p>",
      surveyThankYouHtml: null,
    });
    mockDb.survey.findFirst
      .mockResolvedValueOnce(row({ id: "svy-cert", gatesCertificates: true, responseMode: "ONCE", config: CONFIG }))
      .mockResolvedValueOnce({ sortOrder: 3 });
    const res = await duplicateRoute(req(), svParams("svy-cert"));
    expect(res.status).toBe(201);
    const data = mockDb.survey.create.mock.calls[0][0].data;
    expect(data).toMatchObject({
      name: "Post-event survey (copy)",
      gatesCertificates: false,
      isActive: false,
      responseMode: "ONCE",
      config: live,
      introHtml: "<p>Live intro</p>",
      sortOrder: 4,
    });
    expect(mockDb.auditLog.create.mock.calls[0][0].data.changes.duplicatedFrom).toBe("svy-cert");
  });

  it("keeps an extra survey's answer mode", async () => {
    mockDb.survey.findFirst.mockResolvedValueOnce(row({})).mockResolvedValueOnce(null);
    await duplicateRoute(req(), svParams("svy-src"));
    expect(mockDb.survey.create.mock.calls[0][0].data.responseMode).toBe("ONCE_PER_DAY");
  });

  it("404s a survey of another event", async () => {
    mockDb.survey.findFirst.mockResolvedValueOnce(null);
    const res = await duplicateRoute(req(), svParams("svy-x"));
    expect(res.status).toBe(404);
    expect(mockDb.survey.create).not.toHaveBeenCalled();
  });

  it("refuses a survey with no questions (409)", async () => {
    mockDb.survey.findFirst.mockResolvedValueOnce(row({ config: [] }));
    const res = await duplicateRoute(req(), svParams("svy-src"));
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe("SURVEY_EMPTY");
    expect(mockDb.survey.create).not.toHaveBeenCalled();
  });
});
