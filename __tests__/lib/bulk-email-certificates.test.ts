/**
 * executeCertificateBulkSend (bulk-issue.ts) — the Communications → bulk
 * email → certificate path. Bundle primitives (findOrIssue, bundle send) are
 * mocked; we assert the ORCHESTRATION:
 *   - tag routing (a recipient only gets certs whose template tag they hold,
 *     across BOTH person facets — registration + linked speaker)
 *   - one email per recipient with all applicable certs
 *   - reuse (already-issued) attaches without a new audit row
 *   - per-recipient isolation (zero-match → SKIP, all-fail / send-fail → error)
 *   - custom subject/message override vs per-template/multi defaults
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const {
  mockDb,
  mockFindOrIssue,
  mockBundleSend,
  mockLoadEvent,
  mockLoadBundleCover,
  mockLinkedSpeaker,
  mockLinkedRegistration,
} = vi.hoisted(() => ({
  mockDb: {
    registration: { findUnique: vi.fn() },
    speaker: { findUnique: vi.fn() },
    auditLog: { create: vi.fn().mockResolvedValue({}) },
  },
  mockFindOrIssue: vi.fn(),
  mockBundleSend: vi.fn().mockResolvedValue({ success: true, messageId: "m1" }),
  mockLoadEvent: vi.fn().mockResolvedValue({ name: "OSH" }),
  // null = no per-event bundle template → the hardcoded multi default applies.
  mockLoadBundleCover: vi.fn().mockResolvedValue(null),
  mockLinkedSpeaker: vi.fn().mockResolvedValue(null),
  mockLinkedRegistration: vi.fn().mockResolvedValue(null),
}));

vi.mock("@/lib/logger", () => ({ apiLogger: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock("@/lib/db", () => ({ db: mockDb }));
vi.mock("@/lib/certificates/bundle", () => ({
  findOrIssueCertificate: (args: unknown) => mockFindOrIssue(args),
  sendCertificateBundleEmail: (args: unknown) => mockBundleSend(args),
  loadBundleEmailEvent: (e: string) => mockLoadEvent(e),
  loadBundleCoverEmailTemplate: (e: string) => mockLoadBundleCover(e),
}));
vi.mock("@/lib/activity-feed", () => ({
  resolveLinkedSpeaker: (e: string, r: unknown) => mockLinkedSpeaker(e, r),
  resolveLinkedRegistration: (e: string, s: unknown) => mockLinkedRegistration(e, s),
}));

import { executeCertificateBulkSend } from "@/lib/certificates/bulk-issue";
import type { LoadedCertTemplate } from "@/lib/certificates/bundle";

const ATT_TPL: LoadedCertTemplate = {
  id: "tpl-att",
  name: "Attendance",
  category: "ATTENDANCE",
  autoIssueTag: "attended",
  template: { backgroundPdfUrl: null, textBoxes: [], role: null, cmeHours: null },
  emailSubject: "Att subject",
  emailBody: "<p>Att body</p>",
};
const APP_TPL: LoadedCertTemplate = {
  id: "tpl-app",
  name: "Speaker",
  category: "APPRECIATION",
  autoIssueTag: "speaker",
  template: { backgroundPdfUrl: null, textBoxes: [], role: null, cmeHours: null },
  emailSubject: null,
  emailBody: null,
};

const REG_RECIPIENT = { id: "reg-1", email: "jane@x.com", firstName: "Jane", lastName: "Doe", title: "DR" };

function okCert(templateId: string, serial: string, reused = false) {
  return {
    ok: true as const,
    cert: {
      certificateId: `cert-${serial}`,
      serial,
      type: templateId === "tpl-att" ? ("ATTENDANCE" as const) : ("APPRECIATION" as const),
      templateName: templateId === "tpl-att" ? "Attendance" : "Speaker",
      pdfBuffer: Buffer.from("%PDF"),
      reused,
    },
  };
}

const BASE = {
  eventId: "evt-1",
  recipientType: "registrations" as const,
  recipients: [REG_RECIPIENT],
  templates: [ATT_TPL, APP_TPL],
  organizationId: "org-1",
  triggeredByUserId: "user-1",
};

beforeEach(() => {
  vi.clearAllMocks();
  mockLoadEvent.mockResolvedValue({ name: "OSH" });
  mockLoadBundleCover.mockResolvedValue(null);
  mockBundleSend.mockResolvedValue({ success: true, messageId: "m1" });
  mockLinkedSpeaker.mockResolvedValue(null);
  mockLinkedRegistration.mockResolvedValue(null);
  mockDb.auditLog.create.mockResolvedValue({});
  // Registration with both tags matched via facets by default.
  mockDb.registration.findUnique.mockResolvedValue({
    attendee: { tags: ["attended"], email: "jane@x.com" },
  });
  mockDb.speaker.findUnique.mockResolvedValue({ tags: ["speaker"] });
  mockFindOrIssue.mockImplementation((args: { templateId: string }) =>
    Promise.resolve(okCert(args.templateId, args.templateId === "tpl-att" ? "ATT-1" : "APP-1")),
  );
});

describe("executeCertificateBulkSend", () => {
  it("bundles cross-category certs into ONE email when both facet tags match", async () => {
    mockLinkedSpeaker.mockResolvedValue({ id: "spk-1", linkedBy: "pointer" });
    const res = await executeCertificateBulkSend(BASE);
    expect(res).toMatchObject({ total: 1, successCount: 1, failureCount: 0 });

    // Both templates issued against the right facets of the same person.
    expect(mockFindOrIssue).toHaveBeenCalledTimes(2);
    const calls = mockFindOrIssue.mock.calls.map((c) => c[0]);
    expect(calls).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ templateId: "tpl-att", registrationId: "reg-1", speakerId: "spk-1" }),
        expect.objectContaining({ templateId: "tpl-app", registrationId: "reg-1", speakerId: "spk-1" }),
      ]),
    );

    // ONE email, two certs, multi default cover (2 templates → multi).
    expect(mockBundleSend).toHaveBeenCalledTimes(1);
    const sent = mockBundleSend.mock.calls[0][0];
    expect(sent.certs.map((c: { serial: string }) => c.serial).sort()).toEqual(["APP-1", "ATT-1"]);
    expect(sent.emailSubjectTemplate).toContain("Your certificates");
    expect(sent.recipientName).toBe("Dr. Jane Doe");
    // Split name parts thread through so a saved email template picked as
    // the cover ({{firstName}} greeting) resolves per recipient.
    expect(sent.recipientFirstName).toBe("Jane");
    expect(sent.recipientLastName).toBe("Doe");
  });

  it("tag-filters: recipient with only the attendance tag gets only that cert (its own cover email)", async () => {
    mockDb.registration.findUnique.mockResolvedValue({
      attendee: { tags: ["attended"], email: "jane@x.com" },
    });
    mockLinkedSpeaker.mockResolvedValue(null); // no speaker facet at all
    const res = await executeCertificateBulkSend(BASE);
    expect(res.successCount).toBe(1);
    expect(mockFindOrIssue).toHaveBeenCalledTimes(1);
    expect(mockFindOrIssue.mock.calls[0][0]).toMatchObject({ templateId: "tpl-att" });
    const sent = mockBundleSend.mock.calls[0][0];
    expect(sent.certs).toHaveLength(1);
    // Single template → its saved cover email wins.
    expect(sent.emailSubjectTemplate).toBe("Att subject");
  });

  it("SKIPS (not fails) a recipient when no template tag matches — no tag, no certificate", async () => {
    mockDb.registration.findUnique.mockResolvedValue({
      attendee: { tags: ["something-else"], email: "jane@x.com" },
    });
    const res = await executeCertificateBulkSend(BASE);
    // Tag routing is the rule, not a delivery failure — the audience may be
    // ALL registrations with the tags deciding who receives what. The
    // untagged recipient lands in skippedCount, never in errors.
    expect(res).toMatchObject({ total: 1, successCount: 0, failureCount: 0, skippedCount: 1 });
    expect(res.errors).toHaveLength(0);
    expect(mockBundleSend).not.toHaveBeenCalled();
  });

  it("audits only NEWLY issued certs — a reused cert attaches without an audit row", async () => {
    mockLinkedSpeaker.mockResolvedValue({ id: "spk-1", linkedBy: "email" });
    mockFindOrIssue.mockImplementation((args: { templateId: string }) =>
      Promise.resolve(okCert(args.templateId, args.templateId === "tpl-att" ? "ATT-1" : "APP-1", args.templateId === "tpl-att")),
    );
    const res = await executeCertificateBulkSend(BASE);
    expect(res.successCount).toBe(1);
    // Only the non-reused (APPRECIATION) cert gets a CERT_ISSUED audit.
    expect(mockDb.auditLog.create).toHaveBeenCalledTimes(1);
    expect(mockDb.auditLog.create.mock.calls[0][0].data).toMatchObject({
      action: "CERT_ISSUED",
      changes: expect.objectContaining({ source: "bulk-email", templateId: "tpl-app" }),
    });
  });

  it("sends the certs that DID materialize when one template fails (success + warn)", async () => {
    mockLinkedSpeaker.mockResolvedValue({ id: "spk-1", linkedBy: "pointer" });
    mockFindOrIssue.mockImplementation((args: { templateId: string }) =>
      args.templateId === "tpl-app"
        ? Promise.resolve({ ok: false as const, code: "RENDER_FAILED" as const, error: "boom" })
        : Promise.resolve(okCert("tpl-att", "ATT-1")),
    );
    const res = await executeCertificateBulkSend(BASE);
    expect(res).toMatchObject({ successCount: 1, failureCount: 0 });
    expect(mockBundleSend.mock.calls[0][0].certs).toHaveLength(1);
  });

  it("fails the recipient when EVERY template fails", async () => {
    mockLinkedSpeaker.mockResolvedValue({ id: "spk-1", linkedBy: "pointer" });
    mockFindOrIssue.mockResolvedValue({ ok: false, code: "RENDER_FAILED", error: "boom" });
    const res = await executeCertificateBulkSend(BASE);
    expect(res).toMatchObject({ successCount: 0, failureCount: 1 });
    expect(res.errors[0].error).toContain("boom");
    expect(mockBundleSend).not.toHaveBeenCalled();
  });

  it("fails the recipient when the email send fails", async () => {
    mockBundleSend.mockResolvedValue({ success: false, error: "SES down" });
    const res = await executeCertificateBulkSend(BASE);
    expect(res).toMatchObject({ successCount: 0, failureCount: 1 });
    expect(res.errors[0].error).toBe("SES down");
  });

  it("honors the operator's custom subject/message override", async () => {
    await executeCertificateBulkSend({
      ...BASE,
      customSubject: "Here are your certs",
      customMessage: "<p>Custom body {{certificateList}}</p>",
    });
    const sent = mockBundleSend.mock.calls[0][0];
    expect(sent.emailSubjectTemplate).toBe("Here are your certs");
    expect(sent.emailBodyTemplate).toContain("Custom body");
  });

  it("anchors on the speaker + linked registration for the speakers recipient type", async () => {
    mockDb.speaker.findUnique.mockResolvedValue({
      tags: ["speaker"],
      email: "jane@x.com",
      sourceRegistrationId: null,
    });
    mockLinkedRegistration.mockResolvedValue({ id: "reg-9", linkedBy: "email" });
    mockDb.registration.findUnique.mockResolvedValue({ attendee: { tags: ["attended"] } });
    const res = await executeCertificateBulkSend({
      ...BASE,
      recipientType: "speakers",
      recipients: [{ id: "spk-1", email: "jane@x.com", firstName: "Jane", lastName: "Doe", title: "DR" }],
    });
    expect(res.successCount).toBe(1);
    // Both facets resolved — both templates fire.
    expect(mockFindOrIssue).toHaveBeenCalledTimes(2);
    expect(mockFindOrIssue.mock.calls[0][0]).toMatchObject({ registrationId: "reg-9", speakerId: "spk-1" });
  });

  it("uses the event's editable bundle template for a 2-cert email (cover from Communications → Email Templates)", async () => {
    mockLinkedSpeaker.mockResolvedValue({ id: "spk-1", linkedBy: "pointer" });
    mockLoadBundleCover.mockResolvedValue({ subject: "Org-edited subject", body: "<p>Org-edited {{certificateList}}</p>" });
    const res = await executeCertificateBulkSend(BASE);
    expect(res.successCount).toBe(1);
    const sent = mockBundleSend.mock.calls[0][0];
    expect(sent.certs).toHaveLength(2);
    expect(sent.emailSubjectTemplate).toBe("Org-edited subject");
    expect(sent.emailBodyTemplate).toContain("Org-edited");
  });

  it("reports an error for a recipient whose row vanished", async () => {
    mockDb.registration.findUnique.mockResolvedValue(null);
    const res = await executeCertificateBulkSend(BASE);
    expect(res).toMatchObject({ successCount: 0, failureCount: 1 });
    expect(res.errors[0].error).toContain("no longer exists");
  });
});

describe("executeCertificateBulkSend — resume idempotency (review A4, July 16 2026)", () => {
  // The issue-or-reuse path dedups the certificate ROW, not the EMAIL — before
  // A4, a worker crash mid-send + operator Retry re-emailed everyone already
  // emailed on the post-event certificate fan-out (the largest send in the
  // system). Same alreadyEmailedKeys/onBatchEmailed contract as the non-cert
  // path in executeBulkEmail.
  const REG2 = { id: "reg-2", email: "bob@x.com", firstName: "Bob", lastName: "Ray", title: null };

  it("skips already-emailed recipients — only the remainder is processed and counted", async () => {
    const onBatchEmailed = vi.fn().mockResolvedValue(undefined);
    const res = await executeCertificateBulkSend({
      ...BASE,
      recipients: [REG_RECIPIENT, REG2],
      alreadyEmailedKeys: ["reg-1"],
      onBatchEmailed,
    });

    // reg-1 was emailed by the crashed prior run — never re-sent.
    expect(mockBundleSend).toHaveBeenCalledTimes(1);
    expect(mockBundleSend.mock.calls[0][0].recipientEmail).toBe("bob@x.com");
    expect(res.total).toBe(1);
    const recorded = onBatchEmailed.mock.calls.flatMap((c) => c[0]);
    expect(recorded).toEqual(["reg-2"]);
  });

  it("records only successfully-emailed ids — a failed send is retried next run", async () => {
    const onBatchEmailed = vi.fn().mockResolvedValue(undefined);
    // Fail Bob's email, succeed Jane's (keyed on recipient, not call order —
    // the batch runs recipients concurrently).
    mockBundleSend.mockImplementation((args: { recipientEmail: string }) =>
      Promise.resolve(
        args.recipientEmail === "bob@x.com"
          ? { success: false, error: "SES down" }
          : { success: true, messageId: "m1" },
      ),
    );

    const res = await executeCertificateBulkSend({
      ...BASE,
      recipients: [REG_RECIPIENT, REG2],
      onBatchEmailed,
    });

    expect(res).toMatchObject({ successCount: 1, failureCount: 1 });
    // Only Jane's id is persisted — a retry re-attempts Bob (his cert row is
    // reused via findOrIssueCertificate, so no duplicate serial is minted).
    const recorded = onBatchEmailed.mock.calls.flatMap((c) => c[0]);
    expect(recorded).toEqual(["reg-1"]);
  });

  it("a record failure does not fail the send", async () => {
    const onBatchEmailed = vi.fn().mockRejectedValue(new Error("db blip"));
    const res = await executeCertificateBulkSend({ ...BASE, onBatchEmailed });
    expect(res.successCount).toBe(1);
  });
});
