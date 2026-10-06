/**
 * survey-service (multi-survey step 2, Oct 6, 2026): the certificate rules and
 * the ONE writer of Registration.surveyCompletedAt. The first test is the
 * credential-path guard from docs/MULTI_SURVEY_PLAN.md §8: a survey that is
 * not the certificate survey must never mark completion or add the tag, since
 * that is what the certificate worker sweeps to mint CME certificates.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockDb } = vi.hoisted(() => ({
  mockDb: {
    survey: {
      findFirst: vi.fn(),
      findMany: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
      delete: vi.fn(),
    },
    surveyResponse: { create: vi.fn(), count: vi.fn() },
    registration: { update: vi.fn() },
    attendee: { update: vi.fn() },
    verificationToken: { delete: vi.fn() },
    event: { update: vi.fn() },
    auditLog: { create: vi.fn() },
    $queryRaw: vi.fn(),
  },
}));

vi.mock("@/lib/db", () => ({
  db: mockDb,
  tenantTransaction: (fn: (tx: typeof mockDb) => unknown) => fn(mockDb),
}));
vi.mock("@/lib/logger", () => ({ apiLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

import {
  EXTRA_SURVEYS_ANSWERABLE,
  applyLegacyEventSurveyWrite,
  createSurvey,
  deleteSurvey,
  responseWhereForSurvey,
  saveCertificateSurvey,
  submitSurveyResponse,
  updateSurvey,
} from "@/services/survey-service";

const CONFIG = [{ id: "q1", type: "rating_1_to_5", label: "Overall", required: true }];
const SCOPE = { eventId: "ev1", organizationId: "org1", userId: "u1", source: "rest" as const };
const REG = { id: "reg1", surveyCompletedAt: null, attendee: { id: "att1", tags: ["vip"] } };

beforeEach(() => {
  vi.clearAllMocks();
  mockDb.surveyResponse.count.mockResolvedValue(0);
  mockDb.survey.findFirst.mockResolvedValue(null);
  mockDb.survey.create.mockResolvedValue({ id: "svy-new" });
  mockDb.verificationToken.delete.mockResolvedValue({});
});

describe("L2: no extra survey is answerable before step 3", () => {
  it("refuses an answer to a non-certificate survey while the one-response-per-person unique stands", async () => {
    expect(EXTRA_SURVEYS_ANSWERABLE).toBe(false);
    const res = await submitSurveyResponse({
      survey: { id: "svy-feedback", eventId: "ev1", gatesCertificates: false, config: CONFIG },
      registration: REG,
      organizationId: "org1",
      rawAnswers: { q1: 4 },
      ipHash: null,
    });
    expect(res).toMatchObject({ ok: false, code: "NOT_YET_ANSWERABLE" });
    expect(mockDb.surveyResponse.create).not.toHaveBeenCalled();
  });
});

describe("submitSurveyResponse: the one writer of surveyCompletedAt", () => {
  // Extra surveys refuse answers until step 3 (L2); these two switch on by
  // themselves when step 3 sets EXTRA_SURVEYS_ANSWERABLE. The credential
  // guard holds today through the lock test above.
  it.skipIf(!EXTRA_SURVEYS_ANSWERABLE)("a NON-certificate survey writes its answer and never marks completion or adds the tag", async () => {
    const res = await submitSurveyResponse({
      survey: { id: "svy-feedback", eventId: "ev1", gatesCertificates: false, config: CONFIG },
      registration: REG,
      organizationId: "org1",
      rawAnswers: { q1: 4 },
      ipHash: null,
    });
    expect(res).toEqual({ ok: true, alreadyCompleted: false, answeredCount: 1 });
    expect(mockDb.surveyResponse.create.mock.calls[0][0].data).toMatchObject({ surveyId: "svy-feedback", dedupKey: "reg1", organizationId: "org1" });
    expect(mockDb.registration.update).not.toHaveBeenCalled();
    expect(mockDb.attendee.update).not.toHaveBeenCalled();
  });

  it("the certificate survey marks completion and adds survey-completed", async () => {
    await submitSurveyResponse({
      survey: { id: "svy-cert", eventId: "ev1", gatesCertificates: true, config: CONFIG },
      registration: REG,
      organizationId: "org1",
      rawAnswers: { q1: 5 },
      ipHash: "h",
      consumeTokenHash: "tok",
    });
    expect(mockDb.registration.update).toHaveBeenCalledWith({ where: { id: "reg1" }, data: { surveyCompletedAt: expect.any(Date) } });
    expect(mockDb.attendee.update).toHaveBeenCalledWith({ where: { id: "att1" }, data: { tags: ["vip", "survey-completed"] } });
    expect(mockDb.verificationToken.delete).toHaveBeenCalledWith({ where: { token: "tok" } });
  });

  it.skipIf(!EXTRA_SURVEYS_ANSWERABLE)("a non-certificate survey already answered is a no-op, not a second row", async () => {
    mockDb.surveyResponse.count.mockResolvedValueOnce(1);
    const res = await submitSurveyResponse({
      survey: { id: "svy-feedback", eventId: "ev1", gatesCertificates: false, config: CONFIG },
      registration: REG,
      organizationId: "org1",
      rawAnswers: { q1: 4 },
      ipHash: null,
    });
    expect(res).toMatchObject({ ok: true, alreadyCompleted: true });
    expect(mockDb.surveyResponse.create).not.toHaveBeenCalled();
  });

  it("invalid answers are refused before anything is written", async () => {
    const res = await submitSurveyResponse({
      survey: { id: "svy-cert", eventId: "ev1", gatesCertificates: true, config: CONFIG },
      registration: REG,
      organizationId: "org1",
      rawAnswers: { q1: 9 },
      ipHash: null,
    });
    expect(res).toMatchObject({ ok: false, code: "ANSWERS_INVALID" });
    expect(mockDb.surveyResponse.create).not.toHaveBeenCalled();
  });
});

describe("the CME survey is reserved and locked (owner, Oct 6, 2026)", () => {
  it("createSurvey always makes an ORDINARY survey, never a certificate one", async () => {
    const res = await createSurvey(SCOPE, { name: "Webinar feedback", config: CONFIG as never, introHtml: null, thankYouHtml: null, isActive: true });
    expect(res).toEqual({ ok: true, surveyId: "svy-new" });
    expect(mockDb.survey.create.mock.calls[0][0].data.gatesCertificates).toBe(false);
    expect(mockDb.survey.updateMany).not.toHaveBeenCalled();
    expect(mockDb.event.update).not.toHaveBeenCalled(); // the CME survey's mirror is untouched
  });

  it("updateSurvey refuses the CME survey (its reserved page is the only writer)", async () => {
    mockDb.survey.findFirst.mockResolvedValueOnce({ id: "svy-cert", gatesCertificates: true });
    const res = await updateSurvey(SCOPE, "svy-cert", { name: "Renamed" });
    expect(res).toMatchObject({ ok: false, code: "CERTIFICATE_SURVEY_LOCKED" });
    expect(mockDb.survey.update).not.toHaveBeenCalled();
  });

  it("updateSurvey on an extra survey never writes the certificate flag, whatever the caller passes", async () => {
    mockDb.survey.findFirst.mockResolvedValueOnce({ id: "svy-fb", gatesCertificates: false });
    await updateSurvey(SCOPE, "svy-fb", { name: "Renamed", gatesCertificates: true } as never);
    const data = mockDb.survey.update.mock.calls[0][0].data;
    expect(data).toEqual({ name: "Renamed" });
    expect(mockDb.event.update).not.toHaveBeenCalled(); // the CME mirror is untouched
  });

  it("saveCertificateSurvey creates the reserved slot when the event has none", async () => {
    mockDb.survey.findFirst
      .mockResolvedValueOnce(null) // no certificate survey yet
      .mockResolvedValueOnce({ config: CONFIG, introHtml: null, thankYouHtml: null, isActive: true }); // mirror
    await saveCertificateSurvey(SCOPE, { config: CONFIG as never, introHtml: null, thankYouHtml: null, isActive: true });
    expect(mockDb.$queryRaw).toHaveBeenCalledTimes(1); // the event-row lock comes first
    expect(mockDb.survey.create.mock.calls[0][0].data).toMatchObject({ gatesCertificates: true, name: "Post-event survey" });
    expect(mockDb.event.update).toHaveBeenCalled();
  });

  it("saveCertificateSurvey edits the existing one and leaves its flag alone", async () => {
    mockDb.survey.findFirst
      .mockResolvedValueOnce({ id: "svy-cert" })
      .mockResolvedValueOnce({ config: CONFIG, introHtml: null, thankYouHtml: null, isActive: true });
    mockDb.survey.update.mockResolvedValueOnce({ id: "svy-cert" });
    await saveCertificateSurvey(SCOPE, { config: CONFIG as never, introHtml: "<p>x</p>", thankYouHtml: null, isActive: true });
    expect(mockDb.survey.create).not.toHaveBeenCalled();
    expect("gatesCertificates" in mockDb.survey.update.mock.calls[0][0].data).toBe(false);
  });

  it("the certificate survey cannot be deleted, even with no answers", async () => {
    mockDb.survey.findFirst.mockResolvedValueOnce({ id: "svy-cert", eventId: "ev1", gatesCertificates: true, name: "Post-event survey" });
    const res = await deleteSurvey(SCOPE, "svy-cert");
    expect(res).toMatchObject({ ok: false, code: "CERTIFICATE_SURVEY_LOCKED" });
    expect(mockDb.survey.delete).not.toHaveBeenCalled();
  });
});

describe("deleting a survey", () => {
  it("is refused while it has answers", async () => {
    mockDb.survey.findFirst.mockResolvedValueOnce({ id: "svy1", eventId: "ev1", gatesCertificates: false, name: "Feedback" });
    mockDb.surveyResponse.count.mockResolvedValueOnce(2);
    const res = await deleteSurvey(SCOPE, "svy1");
    expect(res).toMatchObject({ ok: false, code: "SURVEY_HAS_RESPONSES" });
    expect(mockDb.survey.delete).not.toHaveBeenCalled();
  });

  it("works for an ordinary survey with none", async () => {
    mockDb.survey.findFirst.mockResolvedValueOnce({ id: "svy1", eventId: "ev1", gatesCertificates: false, name: "Feedback" });
    const res = await deleteSurvey(SCOPE, "svy1");
    expect(res).toEqual({ ok: true, surveyId: "svy1" });
    expect(mockDb.survey.delete).toHaveBeenCalledWith({ where: { id: "svy1" } });
  });
});

describe("the old Event-column write path lands on the certificate survey", () => {
  it("a config with no certificate survey yet creates one", async () => {
    await applyLegacyEventSurveyWrite(SCOPE, { config: CONFIG as never, introHtml: "<p>i</p>" });
    expect(mockDb.survey.create.mock.calls[0][0].data).toMatchObject({ gatesCertificates: true, name: "Post-event survey", introHtml: "<p>i</p>" });
  });

  it("a clear CLOSES the CME survey and never deletes it (L1)", async () => {
    mockDb.survey.findFirst.mockResolvedValueOnce({ id: "svy-cert" });
    await applyLegacyEventSurveyWrite(SCOPE, { config: null });
    expect(mockDb.survey.update).toHaveBeenCalledWith({ where: { id: "svy-cert" }, data: { isActive: false } });
    expect(mockDb.survey.delete).not.toHaveBeenCalled();
  });
});

describe("responseWhereForSurvey", () => {
  it("the certificate survey also owns its event's not-yet-linked responses", () => {
    expect(responseWhereForSurvey({ id: "s", eventId: "e", gatesCertificates: true })).toEqual({
      eventId: "e",
      OR: [{ surveyId: "s" }, { surveyId: null }],
    });
    expect(responseWhereForSurvey({ id: "s", eventId: "e", gatesCertificates: false })).toEqual({ surveyId: "s" });
  });
});
