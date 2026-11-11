/**
 * certificate-assignment-service: the decisions, against a recording fake.
 * (What the SQL does, the lock and the sweep round trip are proven on a real
 * Postgres in tests/integration-db/certificate-assignments.db.test.ts.)
 *
 * Pinned here because they are the parts a refactor could silently lose:
 *   - the per-event lock is the FIRST statement of every write;
 *   - CONFIRM_SEND_NOW writes nothing at all;
 *   - only people who have already answered are handed back to the sweep;
 *   - someone who holds the certificate cannot be unassigned.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const calls: string[] = [];
const h = vi.hoisted(() => ({
  template: vi.fn(),
  templateUpdate: vi.fn(),
  registrations: vi.fn(),
  registrationUpdateMany: vi.fn(),
  speakers: vi.fn(),
  assignments: vi.fn(),
  createMany: vi.fn(),
  deleteMany: vi.fn(),
  certificates: vi.fn(),
  audit: vi.fn(),
  warn: vi.fn(),
  info: vi.fn(),
}));

const tx = {
  $queryRaw: (...a: unknown[]) => {
    calls.push("lock");
    return Promise.resolve(a);
  },
  certificateTemplate: {
    findFirst: (...a: unknown[]) => (calls.push("template"), h.template(...a)),
    update: (...a: unknown[]) => (calls.push("template.update"), h.templateUpdate(...a)),
  },
  registration: {
    findMany: (...a: unknown[]) => (calls.push("registrations"), h.registrations(...a)),
    updateMany: (...a: unknown[]) => (calls.push("reopen"), h.registrationUpdateMany(...a)),
  },
  speaker: { findMany: (...a: unknown[]) => (calls.push("speakers"), h.speakers(...a)) },
  certificateAssignment: {
    findMany: (...a: unknown[]) => (calls.push("assignments"), h.assignments(...a)),
    createMany: (...a: unknown[]) => (calls.push("createMany"), h.createMany(...a)),
    deleteMany: (...a: unknown[]) => (calls.push("deleteMany"), h.deleteMany(...a)),
  },
  issuedCertificate: { findMany: (...a: unknown[]) => (calls.push("certificates"), h.certificates(...a)) },
};

vi.mock("@/lib/db", () => ({
  db: { auditLog: { create: (...a: unknown[]) => h.audit(...a) } },
  tenantTransaction: (cb: (t: typeof tx) => unknown) => cb(tx),
}));
vi.mock("@/lib/logger", () => ({ apiLogger: { info: h.info, warn: h.warn, error: vi.fn() } }));

import {
  assignCertificate,
  setTemplateAutoIssue,
  unassignCertificate,
  MAX_ASSIGNMENT_BATCH,
} from "@/services/certificate-assignment-service";

const TPL = { id: "tpl", eventId: "evt", name: "CME", category: "ATTENDANCE" as const, autoIssueOnSurvey: false };
const base = {
  eventId: "evt",
  organizationId: "org",
  templateId: "tpl",
  userId: "user",
  source: "rest" as const,
  assignmentSource: "MANUAL" as const,
  confirmSendNow: false,
};

/** registration.findMany answers two different questions: who is valid, and who has answered. */
function registrationsAnswer(valid: string[], answered: string[]) {
  h.registrations.mockImplementation((args: { where: { surveyCompletedAt?: unknown } }) =>
    Promise.resolve((args.where.surveyCompletedAt ? answered : valid).map((id) => ({ id }))),
  );
}

beforeEach(() => {
  calls.length = 0;
  Object.values(h).forEach((m) => m.mockReset());
  h.template.mockResolvedValue(TPL);
  h.assignments.mockResolvedValue([]);
  h.certificates.mockResolvedValue([]);
  h.speakers.mockResolvedValue([]);
  h.createMany.mockResolvedValue({ count: 0 });
  h.deleteMany.mockResolvedValue({ count: 0 });
  h.registrationUpdateMany.mockResolvedValue({ count: 0 });
  h.templateUpdate.mockResolvedValue({});
  h.audit.mockResolvedValue({});
  registrationsAnswer(["r1", "r2"], []);
});

