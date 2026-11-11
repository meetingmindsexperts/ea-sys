/**
 * /api/events/[eventId]/certificates/assignments and the auto-issue switch on
 * the template PATCH (Nov 11, 2026): who may call them, and how the service's
 * answers become HTTP. The service itself is mocked (its own tests, and the
 * real-Postgres suite, cover it).
 *
 * The one thing no client may get wrong: CONFIRM_SEND_NOW is a 409 that
 * carries the number of certificates about to go out, and nothing is assigned
 * (or switched on) until the same request comes back with confirmSendNow.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  auth: vi.fn(),
  eventFindFirst: vi.fn(),
  templateFindFirst: vi.fn(),
  templateFindMany: vi.fn(),
  templateUpdate: vi.fn(),
  registrationFindFirst: vi.fn(),
  speakerFindFirst: vi.fn(),
  assignmentFindMany: vi.fn(),
  assign: vi.fn(),
  unassign: vi.fn(),
  resolveEmails: vi.fn(),
  setAuto: vi.fn(),
  rateLimit: vi.fn(),
  warn: vi.fn(),
}));

vi.mock("@/lib/logger", () => ({ apiLogger: { error: vi.fn(), info: vi.fn(), warn: h.warn, debug: vi.fn() } }));
vi.mock("@/lib/auth", () => ({ auth: () => h.auth() }));
vi.mock("@/lib/db", () => ({
  db: {
    event: { findFirst: (...a: unknown[]) => h.eventFindFirst(...a) },
    certificateTemplate: {
      findFirst: (...a: unknown[]) => h.templateFindFirst(...a),
      findMany: (...a: unknown[]) => h.templateFindMany(...a),
      update: (...a: unknown[]) => h.templateUpdate(...a),
    },
    registration: { findFirst: (...a: unknown[]) => h.registrationFindFirst(...a) },
    speaker: { findFirst: (...a: unknown[]) => h.speakerFindFirst(...a) },
    certificateAssignment: { findMany: (...a: unknown[]) => h.assignmentFindMany(...a) },
  },
  tenantTransaction: (cb: (tx: unknown) => unknown) => cb({}),
}));
vi.mock("@/lib/security", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/security")>()),
  checkRateLimit: (...a: unknown[]) => h.rateLimit(...a),
}));
vi.mock("@/services/certificate-assignment-service", () => ({
  MAX_ASSIGNMENT_BATCH: 5000,
  assignCertificate: (...a: unknown[]) => h.assign(...a),
  unassignCertificate: (...a: unknown[]) => h.unassign(...a),
  resolveAssignmentEmails: (...a: unknown[]) => h.resolveEmails(...a),
  setTemplateAutoIssue: (...a: unknown[]) => h.setAuto(...a),
}));

import { GET, POST, DELETE } from "@/app/api/events/[eventId]/certificates/assignments/route";
import { PATCH as templatePATCH } from "@/app/api/events/[eventId]/certificates/templates/[templateId]/route";

const session = (role: string, organizationId: string | null = "org-1") => ({ user: { id: "user-1", role, organizationId } });
const params = { params: Promise.resolve({ eventId: "evt-1" }) };
const req = (method: string, body?: unknown, query = "") =>
  new Request(`http://localhost/api/events/evt-1/certificates/assignments${query}`, {
    method,
    ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { "content-type": "application/json" } }),
  });

const OK = { ok: true, templateName: "CME", assigned: 2, alreadyAssigned: 0, skipped: 0, sendNow: 0, dryRun: false };

beforeEach(() => {
  Object.values(h).forEach((m) => m.mockReset());
  h.auth.mockResolvedValue(session("ADMIN"));
  h.eventFindFirst.mockResolvedValue({ id: "evt-1", organizationId: "org-1" });
  h.rateLimit.mockReturnValue({ allowed: true, remaining: 10, retryAfterSeconds: 0 });
  h.assign.mockResolvedValue(OK);
  h.unassign.mockResolvedValue({ ok: true, templateName: "CME", removed: 1, keptIssued: 0 });
});

describe("POST assign", () => {
  it("401 without a session, and the service is never reached", async () => {
    h.auth.mockResolvedValue(null);
    expect((await POST(req("POST", { templateId: "t", registrationIds: ["r1"] }), params)).status).toBe(401);
    expect(h.assign).not.toHaveBeenCalled();
  });

  it.each(["MEMBER", "ONSITE", "REVIEWER", "SUBMITTER", "REGISTRANT", "CRM_USER", "HR_USER"])(
    "403 for %s: assigning needs the certificate template key",
    async (role) => {
      h.auth.mockResolvedValue(session(role, role === "REVIEWER" || role === "SUBMITTER" || role === "REGISTRANT" ? null : "org-1"));
      expect((await POST(req("POST", { templateId: "t", registrationIds: ["r1"] }), params)).status).toBe(403);
      expect(h.assign).not.toHaveBeenCalled();
    },
  );

  it("assigns for an organiser and passes the event's organisation, the person and MANUAL", async () => {
    h.auth.mockResolvedValue(session("ORGANIZER"));
    const res = await POST(req("POST", { templateId: "tpl", registrationIds: ["r1", "r2"] }), params);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, assigned: 2, unmatched: [], cancelled: [] });
    expect(h.assign).toHaveBeenCalledWith({
      eventId: "evt-1",
      organizationId: "org-1",
      templateId: "tpl",
      registrationIds: ["r1", "r2"],
      speakerIds: undefined,
      userId: "user-1",
      source: "rest",
      assignmentSource: "MANUAL",
      confirmSendNow: false,
      dryRun: false,
    });
  });

  it("looks the event up through the caller's own access, and 404s one they cannot reach", async () => {
    h.eventFindFirst.mockResolvedValue(null);
    expect((await POST(req("POST", { templateId: "tpl", registrationIds: ["r1"] }), params)).status).toBe(404);
    expect(h.eventFindFirst.mock.calls[0][0].where).toMatchObject({ id: "evt-1", organizationId: "org-1" });
    expect(h.assign).not.toHaveBeenCalled();
  });

  it("CONFIRM_SEND_NOW is a 409 carrying how many certificates would go out", async () => {
    h.assign.mockResolvedValue({
      ok: false,
      code: "CONFIRM_SEND_NOW",
      message: "3 of these people have already answered the survey. Their certificates will be sent now.",
      meta: { sendNow: 3, assigned: 5, templateName: "CME" },
    });
    const res = await POST(req("POST", { templateId: "tpl", registrationIds: ["r1"] }), params);
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: "CONFIRM_SEND_NOW", sendNow: 3, assigned: 5, error: expect.stringContaining("already answered") });
  });

  it("confirmSendNow and dryRun reach the service only when they are literally true", async () => {
    await POST(req("POST", { templateId: "tpl", registrationIds: ["r1"], confirmSendNow: true, dryRun: true }), params);
    expect(h.assign.mock.calls[0][0]).toMatchObject({ confirmSendNow: true, dryRun: true });
    // A string "true" is not a boolean: the request is invalid, not confirmed.
    const res = await POST(req("POST", { templateId: "tpl", registrationIds: ["r1"], confirmSendNow: "true" }), params);
    expect(res.status).toBe(400);
    expect(h.assign).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["TEMPLATE_NOT_FOUND", 404],
    ["WRONG_RECIPIENT_TYPE", 400],
    ["NO_RECIPIENTS", 400],
    ["TOO_MANY", 400],
  ])("maps %s to %i", async (code, status) => {
    h.assign.mockResolvedValue({ ok: false, code, message: "no" });
    expect((await POST(req("POST", { templateId: "tpl", registrationIds: ["r1"] }), params)).status).toBe(status);
  });

  it("400 unless exactly one of registrationIds, speakerIds or emails is given", async () => {
    for (const body of [
      { templateId: "tpl" },
      { templateId: "tpl", registrationIds: [] },
      { templateId: "tpl", registrationIds: ["r1"], speakerIds: ["s1"] },
      { templateId: "tpl", registrationIds: ["r1"], emails: ["a@x.com"] },
      { registrationIds: ["r1"] },
    ]) {
      expect((await POST(req("POST", body), params)).status).toBe(400);
    }
    expect(h.assign).not.toHaveBeenCalled();
    expect(h.warn).toHaveBeenCalledWith(expect.objectContaining({ msg: "cert-assignments:assign-invalid-input" }));
  });

  it("a pasted list is matched to the event's people, assigned as EMAIL_LIST, and the strangers come back", async () => {
    h.templateFindFirst.mockResolvedValue({ category: "ATTENDANCE" });
    h.resolveEmails.mockResolvedValue({ registrationIds: ["r1"], speakerIds: [], unmatched: ["stranger@x.com"], cancelled: ["gone@x.com"] });
    h.assign.mockResolvedValue({ ...OK, assigned: 1 });
    const res = await POST(req("POST", { templateId: "tpl", emails: ["a@x.com", "stranger@x.com", "gone@x.com"] }), params);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ assigned: 1, unmatched: ["stranger@x.com"], cancelled: ["gone@x.com"] });
    expect(h.resolveEmails).toHaveBeenCalledWith({ eventId: "evt-1", category: "ATTENDANCE", emails: ["a@x.com", "stranger@x.com", "gone@x.com"] });
    expect(h.assign.mock.calls[0][0]).toMatchObject({ registrationIds: ["r1"], speakerIds: undefined, assignmentSource: "EMAIL_LIST" });
    // The template is looked up inside this event only.
    expect(h.templateFindFirst.mock.calls[0][0].where).toEqual({ id: "tpl", eventId: "evt-1" });
  });

  it("a list that matches nobody is an answer, not an error, and assigns nothing", async () => {
    h.templateFindFirst.mockResolvedValue({ category: "ATTENDANCE" });
    h.resolveEmails.mockResolvedValue({ registrationIds: [], speakerIds: [], unmatched: ["x@x.com"], cancelled: [] });
    const res = await POST(req("POST", { templateId: "tpl", emails: ["x@x.com"] }), params);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ assigned: 0, unmatched: ["x@x.com"] });
    expect(h.assign).not.toHaveBeenCalled();
  });

  it("a pasted list for a template that is not this event's is a 404", async () => {
    h.templateFindFirst.mockResolvedValue(null);
    expect((await POST(req("POST", { templateId: "nope", emails: ["a@x.com"] }), params)).status).toBe(404);
    expect(h.resolveEmails).not.toHaveBeenCalled();
  });

  it("429 with the retry fields when the limit is hit", async () => {
    h.rateLimit.mockReturnValue({ allowed: false, remaining: 0, retryAfterSeconds: 120 });
    const res = await POST(req("POST", { templateId: "tpl", registrationIds: ["r1"] }), params);
    expect(res.status).toBe(429);
    expect(await res.json()).toMatchObject({ code: "RATE_LIMITED", retryAfterSeconds: 120, limit: 300, windowSeconds: 3600 });
    expect(h.assign).not.toHaveBeenCalled();
  });
});

describe("DELETE unassign", () => {
  it("removes people and reports who stayed because they hold the certificate", async () => {
    h.unassign.mockResolvedValue({ ok: true, templateName: "CME", removed: 1, keptIssued: 2 });
    const res = await DELETE(req("DELETE", { templateId: "tpl", registrationIds: ["r1", "r2", "r3"] }), params);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ removed: 1, keptIssued: 2 });
    expect(h.unassign).toHaveBeenCalledWith({
      eventId: "evt-1", templateId: "tpl", registrationIds: ["r1", "r2", "r3"], speakerIds: undefined, userId: "user-1", source: "rest",
    });
  });

  it("403 for a role without the key, 404 for an unknown template, 400 for a bad body", async () => {
    h.auth.mockResolvedValue(session("MEMBER"));
    expect((await DELETE(req("DELETE", { templateId: "tpl", registrationIds: ["r1"] }), params)).status).toBe(403);
    h.auth.mockResolvedValue(session("ADMIN"));
    h.unassign.mockResolvedValue({ ok: false, code: "TEMPLATE_NOT_FOUND", message: "no" });
    expect((await DELETE(req("DELETE", { templateId: "tpl", registrationIds: ["r1"] }), params)).status).toBe(404);
    expect((await DELETE(req("DELETE", { templateId: "tpl" }), params)).status).toBe(400);
  });
});

describe("GET one person's assignments", () => {
  beforeEach(() => {
    h.registrationFindFirst.mockResolvedValue({ id: "r1" });
    h.speakerFindFirst.mockResolvedValue({ id: "s1" });
    h.templateFindMany.mockResolvedValue([{ id: "t1" }, { id: "t2" }]);
  });

  it("returns the templates assigned to a registration", async () => {
    h.assignmentFindMany.mockResolvedValue([{ certificateTemplateId: "t2", registrationId: "r1", speakerId: null }]);
    const res = await GET(req("GET", undefined, "?registrationId=r1"), params);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ templateIds: ["t2"] });
    // The person is looked up inside this event.
    expect(h.registrationFindFirst.mock.calls[0][0].where).toEqual({ id: "r1", eventId: "evt-1" });
  });

  it("returns the templates assigned to a speaker", async () => {
    h.assignmentFindMany.mockResolvedValue([{ certificateTemplateId: "t1", registrationId: null, speakerId: "s1" }]);
    const res = await GET(req("GET", undefined, "?speakerId=s1"), params);
    expect(await res.json()).toEqual({ templateIds: ["t1"] });
  });

  it("404 for a person who is not this event's, 400 without exactly one id", async () => {
    h.registrationFindFirst.mockResolvedValue(null);
    expect((await GET(req("GET", undefined, "?registrationId=other"), params)).status).toBe(404);
    expect((await GET(req("GET"), params)).status).toBe(400);
    expect((await GET(req("GET", undefined, "?registrationId=r1&speakerId=s1"), params)).status).toBe(400);
  });

  it("403 for a role that cannot read certificates", async () => {
    h.auth.mockResolvedValue(session("ONSITE"));
    expect((await GET(req("GET", undefined, "?registrationId=r1"), params)).status).toBe(403);
  });
});

describe("the auto-issue switch on the template PATCH", () => {
  const tplParams = { params: Promise.resolve({ eventId: "evt-1", templateId: "tpl" }) };
  const patch = (body: unknown) =>
    templatePATCH(new Request("http://localhost/x", { method: "PATCH", body: JSON.stringify(body) }), tplParams);

  beforeEach(() => {
    h.templateFindFirst.mockResolvedValue({ id: "tpl", eventId: "evt-1" });
    h.templateUpdate.mockImplementation(async (args: { data: Record<string, unknown> }) => ({ id: "tpl", ...args.data }));
    h.setAuto.mockResolvedValue({ ok: true, changed: true, sendNow: 0 });
  });

  it("goes through the service, never straight into the column", async () => {
    const res = await patch({ autoIssueOnSurvey: true });
    expect(res.status).toBe(200);
    expect(h.setAuto).toHaveBeenCalledWith({
      eventId: "evt-1", templateId: "tpl", enabled: true, userId: "user-1", source: "rest", confirmSendNow: false,
    });
    expect(h.templateUpdate.mock.calls[0][0].data).not.toHaveProperty("autoIssueOnSurvey");
  });

  it("a refused switch is a 409 with the count, and NOTHING else in the request is applied", async () => {
    h.setAuto.mockResolvedValue({ ok: false, code: "CONFIRM_SEND_NOW", message: "2 assigned people have already answered the survey.", meta: { sendNow: 2, templateName: "CME" } });
    const res = await patch({ autoIssueOnSurvey: true, name: "Renamed" });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: "CONFIRM_SEND_NOW", sendNow: 2 });
    expect(h.templateUpdate).not.toHaveBeenCalled();
  });

  it("confirmSendNow reaches the service, and the rest of the request is then applied", async () => {
    await patch({ autoIssueOnSurvey: true, confirmSendNow: true, name: "Renamed" });
    expect(h.setAuto.mock.calls[0][0]).toMatchObject({ enabled: true, confirmSendNow: true });
    expect(h.templateUpdate.mock.calls[0][0].data).toEqual({ name: "Renamed" });
  });

  it("a request that does not mention the switch never calls the service", async () => {
    await patch({ name: "Renamed" });
    expect(h.setAuto).not.toHaveBeenCalled();
  });

  it("the retired tag is ignored if an old page still sends it", async () => {
    await patch({ name: "Renamed", autoIssueTag: "Cme" });
    expect(h.templateUpdate.mock.calls[0][0].data).toEqual({ name: "Renamed" });
  });
});
