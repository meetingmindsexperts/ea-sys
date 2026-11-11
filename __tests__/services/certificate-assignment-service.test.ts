/**
 * certificate-assignment-service: the decisions, against a recording fake.
 * (What the SQL does, the lock and the sweep round trip are proven on a real
 * Postgres in tests/integration-db/certificate-assignments.db.test.ts.)
 *
 * Pinned here because they are the parts a refactor could silently lose:
 *   - the per-event lock is the FIRST statement of every write;
 *   - CONFIRM_SEND_NOW and SEND_NOW_NOT_PERMITTED roll everything back;
 *   - the count is the sweep's own plan (planSurveyReleases, faked here):
 *     every certificate re-opening sends, other templates included, and a
 *     confirmed number smaller than that is asked again;
 *   - sending now needs mayReleaseNow (certificates.issue);
 *   - only registrations with something to send are handed back to the sweep;
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
  plan: vi.fn(),
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
  // A thrown error is a rollback: recorded, so a test can tell "written then undone" from "kept".
  tenantTransaction: async (cb: (t: typeof tx) => unknown) => {
    try {
      return await cb(tx);
    } catch (err) {
      calls.push("rollback");
      throw err;
    }
  },
}));
// The sweep's plan is faked (its SQL is proven on Postgres); summarizeRelease stays real.
vi.mock("@/lib/certificates/survey-release", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/certificates/survey-release")>()),
  planSurveyReleases: (...a: unknown[]) => (calls.push("plan"), h.plan(...a)),
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
  mayReleaseNow: true,
};

const AUTO_TEMPLATES = [
  { id: "tpl", name: "CME", category: "ATTENDANCE" as const },
  { id: "tpl-day1", name: "CME Day 1", category: "ATTENDANCE" as const },
  { id: "tpl-spk", name: "Faculty", category: "APPRECIATION" as const },
];

/**
 * What the sweep would send each registration. `owed` maps a registration to
 * the template ids it is owed; a speaker target is written "spk:<template>@<speakerId>".
 */
function planOwes(owed: Record<string, string[]>) {
  h.plan.mockImplementation((_tx: unknown, _eventId: string, ids: string[]) =>
    Promise.resolve({
      autoIssueTemplates: AUTO_TEMPLATES,
      byRegistration: new Map(
        ids.map((id) => {
          const entries = owed[id] ?? [];
          const speakerEntry = entries.find((e) => e.startsWith("spk:"));
          const speakerId = speakerEntry ? speakerEntry.split("@")[1] : null;
          return [
            id,
            {
              registrationId: id,
              speaker: speakerId ? { id: speakerId, title: null, firstName: "S", lastName: "P", email: null } : null,
              targets: entries.map((e) =>
                e.startsWith("spk:")
                  ? { templateId: e.slice(4).split("@")[0], category: "APPRECIATION" as const, recipient: "speaker" as const }
                  : { templateId: e, category: "ATTENDANCE" as const, recipient: "registration" as const },
              ),
            },
          ];
        }),
      ),
    }),
  );
}

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
  planOwes({});
});