describe("assignCertificate", () => {
  it("takes the lock first, then reads, then writes", async () => {
    const res = await assignCertificate({ ...base, registrationIds: ["r1", "r2"] });
    expect(res).toMatchObject({ ok: true, assigned: 2, alreadyAssigned: 0, skipped: 0, sendNow: 0 });
    expect(calls[0]).toBe("lock");
    expect(calls.indexOf("template")).toBe(1);
    expect(calls.indexOf("createMany")).toBeGreaterThan(calls.indexOf("assignments"));
  });

  it("stamps each row with the event's organisation, the source and who assigned", async () => {
    registrationsAnswer(["r1"], []);
    await assignCertificate({ ...base, registrationIds: ["r1"], assignmentSource: "EMAIL_LIST" });
    const { data, skipDuplicates } = h.createMany.mock.calls[0][0];
    expect(skipDuplicates).toBe(true);
    expect(data[0]).toEqual({
      eventId: "evt",
      organizationId: "org",
      certificateTemplateId: "tpl",
      registrationId: "r1",
      speakerId: null,
      source: "EMAIL_LIST",
      assignedByUserId: "user",
    });
  });

  it("only this event's people who are not cancelled are considered", async () => {
    await assignCertificate({ ...base, registrationIds: ["r1", "r2", "r-foreign"] });
    expect(h.registrations.mock.calls[0][0].where).toEqual({
      id: { in: ["r1", "r2", "r-foreign"] },
      eventId: "evt",
      status: { not: "CANCELLED" },
    });
  });

  it("leaves people already on the list alone and counts the ids it could not use", async () => {
    h.assignments.mockResolvedValue([{ registrationId: "r1", speakerId: null }]);
    const res = await assignCertificate({ ...base, registrationIds: ["r1", "r2", "r-gone"] });
    expect(res).toMatchObject({ ok: true, assigned: 1, alreadyAssigned: 1, skipped: 1 });
    expect(h.createMany.mock.calls[0][0].data.map((d: { registrationId: string }) => d.registrationId)).toEqual(["r2"]);
  });

  it("with nothing new to add it writes nothing and records nothing", async () => {
    h.assignments.mockResolvedValue([{ registrationId: "r1", speakerId: null }, { registrationId: "r2", speakerId: null }]);
    const res = await assignCertificate({ ...base, registrationIds: ["r1", "r2"] });
    expect(res).toMatchObject({ ok: true, assigned: 0, alreadyAssigned: 2 });
    expect(h.createMany).not.toHaveBeenCalled();
    expect(h.audit).not.toHaveBeenCalled();
  });

  it("CONFIRM_SEND_NOW: an auto-issue template and people who already answered writes NOTHING until confirmed", async () => {
    h.template.mockResolvedValue({ ...TPL, autoIssueOnSurvey: true });
    registrationsAnswer(["r1", "r2"], ["r1"]);

    const refused = await assignCertificate({ ...base, registrationIds: ["r1", "r2"] });
    expect(refused).toMatchObject({ ok: false, code: "CONFIRM_SEND_NOW", meta: { sendNow: 1, assigned: 2, templateName: "CME" } });
    expect(h.createMany).not.toHaveBeenCalled();
    expect(h.registrationUpdateMany).not.toHaveBeenCalled();
    expect(h.audit).not.toHaveBeenCalled();
    expect(h.warn).toHaveBeenCalledWith(expect.objectContaining({ msg: "cert-assignment:assign-rejected", code: "CONFIRM_SEND_NOW" }));
  });

  it("confirmed: writes the rows and hands back to the sweep ONLY the people who answered", async () => {
    h.template.mockResolvedValue({ ...TPL, autoIssueOnSurvey: true });
    registrationsAnswer(["r1", "r2"], ["r1"]);

    const res = await assignCertificate({ ...base, registrationIds: ["r1", "r2"], confirmSendNow: true });
    expect(res).toMatchObject({ ok: true, assigned: 2, sendNow: 1 });
    expect(h.registrationUpdateMany).toHaveBeenCalledTimes(1);
    const reopen = h.registrationUpdateMany.mock.calls[0][0];
    expect(reopen.where.id).toEqual({ in: ["r1"] });
    expect(reopen.data).toEqual({
      certAutoIssueCheckedAt: null,
      certAutoIssueAttempts: 0,
      certAutoIssueNextAttemptAt: null,
      certAutoIssueError: null,
    });
    // After the rows exist, inside the same transaction.
    expect(calls.indexOf("reopen")).toBeGreaterThan(calls.indexOf("createMany"));
  });

  it("the answered check asks what the sweep asks: answered, not cancelled, and not already holding this certificate", async () => {
    h.template.mockResolvedValue({ ...TPL, autoIssueOnSurvey: true });
    registrationsAnswer(["r1"], []);
    await assignCertificate({ ...base, registrationIds: ["r1"], confirmSendNow: true });
    const answeredQuery = h.registrations.mock.calls.find((c) => c[0].where.surveyCompletedAt)![0];
    expect(answeredQuery.where).toEqual({
      id: { in: ["r1"] },
      eventId: "evt",
      surveyCompletedAt: { not: null },
      status: { not: "CANCELLED" },
      issuedCertificates: { none: { certificateTemplateId: "tpl" } },
    });
  });

  it("a template that does not auto-issue never asks and never re-opens anyone", async () => {
    registrationsAnswer(["r1"], ["r1"]);
    const res = await assignCertificate({ ...base, registrationIds: ["r1"] });
    expect(res).toMatchObject({ ok: true, assigned: 1, sendNow: 0 });
    expect(h.registrationUpdateMany).not.toHaveBeenCalled();
  });

  it("a dry run reports the same numbers and writes nothing, even when confirmation would be needed", async () => {
    h.template.mockResolvedValue({ ...TPL, autoIssueOnSurvey: true });
    registrationsAnswer(["r1", "r2"], ["r1"]);
    const res = await assignCertificate({ ...base, registrationIds: ["r1", "r2"], dryRun: true });
    expect(res).toMatchObject({ ok: true, dryRun: true, assigned: 2, sendNow: 1 });
    expect(h.createMany).not.toHaveBeenCalled();
    expect(h.registrationUpdateMany).not.toHaveBeenCalled();
    expect(h.audit).not.toHaveBeenCalled();
  });

  it("refuses the wrong kind of person for the template's category", async () => {
    expect(await assignCertificate({ ...base, speakerIds: ["s1"] })).toMatchObject({ ok: false, code: "WRONG_RECIPIENT_TYPE" });
    h.template.mockResolvedValue({ ...TPL, category: "APPRECIATION" });
    expect(await assignCertificate({ ...base, registrationIds: ["r1"] })).toMatchObject({ ok: false, code: "WRONG_RECIPIENT_TYPE" });
    expect(h.createMany).not.toHaveBeenCalled();
  });

  it("refuses an unknown template, nobody, and too many, without opening a transaction for the last two", async () => {
    h.template.mockResolvedValue(null);
    expect(await assignCertificate({ ...base, registrationIds: ["r1"] })).toMatchObject({ ok: false, code: "TEMPLATE_NOT_FOUND" });
    calls.length = 0;
    expect(await assignCertificate({ ...base })).toMatchObject({ ok: false, code: "NO_RECIPIENTS" });
    const many = Array.from({ length: MAX_ASSIGNMENT_BATCH + 1 }, (_, i) => `r${i}`);
    expect(await assignCertificate({ ...base, registrationIds: many })).toMatchObject({ ok: false, code: "TOO_MANY" });
    expect(calls).toEqual([]);
  });

  it("writes one audit row naming the people, capped, with the caller's source", async () => {
    const ids = Array.from({ length: 250 }, (_, i) => `r${i}`);
    registrationsAnswer(ids, []);
    await assignCertificate({ ...base, registrationIds: ids, source: "mcp", assignmentSource: "AGENT" });
    const audit = h.audit.mock.calls[0][0].data;
    expect(audit).toMatchObject({ eventId: "evt", userId: "user", action: "CERTIFICATE_ASSIGNED", entityType: "CertificateTemplate", entityId: "tpl" });
    expect(audit.changes).toMatchObject({ source: "mcp", assignmentSource: "AGENT", assigned: 250, templateName: "CME" });
    expect(audit.changes.registrationIds).toHaveLength(200);
  });

  it("an appreciation template is assigned to speakers, and re-opens the registrations that carry the survey to them", async () => {
    h.template.mockResolvedValue({ ...TPL, category: "APPRECIATION", autoIssueOnSurvey: true });
    // Valid speakers, then the same speakers again for the survey link.
    h.speakers.mockImplementation((args: { select: Record<string, unknown> }) =>
      Promise.resolve(
        args.select.sourceRegistrationId
          ? [
              { id: "s1", email: "a@x.com", sourceRegistrationId: "r-companion" },
              { id: "s2", email: "b@x.com", sourceRegistrationId: null },
            ]
          : [{ id: "s1" }, { id: "s2" }],
      ),
    );
    // s1 through the pointer; s2 through the same address; both answered.
    h.registrations.mockResolvedValue([
      { id: "r-companion", attendee: { email: "other@x.com" } },
      { id: "r-self", attendee: { email: "b@x.com" } },
    ]);
    // s2 already holds this certificate: nothing to send them.
    h.certificates.mockResolvedValue([{ speakerId: "s2" }]);

    const res = await assignCertificate({ ...base, speakerIds: ["s1", "s2"], confirmSendNow: true });
    expect(res).toMatchObject({ ok: true, assigned: 2, sendNow: 1 });
    expect(h.createMany.mock.calls[0][0].data.map((d: { speakerId: string; registrationId: null }) => [d.speakerId, d.registrationId])).toEqual([
      ["s1", null],
      ["s2", null],
    ]);
    expect(h.registrationUpdateMany.mock.calls[0][0].where.id).toEqual({ in: ["r-companion"] });
  });
});

