/**
 * The agent's certificate tools and "send now" (review of 631e95bd, H2).
 *
 * assign_certificate and update_certificate_template ask
 * certificates.templates.manage, which an organisation API key holds. Either
 * can email certificates to people who have already answered the survey, and
 * that is certificates.issue, which no API key holds. The tools therefore tell
 * the service whether the CALLER may send (mayReleaseNow), from the principal
 * the door hands them, and pass the confirmation only as the number agreed.
 *
 * The permission tables are real here; only the service and the database are faked.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  assign: vi.fn(),
  setAuto: vi.fn(),
  eventFindFirst: vi.fn(),
  templateFindFirst: vi.fn(),
  templateUpdate: vi.fn(),
}));

vi.mock("@/lib/logger", () => ({ apiLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock("@/lib/db", () => ({
  db: {
    event: { findFirst: (...a: unknown[]) => h.eventFindFirst(...a) },
    certificateTemplate: {
      findFirst: (...a: unknown[]) => h.templateFindFirst(...a),
      update: (...a: unknown[]) => h.templateUpdate(...a),
    },
    auditLog: { create: () => Promise.resolve({}) },
  },
  tenantTransaction: (cb: (tx: unknown) => unknown) => cb({}),
}));
vi.mock("@/services/certificate-assignment-service", () => ({
  assignCertificate: (...a: unknown[]) => h.assign(...a),
  unassignCertificate: vi.fn(),
  resolveAssignmentEmails: vi.fn(),
  setTemplateAutoIssue: (...a: unknown[]) => h.setAuto(...a),
}));

import { CERTIFICATE_EXECUTORS } from "@/lib/agent/tools/certificates";
import { principalFromApiKey } from "@/lib/permissions/require-permission";
import { principalFromUser } from "@/lib/permissions/can";
import type { AgentContext } from "@/lib/agent/tools/_shared";

const ctx = (principal?: AgentContext["principal"]): AgentContext => ({
  eventId: "evt-1",
  organizationId: "org-1",
  userId: "user-1",
  source: "mcp",
  counters: { creates: 0, emailsSent: 0 },
  principal,
});
const apiKey = principalFromApiKey("org-1");
const admin = principalFromUser({ id: "user-1", role: "ADMIN", organizationId: "org-1" });

beforeEach(() => {
  Object.values(h).forEach((m) => m.mockReset());
  // The tool's own event lookup, and the event-facts read behind the permission check.
  h.eventFindFirst.mockResolvedValue({ id: "evt-1", organizationId: "org-1", eventType: "CONFERENCE", staffAssignments: [] });
  h.templateFindFirst.mockResolvedValue({ id: "tpl", eventId: "evt-1", category: "ATTENDANCE" });
  h.templateUpdate.mockResolvedValue({ id: "tpl" });
  h.assign.mockResolvedValue({ ok: true, templateName: "CME", assigned: 1, alreadyAssigned: 0, skipped: 0, sendNow: 0, sendNowPeople: 0, sendNowByTemplate: [], sendNowAllowed: false, dryRun: false });
  h.setAuto.mockResolvedValue({ ok: true, changed: true, sendNow: 0 });
});

describe("assign_certificate", () => {
  const run = (input: Record<string, unknown>, c: AgentContext) => CERTIFICATE_EXECUTORS.assign_certificate(input, c);

  it("an API key assigns, but is never allowed to send now, whatever it passes as confirmation", async () => {
    await run({ templateId: "tpl", registrationIds: ["r1"], confirmSendNow: 300 }, ctx(apiKey));
    expect(h.assign.mock.calls[0][0]).toMatchObject({ mayReleaseNow: false, confirmedSendNow: 300, assignmentSource: "AGENT", source: "mcp" });
  });

  it("a person who holds certificates.issue may", async () => {
    await run({ templateId: "tpl", registrationIds: ["r1"] }, ctx(admin));
    expect(h.assign.mock.calls[0][0]).toMatchObject({ mayReleaseNow: true, confirmedSendNow: undefined });
  });

  it("a door that hands over no principal cannot send: fail closed", async () => {
    await run({ templateId: "tpl", registrationIds: ["r1"], confirmSendNow: 1 }, ctx(undefined));
    expect(h.assign.mock.calls[0][0]).toMatchObject({ mayReleaseNow: false });
  });

  it("`confirmSendNow: true` (what a client holding the old tool list sends) confirms nothing", async () => {
    await run({ templateId: "tpl", registrationIds: ["r1"], confirmSendNow: true }, ctx(admin));
    expect(h.assign.mock.calls[0][0].confirmedSendNow).toBeUndefined();
    await run({ templateId: "tpl", registrationIds: ["r1"], confirmSendNow: "3" }, ctx(admin));
    expect(h.assign.mock.calls[1][0].confirmedSendNow).toBeUndefined();
  });

  it("hands the model the refusal with its count, and tells it to pass the number back", async () => {
    h.assign.mockResolvedValue({
      ok: false,
      code: "CONFIRM_SEND_NOW",
      message: "1 person has already answered the survey, so 2 certificates will be emailed now: CME Day 1 (1), CME Day 2 (1). That includes certificates from other templates they were already owed.",
      meta: { sendNow: 2, sendNowPeople: 1 },
    });
    const res = (await run({ templateId: "tpl", registrationIds: ["r1"] }, ctx(admin))) as { error: string; code: string; sendNow: number };
    expect(res.code).toBe("CONFIRM_SEND_NOW");
    expect(res.sendNow).toBe(2);
    expect(res.error).toContain("confirmSendNow set to that number");
    expect(res.error).not.toContain("confirmSendNow: true");
  });

  it("SEND_NOW_NOT_PERMITTED comes back as it is, with no invitation to confirm", async () => {
    h.assign.mockResolvedValue({ ok: false, code: "SEND_NOW_NOT_PERMITTED", message: "Sending certificates needs the Issue certificates permission.", meta: { sendNow: 1 } });
    const res = (await run({ templateId: "tpl", registrationIds: ["r1"] }, ctx(apiKey))) as { error: string; code: string };
    expect(res.code).toBe("SEND_NOW_NOT_PERMITTED");
    expect(res.error).not.toContain("confirmSendNow");
  });
});

describe("update_certificate_template: the auto-issue switch", () => {
  const run = (input: Record<string, unknown>, c: AgentContext) => CERTIFICATE_EXECUTORS.update_certificate_template(input, c);

  it("an API key turning the switch on is not allowed to send now", async () => {
    await run({ templateId: "tpl", autoIssueOnSurvey: true, confirmSendNow: 50 }, ctx(apiKey));
    expect(h.setAuto.mock.calls[0][0]).toMatchObject({ enabled: true, mayReleaseNow: false, confirmedSendNow: 50 });
  });

  it("an admin may, with the count they agreed to", async () => {
    await run({ templateId: "tpl", autoIssueOnSurvey: true, confirmSendNow: 4 }, ctx(admin));
    expect(h.setAuto.mock.calls[0][0]).toMatchObject({ enabled: true, mayReleaseNow: true, confirmedSendNow: 4 });
  });

  it("a refused switch stops the rest of the update", async () => {
    h.setAuto.mockResolvedValue({ ok: false, code: "SEND_NOW_NOT_PERMITTED", message: "no", meta: { sendNow: 3 } });
    const res = (await run({ templateId: "tpl", autoIssueOnSurvey: true, name: "Renamed" }, ctx(apiKey))) as { code: string };
    expect(res.code).toBe("SEND_NOW_NOT_PERMITTED");
    expect(h.templateUpdate).not.toHaveBeenCalled();
  });
});
