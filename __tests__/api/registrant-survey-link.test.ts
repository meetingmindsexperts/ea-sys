/**
 * POST /api/registrant/registrations/[registrationId]/survey-link: the "Take
 * survey" button on My events (docs/MY_PORTAL_PLAN.md, phase 3). It mints a
 * live survey token, so the load-bearing rules are WHO (the owner, by
 * ownRegistrationWhere, read from the database) and WHEN (a place at a started
 * event, an open survey not yet answered).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockDb, mockAuth, mockRateLimit, svc, logger } = vi.hoisted(() => ({
  mockAuth: vi.fn(),
  mockDb: { user: { findUnique: vi.fn() }, registration: { findFirst: vi.fn() }, verificationToken: { findFirst: vi.fn() } },
  mockRateLimit: vi.fn(),
  svc: { resolveTokenSurvey: vi.fn(), hasAnswered: vi.fn(), mintPersonalSurveyLink: vi.fn() },
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("@/lib/auth", () => ({ auth: mockAuth }));
vi.mock("@/lib/db", () => ({ db: mockDb }));
vi.mock("@/lib/logger", () => ({ apiLogger: logger }));
vi.mock("@/lib/tenant/resolver", () => ({ resolveRequestOrgId: vi.fn(async () => "org1") }));
vi.mock("@/lib/tenant-lane", () => ({ runWithTenantLane: (_o: unknown, _c: unknown, fn: () => unknown) => fn() }));
vi.mock("@/lib/security", () => ({ checkRateLimit: mockRateLimit }));
vi.mock("@/services/survey-service", async () => {
  const real = await vi.importActual<typeof import("@/services/survey-service")>("@/services/survey-service");
  return { ...svc, isLiveConfig: real.isLiveConfig, surveyLinkIdentifiers: real.surveyLinkIdentifiers };
});

import { POST } from "@/app/api/registrant/registrations/[registrationId]/survey-link/route";

const STARTED = new Date(Date.now() - 86400000);
const LIVE_SURVEY = { kind: "ok", survey: { surveyId: "cert1", gatesCertificates: true, responseMode: "ONCE", config: [{ id: "q" }], introHtml: null, thankYouHtml: null } };
const LINK_ENDS = new Date(Date.now() + 5 * 86400000);

function post(body: unknown = { surveyId: "cert1" }, registrationId = "reg1") {
  return POST(new Request("http://x", { method: "POST", body: JSON.stringify(body) }), { params: Promise.resolve({ registrationId }) });
}

function registration(over: Record<string, unknown> = {}) {
  return {
    id: "reg1",
    status: "CONFIRMED",
    surveyCompletedAt: null,
    event: { id: "ev1", slug: "osh", startDate: STARTED, timezone: "Asia/Dubai", surveyConfig: [{ id: "q" }], surveyIntroHtml: null, surveyThankYouHtml: null },
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockAuth.mockResolvedValue({ user: { id: "u1", role: "REGISTRANT", tokenVersion: 0 } });
  mockRateLimit.mockReturnValue({ allowed: true, remaining: 19, retryAfterSeconds: 0 });
  // A confirmed account: the address comes from the database, not the session.
  mockDb.user.findUnique.mockResolvedValue({ email: "Anna@Example.com", emailConfirmedAt: new Date(), tokenVersion: 0 });
  mockDb.registration.findFirst.mockResolvedValue(registration());
  svc.resolveTokenSurvey.mockResolvedValue(LIVE_SURVEY);
  svc.hasAnswered.mockResolvedValue(false);
  svc.mintPersonalSurveyLink.mockResolvedValue("/e/osh/survey?token=abc123");
  // The organiser's link to this person, still alive.
  mockDb.verificationToken.findFirst.mockResolvedValue({ expires: LINK_ENDS });
});

describe("who", () => {
  it("401 without a session, and nothing is minted", async () => {
    mockAuth.mockResolvedValue(null);
    expect((await post()).status).toBe(401);
    expect(svc.mintPersonalSurveyLink).not.toHaveBeenCalled();
  });

  it("looks the registration up through ownRegistrationWhere: linked, or unlinked on the confirmed address", async () => {
    await post();
    const where = mockDb.registration.findFirst.mock.calls[0][0].where;
    expect(where.id).toBe("reg1");
    expect(where.OR).toEqual([
      { userId: "u1" },
      { userId: null, attendee: { email: { equals: "anna@example.com", mode: "insensitive" } } },
    ]);
  });

  it("an unconfirmed account reaches only registrations linked to it", async () => {
    mockDb.user.findUnique.mockResolvedValue({ email: "anna@example.com", emailConfirmedAt: null, tokenVersion: 0 });
    await post();
    expect(mockDb.registration.findFirst.mock.calls[0][0].where).toEqual({ id: "reg1", userId: "u1" });
  });

  it("404 for someone else's registration, logged, nothing minted", async () => {
    mockDb.registration.findFirst.mockResolvedValue(null);
    const res = await post();
    expect(res.status).toBe(404);
    expect(svc.mintPersonalSurveyLink).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(expect.objectContaining({ msg: "registrant/survey-link:registration-not-found" }));
  });

  it("429 when rate limited, with the retry hint", async () => {
    mockRateLimit.mockReturnValue({ allowed: false, remaining: 0, retryAfterSeconds: 120 });
    const res = await post();
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBe("120");
    expect(await res.json()).toMatchObject({ retryAfterSeconds: 120, limit: 20 });
  });
});

describe("when", () => {
  it.each([
    ["a pending registration", { status: "PENDING" }, "NOT_ATTENDING"],
    ["a waitlisted registration", { status: "WAITLISTED" }, "NOT_ATTENDING"],
    ["an event that has not started", { event: { ...registration().event, startDate: new Date(Date.now() + 86400000) } }, "NOT_STARTED"],
  ])("409 for %s", async (_label, over, code) => {
    mockDb.registration.findFirst.mockResolvedValue(registration(over));
    const res = await post();
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe(code);
    expect(svc.mintPersonalSurveyLink).not.toHaveBeenCalled();
  });

  it.each(["closed", "none"])("409 when the survey is %s", async (kind) => {
    svc.resolveTokenSurvey.mockResolvedValue({ kind });
    const res = await post();
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe("SURVEY_UNAVAILABLE");
    expect(svc.mintPersonalSurveyLink).not.toHaveBeenCalled();
  });

  it("409 when already answered, by hasAnswered's rule", async () => {
    svc.hasAnswered.mockResolvedValue(true);
    const res = await post();
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe("ALREADY_ANSWERED");
    expect(svc.hasAnswered).toHaveBeenCalledWith({
      survey: { id: "cert1", gatesCertificates: true, responseMode: "ONCE" },
      registration: { id: "reg1", surveyCompletedAt: null },
      timezone: "Asia/Dubai",
    });
    expect(svc.mintPersonalSurveyLink).not.toHaveBeenCalled();
  });

  it("409 NOT_INVITED without a live link from the organiser: a no-show cannot reach the CME survey", async () => {
    mockDb.verificationToken.findFirst.mockResolvedValue(null);
    const res = await post();
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe("NOT_INVITED");
    expect(svc.mintPersonalSurveyLink).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(expect.objectContaining({ msg: "registrant/survey-link:not-invited", certificate: true }));
  });

  it("looks for the link under both CME forms, unexpired only", async () => {
    await post();
    const where = mockDb.verificationToken.findFirst.mock.calls[0][0].where;
    expect(where.identifier).toEqual({ in: ["survey:reg1", "survey:cert1:reg1"] });
    expect(where.expires.gt).toBeInstanceOf(Date);
  });

  it("an extra survey's link is looked for under its own form only", async () => {
    svc.resolveTokenSurvey.mockResolvedValue({ kind: "ok", survey: { ...LIVE_SURVEY.survey, surveyId: "s2", gatesCertificates: false } });
    await post({ surveyId: "s2" });
    expect(mockDb.verificationToken.findFirst.mock.calls[0][0].where.identifier).toEqual({ in: ["survey:s2:reg1"] });
  });

  it("409 for an extra survey with no questions", async () => {
    svc.resolveTokenSurvey.mockResolvedValue({ kind: "ok", survey: { ...LIVE_SURVEY.survey, surveyId: "s2", gatesCertificates: false, config: [] } });
    const res = await post({ surveyId: "s2" });
    expect((await res.json()).code).toBe("SURVEY_UNAVAILABLE");
    expect(svc.mintPersonalSurveyLink).not.toHaveBeenCalled();
  });

  it("400 on a malformed body", async () => {
    expect((await post({ surveyId: 42 })).status).toBe(400);
    expect((await post("nope")).status).toBe(400);
  });
});

describe("issuing", () => {
  it("resolves the survey the way the survey page does and returns a site-relative link", async () => {
    const res = await post({ surveyId: null });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ url: "/e/osh/survey?token=abc123" });
    expect(svc.resolveTokenSurvey).toHaveBeenCalledWith(registration().event, null);
    expect(svc.mintPersonalSurveyLink).toHaveBeenCalledWith({
      survey: { id: "cert1", gatesCertificates: true, responseMode: "ONCE" },
      registrationId: "reg1",
      eventSlug: "osh",
      appUrl: "",
      // Ends when the organiser's link would have, never later.
      expiry: { at: LINK_ENDS },
    });
  });

  it("never logs the token", async () => {
    await post();
    for (const fn of [logger.info, logger.warn, logger.error]) {
      for (const call of fn.mock.calls) expect(JSON.stringify(call)).not.toContain("abc123");
    }
  });
});