describe("unassignCertificate", () => {
  it("removes the rows of people who do not hold the certificate and keeps the others", async () => {
    h.assignments.mockResolvedValue([
      { id: "a1", registrationId: "r1", speakerId: null },
      { id: "a2", registrationId: "r2", speakerId: null },
    ]);
    h.certificates.mockResolvedValue([{ registrationId: "r1", speakerId: null }]);

    const res = await unassignCertificate({ eventId: "evt", templateId: "tpl", registrationIds: ["r1", "r2"], userId: "user", source: "rest" });
    expect(res).toEqual({ ok: true, templateName: "CME", removed: 1, keptIssued: 1 });
    expect(calls[0]).toBe("lock");
    expect(h.deleteMany.mock.calls[0][0].where).toEqual({ id: { in: ["a2"] } });
    // A revoked certificate does not keep anyone on the list.
    expect(h.certificates.mock.calls[0][0].where.revokedAt).toBeNull();
    expect(h.audit.mock.calls[0][0].data).toMatchObject({ action: "CERTIFICATE_UNASSIGNED", changes: { removed: 1, keptIssued: 1, registrationIds: ["r2"] } });
  });

  it("deletes nothing and records nothing when everyone asked for holds the certificate", async () => {
    h.assignments.mockResolvedValue([{ id: "a1", registrationId: "r1", speakerId: null }]);
    h.certificates.mockResolvedValue([{ registrationId: "r1", speakerId: null }]);
    const res = await unassignCertificate({ eventId: "evt", templateId: "tpl", registrationIds: ["r1"], userId: "user", source: "rest" });
    expect(res).toMatchObject({ ok: true, removed: 0, keptIssued: 1 });
    expect(h.deleteMany).not.toHaveBeenCalled();
    expect(h.audit).not.toHaveBeenCalled();
  });

  it("refuses an unknown template and an empty request", async () => {
    h.template.mockResolvedValue(null);
    expect(await unassignCertificate({ eventId: "evt", templateId: "x", registrationIds: ["r1"], userId: "user", source: "rest" }))
      .toMatchObject({ ok: false, code: "TEMPLATE_NOT_FOUND" });
    expect(await unassignCertificate({ eventId: "evt", templateId: "tpl", userId: "user", source: "rest" }))
      .toMatchObject({ ok: false, code: "NO_RECIPIENTS" });
  });
});

