/**
 * Unit tests for the on-demand cert delivery service (deliver.ts):
 *   - issueSingleCertificate() — validation, wrong-recipient-type, dedup (P2002),
 *     happy path (create + send + audit), issued-but-send-failed.
 *   - reRenderAndResendCert() — not-found, revoked, no-template, happy path
 *     (updates pdfUrl + bumps reprint/resend counters), send-failed (no bump).
 *
 * Renderer / storage / email / worker helpers are mocked — we assert the
 * orchestration + counter bumps + error mapping, not pdf-lib output.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockDb, mockSend, mockRender, mockUpload, mockLoadRecipient, mockLoadEvent, mockAllocSerial, mockGetEventTemplate } = vi.hoisted(() => ({
  mockDb: {
    certificateTemplate: { findFirst: vi.fn() },
    issuedCertificate: { create: vi.fn(), update: vi.fn(), findFirst: vi.fn() },
    registration: { findUnique: vi.fn() },
    speaker: { findUnique: vi.fn() },
    event: { findUnique: vi.fn() },
    auditLog: { create: vi.fn().mockResolvedValue({}) },
  },
  mockSend: vi.fn().mockResolvedValue({ success: true, messageId: "m1" }),
  mockRender: vi.fn().mockResolvedValue(Buffer.from("%PDF-1.4 fake")),
  mockUpload: vi.fn().mockResolvedValue("/uploads/certificates/evt/2026/07/serial.pdf"),
  mockLoadRecipient: vi.fn(),
  mockLoadEvent: vi.fn(),
  mockAllocSerial: vi.fn().mockResolvedValue("OMM-ATT-0009"),
  // null → no per-event bundle cover template → hardcoded multi default.
  mockGetEventTemplate: vi.fn().mockResolvedValue(null),
}));

vi.mock("@/lib/logger", () => ({ apiLogger: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock("@/lib/db", () => ({ db: mockDb }));
vi.mock("@/lib/html", () => ({ escapeHtml: (s: string) => s }));
vi.mock("@/lib/email", () => ({
  sendEmail: (args: unknown) => mockSend(args),
  wrapWithBranding: (html: string) => html,
  inlineCss: (html: string) => html,
  brandingFrom: () => ({ email: "from@x.com", name: "Org" }),
  getEventTemplate: (e: string, slug: string) => mockGetEventTemplate(e, slug),
}));
vi.mock("@/lib/certificates/render", () => ({ renderCertificate: (d: unknown) => mockRender(d) }));
vi.mock("@/lib/storage", () => ({ uploadCertificatePdf: (b: unknown, n: unknown, e: unknown) => mockUpload(b, n, e) }));
vi.mock("@/lib/certificates/email-tokens-resolver", () => ({
  // Passthrough resolver — return the template unchanged.
  resolveCoverEmailTokens: (tpl: string) => Promise.resolve(tpl),
}));
vi.mock("@/lib/certificates/email-tokens", () => ({
  SYSTEM_DEFAULT_SUBJECT: "Your {{certificateType}}",
  SYSTEM_DEFAULT_SUBJECT_MULTI: "Your certificates",
  SYSTEM_DEFAULT_BODY_MULTI: "<p>Multi {{certificateList}}</p>",
  CERT_BUNDLE_COVER_TEMPLATE_SLUG: "certificate-bundle-delivery",
  defaultBodyForCategory: () => "<p>Body</p>",
  defaultCoverEmailFor: (n: number) =>
    n > 1
      ? { subject: "Your certificates", body: "<p>Multi {{certificateList}}</p>" }
      : { subject: "Your {{certificateType}}", body: "<p>Body</p>" },
}));
vi.mock("@/lib/certificates/pdf-loader", () => ({
  // Reuse path — pretend every stored PDF loads fine.
  loadCertificatePdfBytes: vi.fn().mockResolvedValue(Buffer.from("%PDF stored")),
}));
vi.mock("@/lib/certificates/cert-context", () => ({
  loadRecipient: (r: string | null, s: string | null) => mockLoadRecipient(r, s),
  loadEventContext: (e: string) => mockLoadEvent(e),
  allocateSerial: (e: string, t: string) => mockAllocSerial(e, t),
  loadPosterAbstractTitle: vi.fn().mockResolvedValue(null),
}));

import { issueSingleCertificate, issueCertificateBundle, reRenderAndResendCert } from "@/lib/certificates/deliver";

const CTX = { eventId: "evt-1", organizationId: "org-1", actorUserId: "user-1", source: "rest" as const };
const RECIPIENT = { title: "Dr.", firstName: "Jane", lastName: "Doe", fullName: "Dr. Jane Doe", organization: null, jobTitle: null, city: null, country: null };
const EVENT_CTX = { name: "OSH", startDate: new Date("2026-06-17"), endDate: new Date("2026-06-17"), venue: null, city: null, country: null, organizationName: "MMG", organizationLogo: null, cmeHours: null, accreditations: [], settings: {} };
const SEND_EVENT = { name: "OSH", startDate: new Date("2026-06-17"), endDate: new Date("2026-06-17"), venue: null, city: null, country: null, emailHeaderImage: null, emailFooterImage: null, emailFooterHtml: null, emailFromAddress: null, emailFromName: null, organization: { name: "MMG" } };

beforeEach(() => {
  vi.clearAllMocks();
  mockSend.mockResolvedValue({ success: true, messageId: "m1" });
  mockRender.mockResolvedValue(Buffer.from("%PDF"));
  mockUpload.mockResolvedValue("/uploads/certificates/evt/2026/07/serial.pdf");
  mockLoadRecipient.mockResolvedValue(RECIPIENT);
  mockLoadEvent.mockResolvedValue(EVENT_CTX);
  mockAllocSerial.mockResolvedValue("OMM-ATT-0009");
  mockDb.event.findUnique.mockResolvedValue(SEND_EVENT);
  mockDb.auditLog.create.mockResolvedValue({});
  mockGetEventTemplate.mockResolvedValue(null);
});

describe("issueSingleCertificate", () => {
  const ATT_TEMPLATE = { category: "ATTENDANCE", backgroundPdfUrl: "/bg.pdf", textBoxes: [], role: null, cmeHours: null, emailSubject: "Sub", emailBody: "<p>Hi {{recipientName}}</p>" };

  it("rejects when neither or both recipients are given", async () => {
    mockDb.certificateTemplate.findFirst.mockResolvedValue(ATT_TEMPLATE);
    const both = await issueSingleCertificate(CTX, { templateId: "t", registrationId: "r", speakerId: "s" });
    expect(both).toMatchObject({ ok: false, code: "INVALID_RECIPIENT", status: 400 });
    const neither = await issueSingleCertificate(CTX, { templateId: "t" });
    expect(neither).toMatchObject({ ok: false, code: "INVALID_RECIPIENT" });
  });

  it("404s when the template doesn't exist", async () => {
    mockDb.certificateTemplate.findFirst.mockResolvedValue(null);
    const res = await issueSingleCertificate(CTX, { templateId: "t", registrationId: "r" });
    expect(res).toMatchObject({ ok: false, code: "TEMPLATE_NOT_FOUND", status: 404 });
  });

  it("rejects an ATTENDANCE template sent to a speaker (wrong recipient type)", async () => {
    mockDb.certificateTemplate.findFirst.mockResolvedValue(ATT_TEMPLATE);
    const res = await issueSingleCertificate(CTX, { templateId: "t", speakerId: "s" });
    expect(res).toMatchObject({ ok: false, code: "WRONG_RECIPIENT_TYPE", status: 400 });
  });

  it("409s when the recipient has no email", async () => {
    mockDb.certificateTemplate.findFirst.mockResolvedValue(ATT_TEMPLATE);
    mockDb.registration.findUnique.mockResolvedValue({ attendee: { email: null } });
    const res = await issueSingleCertificate(CTX, { templateId: "t", registrationId: "r" });
    expect(res).toMatchObject({ ok: false, code: "NO_RECIPIENT_EMAIL", status: 409 });
  });

  it("happy path: renders, creates the cert, sends, and audits", async () => {
    mockDb.certificateTemplate.findFirst.mockResolvedValue(ATT_TEMPLATE);
    mockDb.registration.findUnique.mockResolvedValue({ attendee: { email: "jane@x.com" } });
    mockDb.issuedCertificate.create.mockResolvedValue({ id: "cert-1" });

    const res = await issueSingleCertificate(CTX, { templateId: "t", registrationId: "reg-1" });
    expect(res).toMatchObject({ ok: true, certificateId: "cert-1", serial: "OMM-ATT-0009", recipientEmail: "jane@x.com", issued: true });
    expect(mockRender).toHaveBeenCalledTimes(1);
    expect(mockUpload).toHaveBeenCalledTimes(1);
    expect(mockDb.issuedCertificate.create).toHaveBeenCalledTimes(1);
    expect(mockSend).toHaveBeenCalledTimes(1);
    // attachment present
    expect(mockSend.mock.calls[0][0].attachments[0].contentType).toBe("application/pdf");
    expect(mockDb.auditLog.create).toHaveBeenCalledTimes(1);
  });

  it("409 ALREADY_ISSUED when the person already holds this template's cert (P2002)", async () => {
    mockDb.certificateTemplate.findFirst.mockResolvedValue(ATT_TEMPLATE);
    mockDb.registration.findUnique.mockResolvedValue({ attendee: { email: "jane@x.com" } });
    const { Prisma } = await import("@prisma/client");
    mockDb.issuedCertificate.create.mockRejectedValue(new Prisma.PrismaClientKnownRequestError("dup", { code: "P2002", clientVersion: "x" }));
    const res = await issueSingleCertificate(CTX, { templateId: "t", registrationId: "reg-1" });
    expect(res).toMatchObject({ ok: false, code: "ALREADY_ISSUED", status: 409 });
    expect(mockSend).not.toHaveBeenCalled();
  });

  it("ISSUED_SEND_FAILED: cert is created but the email fails", async () => {
    mockDb.certificateTemplate.findFirst.mockResolvedValue(ATT_TEMPLATE);
    mockDb.registration.findUnique.mockResolvedValue({ attendee: { email: "jane@x.com" } });
    mockDb.issuedCertificate.create.mockResolvedValue({ id: "cert-1" });
    mockSend.mockResolvedValue({ success: false, error: "SES down" });
    const res = await issueSingleCertificate(CTX, { templateId: "t", registrationId: "reg-1" });
    expect(res).toMatchObject({ ok: false, code: "ISSUED_SEND_FAILED", status: 502 });
    expect(mockDb.issuedCertificate.create).toHaveBeenCalledTimes(1); // cert exists
  });
});

describe("reRenderAndResendCert", () => {
  const baseCert = {
    id: "cert-1", type: "ATTENDANCE", serial: "OMM-ATT-0002", certificateTemplateId: "tmpl-1",
    registrationId: "reg-1", speakerId: null, revokedAt: null, recipientSnapshot: { fullName: "Dr. Jane Doe" },
  };
  const TEMPLATE = { category: "ATTENDANCE", backgroundPdfUrl: "/bg.pdf", textBoxes: [], role: null, cmeHours: null, emailSubject: "Sub", emailBody: "<p>Hi {{recipientName}}</p>" };

  it("404 when the cert isn't found (or cross-tenant)", async () => {
    mockDb.issuedCertificate.findFirst.mockResolvedValue(null);
    const res = await reRenderAndResendCert(CTX, "cert-x");
    expect(res).toMatchObject({ ok: false, code: "NOT_FOUND", status: 404 });
  });

  it("409 on a revoked cert", async () => {
    mockDb.issuedCertificate.findFirst.mockResolvedValue({ ...baseCert, revokedAt: new Date() });
    const res = await reRenderAndResendCert(CTX, "cert-1");
    expect(res).toMatchObject({ ok: false, code: "CERT_REVOKED", status: 409 });
  });

  it("409 NO_TEMPLATE when the cert isn't linked to a template", async () => {
    mockDb.issuedCertificate.findFirst.mockResolvedValue({ ...baseCert, certificateTemplateId: null });
    const res = await reRenderAndResendCert(CTX, "cert-1");
    expect(res).toMatchObject({ ok: false, code: "NO_TEMPLATE", status: 409 });
  });

  it("happy path: re-renders (updates pdfUrl + reprintCount), resends, bumps resendCount, audits", async () => {
    mockDb.issuedCertificate.findFirst.mockResolvedValue(baseCert);
    mockDb.certificateTemplate.findFirst.mockResolvedValue(TEMPLATE);
    mockDb.registration.findUnique.mockResolvedValue({ attendee: { email: "jane@x.com" } });
    mockDb.issuedCertificate.update.mockResolvedValue({});

    const res = await reRenderAndResendCert(CTX, "cert-1");
    expect(res).toMatchObject({ ok: true, certificateId: "cert-1", serial: "OMM-ATT-0002", issued: false });
    expect(mockRender).toHaveBeenCalledTimes(1);
    // keeps the SAME serial (re-render, not new)
    expect(mockUpload.mock.calls[0][1]).toBe("OMM-ATT-0002.pdf");
    // two updates: pdfUrl+reprintCount, then resendCount
    expect(mockDb.issuedCertificate.update).toHaveBeenCalledTimes(2);
    const firstUpdate = mockDb.issuedCertificate.update.mock.calls[0][0].data;
    expect(firstUpdate.reprintCount).toEqual({ increment: 1 });
    expect(firstUpdate.pdfUrl).toBeTruthy();
    const secondUpdate = mockDb.issuedCertificate.update.mock.calls[1][0].data;
    expect(secondUpdate.resendCount).toEqual({ increment: 1 });
    // Dedicated reissue counter bumps alongside resend on a successful reissue.
    expect(secondUpdate.reissueCount).toEqual({ increment: 1 });
    expect(secondUpdate.lastReissuedAt).toBeInstanceOf(Date);
    expect(mockSend).toHaveBeenCalledTimes(1);
    expect(mockDb.auditLog.create).toHaveBeenCalledTimes(1);
  });

  it("SEND_FAILED: re-render commits but no resendCount bump on email failure", async () => {
    mockDb.issuedCertificate.findFirst.mockResolvedValue(baseCert);
    mockDb.certificateTemplate.findFirst.mockResolvedValue(TEMPLATE);
    mockDb.registration.findUnique.mockResolvedValue({ attendee: { email: "jane@x.com" } });
    mockDb.issuedCertificate.update.mockResolvedValue({});
    mockSend.mockResolvedValue({ success: false, error: "SES down" });

    const res = await reRenderAndResendCert(CTX, "cert-1");
    expect(res).toMatchObject({ ok: false, code: "SEND_FAILED", status: 502 });
    // only the re-render update happened (pdfUrl+reprintCount), NOT the resendCount bump
    expect(mockDb.issuedCertificate.update).toHaveBeenCalledTimes(1);
    expect(mockDb.issuedCertificate.update.mock.calls[0][0].data.reprintCount).toEqual({ increment: 1 });
  });
});

// ── issueCertificateBundle — multi-template issue to ONE person ──────────────
// The card's multi-select "Issue certificate" flow: issue-or-reuse per
// template, ONE bundle email with one PDF per cert.

describe("issueCertificateBundle", () => {
  const TPL_A = { id: "tpl-a", name: "Attendance", category: "ATTENDANCE", autoIssueTag: "delegate", backgroundPdfUrl: "/bg.pdf", textBoxes: [], role: null, cmeHours: null, emailSubject: "Att Sub", emailBody: "<p>A</p>" };
  const TPL_B = { id: "tpl-b", name: "Committee", category: "ATTENDANCE", autoIssueTag: "committee", backgroundPdfUrl: "/bg.pdf", textBoxes: [], role: "Committee", cmeHours: null, emailSubject: null, emailBody: null };
  const APP_TPL = { id: "tpl-s", name: "Speaker", category: "APPRECIATION", autoIssueTag: "speaker", backgroundPdfUrl: "/bg.pdf", textBoxes: [], role: "Speaker", cmeHours: null, emailSubject: null, emailBody: null };

  function primeTemplates(rows: Array<Record<string, unknown>>) {
    mockDb.certificateTemplate.findFirst.mockImplementation(
      (args: { where: { id: string } }) => Promise.resolve(rows.find((r) => r.id === args.where.id) ?? null),
    );
  }

  beforeEach(() => {
    primeTemplates([TPL_A, TPL_B, APP_TPL]);
    // Recipient holds BOTH attendance tags — the tag gate ("no tag, no
    // certificate") lets both templates through in the happy paths.
    mockDb.registration.findUnique.mockResolvedValue({
      attendee: { email: "jane@x.com", tags: ["delegate", "committee"] },
    });
    mockDb.issuedCertificate.findFirst.mockResolvedValue(null);
    let n = 0;
    mockDb.issuedCertificate.create.mockImplementation(() => Promise.resolve({ id: `cert-${++n}` }));
    mockAllocSerial.mockImplementation(() => Promise.resolve(`OMM-ATT-${String(++n).padStart(4, "0")}`));
  });

  it("issues two templates and sends ONE email with two PDFs (multi cover)", async () => {
    const res = await issueCertificateBundle(CTX, { templateIds: ["tpl-a", "tpl-b"], registrationId: "reg-1" });
    expect(res).toMatchObject({ ok: true, recipientEmail: "jane@x.com" });
    if (!res.ok) throw new Error("unreachable");
    expect(res.certs).toHaveLength(2);
    expect(res.failures).toHaveLength(0);
    expect(mockSend).toHaveBeenCalledTimes(1);
    expect(mockSend.mock.calls[0][0].attachments).toHaveLength(2);
    // Multi-template → bundle default cover, not tpl-a's saved cover.
    expect(mockSend.mock.calls[0][0].subject).toBe("Your certificates");
    // One CERT_ISSUED audit per newly minted cert.
    expect(mockDb.auditLog.create).toHaveBeenCalledTimes(2);
  });

  it("multi bundle uses the event's editable cover template when present", async () => {
    mockGetEventTemplate.mockResolvedValue({
      subject: "Org-edited certs subject",
      htmlContent: "<p>Org-edited {{certificateList}}</p>",
      textContent: "",
      branding: {},
    });
    const res = await issueCertificateBundle(CTX, { templateIds: ["tpl-a", "tpl-b"], registrationId: "reg-1" });
    expect(res).toMatchObject({ ok: true });
    expect(mockGetEventTemplate).toHaveBeenCalledWith("evt-1", "certificate-bundle-delivery");
    expect(mockSend.mock.calls[0][0].subject).toBe("Org-edited certs subject");
    expect(mockSend.mock.calls[0][0].htmlContent).toContain("Org-edited");
  });

  it("single template keeps its saved cover email", async () => {
    const res = await issueCertificateBundle(CTX, { templateIds: ["tpl-a"], registrationId: "reg-1" });
    expect(res).toMatchObject({ ok: true });
    expect(mockSend.mock.calls[0][0].subject).toBe("Att Sub");
  });

  it("re-attaches an already-held template (reused) without a new audit row", async () => {
    mockDb.issuedCertificate.findFirst.mockImplementation(
      (args: { where: { certificateTemplateId: string } }) =>
        Promise.resolve(
          args.where.certificateTemplateId === "tpl-a"
            ? { id: "cert-old", serial: "OMM-ATT-0001", pdfUrl: "/uploads/certificates/old.pdf", revokedAt: null }
            : null,
        ),
    );
    const res = await issueCertificateBundle(CTX, { templateIds: ["tpl-a", "tpl-b"], registrationId: "reg-1" });
    if (!res.ok) throw new Error("expected ok");
    expect(res.certs).toHaveLength(2);
    const reusedRow = res.certs.find((c) => c.certificateId === "cert-old");
    expect(reusedRow).toMatchObject({ reused: true, serial: "OMM-ATT-0001" });
    // Only the FRESH cert audits (mirrors the bulk-email path).
    expect(mockDb.auditLog.create).toHaveBeenCalledTimes(1);
    expect(mockSend).toHaveBeenCalledTimes(1);
    expect(mockSend.mock.calls[0][0].attachments).toHaveLength(2);
  });

  it("partial send: a revoked cert's template lands in failures, the rest still go out", async () => {
    mockDb.issuedCertificate.findFirst.mockImplementation(
      (args: { where: { certificateTemplateId: string } }) =>
        Promise.resolve(
          args.where.certificateTemplateId === "tpl-a"
            ? { id: "cert-old", serial: "OMM-ATT-0001", pdfUrl: "/x.pdf", revokedAt: new Date() }
            : null,
        ),
    );
    const res = await issueCertificateBundle(CTX, { templateIds: ["tpl-a", "tpl-b"], registrationId: "reg-1" });
    if (!res.ok) throw new Error("expected ok");
    expect(res.certs).toHaveLength(1);
    expect(res.failures).toHaveLength(1);
    expect(res.failures[0]).toMatchObject({ templateId: "tpl-a", templateName: "Attendance" });
    expect(mockSend).toHaveBeenCalledTimes(1);
  });

  it("ALL_TEMPLATES_FAILED when nothing materializes (no email sent)", async () => {
    mockDb.issuedCertificate.findFirst.mockResolvedValue({
      id: "cert-old", serial: "OMM-ATT-0001", pdfUrl: "/x.pdf", revokedAt: new Date(),
    });
    const res = await issueCertificateBundle(CTX, { templateIds: ["tpl-a"], registrationId: "reg-1" });
    expect(res).toMatchObject({ ok: false, code: "ALL_TEMPLATES_FAILED", status: 500 });
    expect(mockSend).not.toHaveBeenCalled();
  });

  it("WRONG_RECIPIENT_TYPE when an appreciation template targets a registration", async () => {
    const res = await issueCertificateBundle(CTX, { templateIds: ["tpl-a", "tpl-s"], registrationId: "reg-1" });
    expect(res).toMatchObject({ ok: false, code: "WRONG_RECIPIENT_TYPE", status: 400 });
    expect(mockSend).not.toHaveBeenCalled();
  });

  it("ISSUED_SEND_FAILED when the bundle email fails (certs stay issued)", async () => {
    mockSend.mockResolvedValue({ success: false, error: "SES down" });
    const res = await issueCertificateBundle(CTX, { templateIds: ["tpl-a", "tpl-b"], registrationId: "reg-1" });
    expect(res).toMatchObject({ ok: false, code: "ISSUED_SEND_FAILED", status: 502 });
    expect(mockDb.issuedCertificate.create).toHaveBeenCalledTimes(2);
  });

  it("rejects an empty template list / bad recipient combos", async () => {
    expect(await issueCertificateBundle(CTX, { templateIds: [], registrationId: "reg-1" })).toMatchObject({ ok: false, code: "NO_TEMPLATES" });
    expect(await issueCertificateBundle(CTX, { templateIds: ["tpl-a"] })).toMatchObject({ ok: false, code: "INVALID_RECIPIENT" });
  });

  // ── Tag gate — "no tag, no certificate" (organizer decision 2026-07-10) ──

  it("tag gate: a template whose tag the person lacks is refused; matching ones still go out", async () => {
    mockDb.registration.findUnique.mockResolvedValue({
      attendee: { email: "jane@x.com", tags: ["delegate"] }, // no "committee"
    });
    const res = await issueCertificateBundle(CTX, { templateIds: ["tpl-a", "tpl-b"], registrationId: "reg-1" });
    if (!res.ok) throw new Error("expected ok");
    expect(res.certs).toHaveLength(1);
    expect(res.failures).toHaveLength(1);
    expect(res.failures[0]).toMatchObject({ templateId: "tpl-b", templateName: "Committee" });
    expect(res.failures[0].error).toContain('doesn\'t hold this template\'s tag ("committee")');
    expect(mockSend).toHaveBeenCalledTimes(1);
    expect(mockSend.mock.calls[0][0].attachments).toHaveLength(1);
  });

  it("NO_MATCHING_TAG blocks the whole issue for an untagged person (nothing issued, no email)", async () => {
    mockDb.registration.findUnique.mockResolvedValue({
      attendee: { email: "jane@x.com", tags: [] },
    });
    const res = await issueCertificateBundle(CTX, { templateIds: ["tpl-a", "tpl-b"], registrationId: "reg-1" });
    expect(res).toMatchObject({ ok: false, code: "NO_MATCHING_TAG", status: 422 });
    if (res.ok) throw new Error("unreachable");
    expect(res.error).toContain("no tags");
    expect(mockDb.issuedCertificate.create).not.toHaveBeenCalled();
    expect(mockSend).not.toHaveBeenCalled();
  });

  it("a tagless template can never be issued (matches nobody)", async () => {
    const TPL_NOTAG = { ...TPL_B, id: "tpl-n", name: "Tagless", autoIssueTag: null };
    primeTemplates([TPL_A, TPL_NOTAG]);
    const res = await issueCertificateBundle(CTX, { templateIds: ["tpl-a", "tpl-n"], registrationId: "reg-1" });
    if (!res.ok) throw new Error("expected ok");
    expect(res.certs).toHaveLength(1);
    expect(res.failures[0]).toMatchObject({ templateId: "tpl-n" });
    expect(res.failures[0].error).toContain("has no tag");
  });

  it("speaker facet: appreciation template matched against SPEAKER tags", async () => {
    mockDb.speaker.findUnique.mockResolvedValue({ email: "spk@x.com", tags: ["speaker"] });
    const res = await issueCertificateBundle(CTX, { templateIds: ["tpl-s"], speakerId: "spk-1" });
    if (!res.ok) throw new Error(`expected ok, got ${JSON.stringify(res)}`);
    expect(res.certs).toHaveLength(1);
    expect(res.recipientEmail).toBe("spk@x.com");
  });
});