describe("assignCertificate", () => {
  it("takes the lock first, then reads, then writes", async () => {
    const res = await assignCertificate({ ...base, registrationIds: ["r1", "r2"] });
    expect(res).toMatchObject({ ok: true, assigned: 2, alreadyAssigned: 0, skipped: 0, sendNow: 0 });
    expect(calls[0]).toBe("lock");
    expect(calls.indexOf("template")).toBe(1);
    expect(calls.indexOf("createMany")).toBeGreaterThan(calls.indexOf("assignments"));
    expect(calls).not.toContain("rollback");
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

  it("CONFIRM_SEND_NOW: people who already answered an auto-issue template roll back EVERYTHING until confirmed", async () => {
    h.template.mockResolvedValue({ ...TPL, autoIssueOnSurvey: true });
    registrationsAnswer(["r1", "r2"], ["r1"]);
    planOwes({ r1: ["tpl"] });

    const refused = await assignCertificate({ ...base, registrationIds: ["r1", "r2"] });
    expect(refused).toMatchObject({
      ok: false,
      code: "CONFIRM_SEND_NOW",
      meta: { sendNow: 1, sendNowPeople: 1, assigned: 2, templateName: "CME" },
    });
    expect(calls).toContain("rollback");
    expect(h.registrationUpdateMany).not.toHaveBeenCalled();
    expect(h.audit).not.toHaveBeenCalled();
    expect(h.warn).toHaveBeenCalledWith(expect.objectContaining({ msg: "cert-assignment:assign-rejected", code: "CONFIRM_SEND_NOW" }));
    // The plan is read AFTER the rows exist, so it sees them.
    expect(calls.indexOf("plan")).toBeGreaterThan(calls.indexOf("createMany"));
  });

  it("H1: the count includes the other auto-issue certificates the same people were already owed", async () => {
    h.template.mockResolvedValue({ ...TPL, autoIssueOnSurvey: true });
    registrationsAnswer(["r1"], ["r1"]);
    // Dr Y answered before the deploy and was carried over onto Day 1 (READY): re-opening
    // her for "CME" sends Day 1 too.
    planOwes({ r1: ["tpl", "tpl-day1"] });

    const refused = await assignCertificate({ ...base, registrationIds: ["r1"] });
    expect(refused).toMatchObject({ ok: false, code: "CONFIRM_SEND_NOW", meta: { sendNow: 2, sendNowPeople: 1 } });
    if (refused.ok) throw new Error("expected a refusal");
    expect(refused.message).toContain("2 certificates");
    expect(refused.message).toContain("CME Day 1 (1)");
    expect(refused.message).toContain("other templates");

    // Agreeing to the 1 that "CME" alone would be is not agreeing to 2.
    const tooFew = await assignCertificate({ ...base, registrationIds: ["r1"], confirmedSendNow: 1 });
    expect(tooFew).toMatchObject({ ok: false, code: "CONFIRM_SEND_NOW", meta: { sendNow: 2 } });
    expect(h.registrationUpdateMany).not.toHaveBeenCalled();

    const ok = await assignCertificate({ ...base, registrationIds: ["r1"], confirmedSendNow: 2 });
    expect(ok).toMatchObject({ ok: true, sendNow: 2, sendNowPeople: 1 });
    expect(h.registrationUpdateMany.mock.calls[0][0].where.id).toEqual({ in: ["r1"] });
  });

  it("confirmed: hands back to the sweep ONLY the registrations with something to send", async () => {
    h.template.mockResolvedValue({ ...TPL, autoIssueOnSurvey: true });
    registrationsAnswer(["r1", "r2"], ["r1", "r2"]);
    // r2 already holds it, or a run is already sending it: nothing to send.
    planOwes({ r1: ["tpl"], r2: [] });

    const res = await assignCertificate({ ...base, registrationIds: ["r1", "r2"], confirmedSendNow: 1 });
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
    expect(calls.indexOf("reopen")).toBeGreaterThan(calls.indexOf("createMany"));
    expect(calls).not.toContain("rollback");
  });

  it("asks the plan about the registrations that answered, and only those", async () => {
    h.template.mockResolvedValue({ ...TPL, autoIssueOnSurvey: true });
    registrationsAnswer(["r1", "r2"], ["r2"]);
    await assignCertificate({ ...base, registrationIds: ["r1", "r2"] });
    const answeredQuery = h.registrations.mock.calls.find((c) => c[0].where.surveyCompletedAt)![0];
    expect(answeredQuery.where).toEqual({
      id: { in: ["r1", "r2"] },
      eventId: "evt",
      surveyCompletedAt: { not: null },
      status: { not: "CANCELLED" },
    });
    expect(h.plan.mock.calls[0][1]).toBe("evt");
    expect(h.plan.mock.calls[0][2]).toEqual(["r2"]);
  });

  it("a template that does not auto-issue never asks, never plans and never re-opens anyone", async () => {
    registrationsAnswer(["r1"], ["r1"]);
    planOwes({ r1: ["tpl-day1"] });
    const res = await assignCertificate({ ...base, registrationIds: ["r1"] });
    expect(res).toMatchObject({ ok: true, assigned: 1, sendNow: 0 });
    expect(h.plan).not.toHaveBeenCalled();
    expect(h.registrationUpdateMany).not.toHaveBeenCalled();
  });

  it("H2: without certificates.issue a send-now is refused and rolled back, whatever was confirmed", async () => {
    h.template.mockResolvedValue({ ...TPL, autoIssueOnSurvey: true });
    registrationsAnswer(["r1"], ["r1"]);
    planOwes({ r1: ["tpl"] });
    const res = await assignCertificate({ ...base, registrationIds: ["r1"], mayReleaseNow: false, confirmedSendNow: 99 });
    expect(res).toMatchObject({ ok: false, code: "SEND_NOW_NOT_PERMITTED", meta: { sendNow: 1 } });
    if (res.ok) throw new Error("expected a refusal");
    expect(res.message).toContain("Issue certificates permission");
    expect(calls).toContain("rollback");
    expect(h.registrationUpdateMany).not.toHaveBeenCalled();
    expect(h.audit).not.toHaveBeenCalled();
  });

  it("H2: without certificates.issue, assigning people who have NOT answered still works (it sends nothing now)", async () => {
    h.template.mockResolvedValue({ ...TPL, autoIssueOnSurvey: true });
    registrationsAnswer(["r1"], []);
    const res = await assignCertificate({ ...base, registrationIds: ["r1"], mayReleaseNow: false });
    expect(res).toMatchObject({ ok: true, assigned: 1, sendNow: 0, sendNowAllowed: false });
    expect(calls).not.toContain("rollback");
  });

  it("a dry run reports the plan's numbers, then rolls back, even when confirmation would be needed", async () => {
    h.template.mockResolvedValue({ ...TPL, autoIssueOnSurvey: true });
    registrationsAnswer(["r1", "r2"], ["r1"]);
    planOwes({ r1: ["tpl", "tpl-day1"] });
    const res = await assignCertificate({ ...base, registrationIds: ["r1", "r2"], dryRun: true, mayReleaseNow: false });
    expect(res).toMatchObject({
      ok: true,
      dryRun: true,
      assigned: 2,
      sendNow: 2,
      sendNowPeople: 1,
      sendNowAllowed: false,
      sendNowByTemplate: [
        { templateId: "tpl", templateName: "CME", count: 1 },
        { templateId: "tpl-day1", templateName: "CME Day 1", count: 1 },
      ],
    });
    expect(calls).toContain("rollback");
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

  it("an appreciation template is assigned to speakers, and asks the plan about the registrations that carry the survey to them", async () => {
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
    // The sweep routes r-self to some other speaker, so only s1 is sent anything.
    planOwes({ "r-companion": ["spk:tpl@s1"], "r-self": [] });

    const res = await assignCertificate({ ...base, speakerIds: ["s1", "s2"], confirmedSendNow: 1 });
    expect(res).toMatchObject({ ok: true, assigned: 2, sendNow: 1 });
    expect(h.createMany.mock.calls[0][0].data.map((d: { speakerId: string; registrationId: null }) => [d.speakerId, d.registrationId])).toEqual([
      ["s1", null],
      ["s2", null],
    ]);
    expect([...h.plan.mock.calls[0][2]].sort()).toEqual(["r-companion", "r-self"]);
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
  const input = { eventId: "evt", templateId: "tpl", userId: "user", source: "rest" as const, mayReleaseNow: true };

  it("turning it ON with assigned people who already answered is refused, and rolled back: the switch stays off", async () => {
    h.assignments.mockResolvedValue([{ registrationId: "r1", speakerId: null }, { registrationId: "r2", speakerId: null }]);
    registrationsAnswer([], ["r1"]);
    planOwes({ r1: ["tpl"] });
    const res = await setTemplateAutoIssue({ ...input, enabled: true });
    expect(res).toMatchObject({ ok: false, code: "CONFIRM_SEND_NOW", meta: { sendNow: 1 } });
    expect(calls).toContain("rollback");
    expect(h.registrationUpdateMany).not.toHaveBeenCalled();
    expect(calls[0]).toBe("lock");
    // Switched on BEFORE the plan is read, so the plan counts this template.
    expect(calls.indexOf("template.update")).toBeLessThan(calls.indexOf("plan"));
  });

  it("confirmed with the count: keeps the switch on and re-opens the people with something to send", async () => {
    h.assignments.mockResolvedValue([{ registrationId: "r1", speakerId: null }, { registrationId: "r2", speakerId: null }]);
    registrationsAnswer([], ["r1"]);
    planOwes({ r1: ["tpl"] });
    const res = await setTemplateAutoIssue({ ...input, enabled: true, confirmedSendNow: 1 });
    expect(res).toEqual({ ok: true, changed: true, sendNow: 1 });
    expect(h.templateUpdate.mock.calls[0][0]).toEqual({ where: { id: "tpl" }, data: { autoIssueOnSurvey: true } });
    expect(h.registrationUpdateMany.mock.calls[0][0].where.id).toEqual({ in: ["r1"] });
    expect(calls).not.toContain("rollback");
    expect(h.audit.mock.calls[0][0].data).toMatchObject({ action: "CERTIFICATE_AUTO_ISSUE_ON", changes: { sendNow: 1 } });
  });

  it("H2: without certificates.issue, turning it on would send now, so it is refused and rolled back", async () => {
    h.assignments.mockResolvedValue([{ registrationId: "r1", speakerId: null }]);
    registrationsAnswer([], ["r1"]);
    planOwes({ r1: ["tpl"] });
    const res = await setTemplateAutoIssue({ ...input, enabled: true, mayReleaseNow: false, confirmedSendNow: 5 });
    expect(res).toMatchObject({ ok: false, code: "SEND_NOW_NOT_PERMITTED" });
    expect(calls).toContain("rollback");
    expect(h.registrationUpdateMany).not.toHaveBeenCalled();
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
    expect(await setTemplateAutoIssue({ ...input, enabled: true, mayReleaseNow: false })).toEqual({ ok: true, changed: true, sendNow: 0 });
    expect(calls).not.toContain("rollback");
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