describe("setTemplateAutoIssue", () => {
  const input = { eventId: "evt", templateId: "tpl", userId: "user", source: "rest" as const, confirmSendNow: false };

  it("turning it ON with assigned people who already answered is refused, and the switch stays off", async () => {
    h.assignments.mockResolvedValue([{ registrationId: "r1", speakerId: null }, { registrationId: "r2", speakerId: null }]);
    registrationsAnswer([], ["r1"]);
    const res = await setTemplateAutoIssue({ ...input, enabled: true });
    expect(res).toMatchObject({ ok: false, code: "CONFIRM_SEND_NOW", meta: { sendNow: 1 } });
    expect(h.templateUpdate).not.toHaveBeenCalled();
    expect(h.registrationUpdateMany).not.toHaveBeenCalled();
    expect(calls[0]).toBe("lock");
  });

  it("confirmed: flips the switch and re-opens the people who answered, in one transaction", async () => {
    h.assignments.mockResolvedValue([{ registrationId: "r1", speakerId: null }, { registrationId: "r2", speakerId: null }]);
    registrationsAnswer([], ["r1"]);
    const res = await setTemplateAutoIssue({ ...input, enabled: true, confirmSendNow: true });
    expect(res).toEqual({ ok: true, changed: true, sendNow: 1 });
    expect(h.templateUpdate.mock.calls[0][0]).toEqual({ where: { id: "tpl" }, data: { autoIssueOnSurvey: true } });
    expect(h.registrationUpdateMany.mock.calls[0][0].where.id).toEqual({ in: ["r1"] });
    expect(h.audit.mock.calls[0][0].data).toMatchObject({ action: "CERTIFICATE_AUTO_ISSUE_ON", changes: { sendNow: 1 } });
  });

  it("only LIVE assignments count: a cancelled registration's row is not asked about", async () => {
    await setTemplateAutoIssue({ ...input, enabled: true });
    expect(h.assignments.mock.calls[0][0].where).toEqual({
      certificateTemplateId: "tpl",
      OR: [{ speakerId: { not: null } }, { registration: { status: { not: "CANCELLED" } } }],
    });
  });

  it("turns on without a question when nobody assigned has answered", async () => {
    h.assignments.mockResolvedValue([{ registrationId: "r1", speakerId: null }]);
    registrationsAnswer([], []);
    expect(await setTemplateAutoIssue({ ...input, enabled: true })).toEqual({ ok: true, changed: true, sendNow: 0 });
  });

  it("turning it OFF never asks; setting it to what it already is changes nothing", async () => {
    h.template.mockResolvedValue({ ...TPL, autoIssueOnSurvey: true });
    expect(await setTemplateAutoIssue({ ...input, enabled: false })).toEqual({ ok: true, changed: true, sendNow: 0 });
    expect(h.templateUpdate.mock.calls[0][0].data).toEqual({ autoIssueOnSurvey: false });
    expect(h.assignments).not.toHaveBeenCalled();

    h.templateUpdate.mockClear();
    h.audit.mockClear();
    expect(await setTemplateAutoIssue({ ...input, enabled: true })).toEqual({ ok: true, changed: false, sendNow: 0 });
    expect(h.templateUpdate).not.toHaveBeenCalled();
    expect(h.audit).not.toHaveBeenCalled();
  });

  it("an unknown template is refused", async () => {
    h.template.mockResolvedValue(null);
    expect(await setTemplateAutoIssue({ ...input, enabled: true })).toMatchObject({ ok: false, code: "TEMPLATE_NOT_FOUND" });
  });
});
