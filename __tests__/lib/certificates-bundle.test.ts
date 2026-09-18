/**
 * Unit tests for the certificate bundle core (bundle.ts):
 *   - findOrIssueCertificate() — fresh issue, reuse-existing-PDF, repair
 *     missing/unloadable PDF (same serial), revoked guard, category↔facet
 *     routing, template-not-found, P2002 race → winner reuse.
 *   - sendCertificateBundleEmail() — multi-attachment send, empty-bundle
 *     guard, attachment-size cap, event-not-found.
 *
 * Renderer / storage / email / pdf-loader / cert-context are mocked — we
 * assert orchestration + reuse semantics, not pdf-lib output.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { Prisma } from "@prisma/client";

const {
  mockDb,
  mockSend,
  mockRender,
  mockUpload,
  mockLoadRecipient,
  mockLoadEvent,
  mockAllocSerial,
  mockLoadPdf,
  mockGetEventTemplate,
} = vi.hoisted(() => ({
  mockDb: {
    certificateTemplate: { findFirst: vi.fn() },
    issuedCertificate: { create: vi.fn(), update: vi.fn(), findFirst: vi.fn() },
    event: { findUnique: vi.fn() },
  },
  mockSend: vi.fn().mockResolvedValue({ success: true, messageId: "m1" }),
  mockRender: vi.fn().mockResolvedValue(Buffer.from("%PDF fresh")),
  mockUpload: vi.fn().mockResolvedValue("/uploads/certificates/evt/fresh.pdf"),
  mockLoadRecipient: vi.fn(),
  mockLoadEvent: vi.fn(),
  mockAllocSerial: vi.fn().mockResolvedValue("OMM-ATT-0042"),
  mockLoadPdf: vi.fn(),
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
  // The event auto-CC, minus the recipient: the shape the real helper returns.
  brandingCc: (branding: { emailCcAddresses?: string[] }, exclude?: { email: string }[]) =>
    (branding.emailCcAddresses ?? [])
      .filter((e) => !(exclude ?? []).some((x) => x.email.toLowerCase() === e.toLowerCase()))
      .map((email) => ({ email })),
  loadActiveEventTemplateRow: vi.fn(),
  getEventTemplate: (e: string, slug: string) => mockGetEventTemplate(e, slug),
}));
vi.mock("@/lib/certificates/render", () => ({ renderCertificate: (d: unknown) => mockRender(d) }));
vi.mock("@/lib/storage", () => ({ uploadCertificatePdf: (b: unknown, n: unknown, e: unknown) => mockUpload(b, n, e) }));
vi.mock("@/lib/certificates/pdf-loader", () => ({
  loadCertificatePdfBytes: (url: string) => mockLoadPdf(url),
}));
vi.mock("@/lib/certificates/email-tokens-resolver", () => ({
  // Passthrough, except the name parts, so the sender's own lookup of a
  // recipient's title/name is observable in the sent email.
  resolveCoverEmailTokens: (tpl: string, ctx: Record<string, unknown>) =>
    Promise.resolve(
      tpl.replace(/\{\{(title|firstName|lastName)\}\}/g, (_m, key: string) => String(ctx?.[key] ?? "")),
    ),
}));
vi.mock("@/lib/certificates/cert-context", () => ({
  loadRecipient: (r: string | null, s: string | null) => mockLoadRecipient(r, s),
  loadEventContext: (e: string) => mockLoadEvent(e),
  allocateSerial: (e: string, t: string, o: string | null) => mockAllocSerial(e, t, o),
  loadPosterAbstractTitle: vi.fn().mockResolvedValue(null),
  // Faithful copy of the real predicate (M1) — the recipient-dup P2002 the
  // race tests simulate carries no `serial` target, so this returns false and
  // the winner-reuse path runs unchanged.
  isSerialCollision: (err: unknown) => {
    const e = err as { code?: string; meta?: { target?: unknown } };
    if (e?.code !== "P2002") return false;
    const t = e.meta?.target;
    const fields = Array.isArray(t) ? t : typeof t === "string" ? [t] : [];
    return fields.some((f) => String(f).toLowerCase().includes("serial"));
  },
}));

import {
  findOrIssueCertificate,
  sendCertificateBundleEmail,
  buildCertCoverEmailPreview,
  buildCertCoverTemplatePreview,
} from "@/lib/certificates/bundle";

const RECIPIENT = { title: "Dr.", firstName: "Jane", lastName: "Doe", fullName: "Dr. Jane Doe", organization: null, jobTitle: null, city: null, country: null };
const EVENT_CTX = { name: "OSH", startDate: new Date("2026-06-17"), endDate: new Date("2026-06-17"), venue: null, city: null, country: null, organizationName: "MMG", organizationLogo: null, cmeHours: 4, accreditations: [], settings: {} };
const SEND_EVENT = { name: "OSH", startDate: new Date("2026-06-17"), endDate: new Date("2026-06-17"), venue: null, city: null, country: null, emailHeaderImage: null, emailFooterImage: null, emailFooterHtml: null, emailFromAddress: null, emailFromName: null, organization: { name: "MMG" } };

const ATT_TEMPLATE_ROW = {
  id: "tpl-att",
  name: "Standard Attendance",
  category: "ATTENDANCE",
  autoIssueTag: "attended",
  backgroundPdfUrl: "/bg.pdf",
  textBoxes: [],
  role: null,
  cmeHours: null,
  emailSubject: "Sub",
  emailBody: "<p>Hi {{recipientName}}</p>",
};

function p2002() {
  return new Prisma.PrismaClientKnownRequestError("Unique constraint", {
    code: "P2002",
    clientVersion: "test",
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockSend.mockResolvedValue({ success: true, messageId: "m1" });
  mockRender.mockResolvedValue(Buffer.from("%PDF fresh"));
  mockUpload.mockResolvedValue("/uploads/certificates/evt/fresh.pdf");
  mockLoadRecipient.mockResolvedValue(RECIPIENT);
  mockLoadEvent.mockResolvedValue(EVENT_CTX);
  mockAllocSerial.mockResolvedValue("OMM-ATT-0042");
  mockLoadPdf.mockResolvedValue(Buffer.from("%PDF existing"));
  mockDb.certificateTemplate.findFirst.mockResolvedValue(ATT_TEMPLATE_ROW);
  mockDb.issuedCertificate.findFirst.mockResolvedValue(null);
  mockDb.issuedCertificate.create.mockResolvedValue({ id: "cert-new" });
  mockDb.issuedCertificate.update.mockResolvedValue({});
  mockDb.event.findUnique.mockResolvedValue(SEND_EVENT);
});

const BASE_ARGS = {
  eventId: "evt-1",
  organizationId: "org-1", // tenancy
  templateId: "tpl-att",
  registrationId: "reg-1",
  speakerId: "spk-1", // both facets passed — category must pick
  issuedByUserId: "user-1",
};

describe("findOrIssueCertificate", () => {
  it("issues fresh: allocates serial, renders, creates with the category facet only", async () => {
    const res = await findOrIssueCertificate(BASE_ARGS);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.cert).toMatchObject({ certificateId: "cert-new", serial: "OMM-ATT-0042", reused: false, templateName: "Standard Attendance" });
    expect(mockAllocSerial).toHaveBeenCalledWith("evt-1", "ATTENDANCE", "org-1");
    const createData = mockDb.issuedCertificate.create.mock.calls[0][0].data;
    // ATTENDANCE keys on the registration; the speaker facet is nulled.
    expect(createData.registrationId).toBe("reg-1");
    expect(createData.speakerId).toBeNull();
    expect(createData.pdfUrl).toBe("/uploads/certificates/evt/fresh.pdf");
    expect(createData.cmeHoursSnapshot).toBe(4); // template null → event cmeHours
    // Tenancy (sweep review L6): the cert ROW itself must stamp the org —
    // pinning only the allocateSerial arg let a refactor drop the create's
    // stamp and pass the whole suite.
    expect(createData.organizationId).toBe("org-1");
  });

  it("reuses an existing cert's PDF without minting a new record or serial", async () => {
    mockDb.issuedCertificate.findFirst.mockResolvedValue({ id: "cert-old", serial: "OMM-ATT-0001", pdfUrl: "/uploads/certificates/evt/old.pdf", revokedAt: null });
    const res = await findOrIssueCertificate(BASE_ARGS);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.cert).toMatchObject({ certificateId: "cert-old", serial: "OMM-ATT-0001", reused: true });
    expect(res.cert.pdfBuffer.toString()).toContain("existing");
    expect(mockDb.issuedCertificate.create).not.toHaveBeenCalled();
    expect(mockAllocSerial).not.toHaveBeenCalled();
    expect(mockRender).not.toHaveBeenCalled();
  });

  it("repairs a missing pdfUrl by re-rendering with the SAME serial (reprint bump)", async () => {
    mockDb.issuedCertificate.findFirst.mockResolvedValue({ id: "cert-old", serial: "OMM-ATT-0001", pdfUrl: null, revokedAt: null });
    const res = await findOrIssueCertificate(BASE_ARGS);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.cert.serial).toBe("OMM-ATT-0001"); // NOT the freshly-allocatable one
    expect(mockAllocSerial).not.toHaveBeenCalled();
    expect(mockRender).toHaveBeenCalledTimes(1);
    const updateArgs = mockDb.issuedCertificate.update.mock.calls[0][0];
    expect(updateArgs.where).toEqual({ id: "cert-old" });
    expect(updateArgs.data.reprintCount).toEqual({ increment: 1 });
  });

  it("repairs an unloadable PDF the same way (load throws → re-render, same serial)", async () => {
    mockDb.issuedCertificate.findFirst.mockResolvedValue({ id: "cert-old", serial: "OMM-ATT-0001", pdfUrl: "/uploads/certificates/evt/gone.pdf", revokedAt: null });
    mockLoadPdf.mockRejectedValue(new Error("ENOENT"));
    const res = await findOrIssueCertificate(BASE_ARGS);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.cert).toMatchObject({ serial: "OMM-ATT-0001", reused: true });
    expect(mockRender).toHaveBeenCalledTimes(1);
  });

  it("refuses to reuse a revoked cert", async () => {
    mockDb.issuedCertificate.findFirst.mockResolvedValue({ id: "cert-old", serial: "OMM-ATT-0001", pdfUrl: "/x.pdf", revokedAt: new Date() });
    const res = await findOrIssueCertificate(BASE_ARGS);
    expect(res).toMatchObject({ ok: false, code: "CERT_REVOKED" });
    expect(mockSend).not.toHaveBeenCalled();
  });

  it("returns WRONG_RECIPIENT_TYPE when the category's facet is missing", async () => {
    mockDb.certificateTemplate.findFirst.mockResolvedValue({ ...ATT_TEMPLATE_ROW, id: "tpl-app", category: "APPRECIATION" });
    const res = await findOrIssueCertificate({ ...BASE_ARGS, templateId: "tpl-app", speakerId: null });
    expect(res).toMatchObject({ ok: false, code: "WRONG_RECIPIENT_TYPE" });
  });

  it("returns TEMPLATE_NOT_FOUND for an unknown template", async () => {
    mockDb.certificateTemplate.findFirst.mockResolvedValue(null);
    const res = await findOrIssueCertificate(BASE_ARGS);
    expect(res).toMatchObject({ ok: false, code: "TEMPLATE_NOT_FOUND" });
  });

  it("returns RECIPIENT_NOT_FOUND when the facet row vanished", async () => {
    mockLoadRecipient.mockResolvedValue(null);
    const res = await findOrIssueCertificate(BASE_ARGS);
    expect(res).toMatchObject({ ok: false, code: "RECIPIENT_NOT_FOUND" });
  });

  it("never re-points a reused cert's issueRunItemId (no bundle theft across runs)", async () => {
    mockDb.issuedCertificate.findFirst.mockResolvedValue({ id: "cert-old", serial: "OMM-ATT-0001", pdfUrl: "/uploads/certificates/evt/old.pdf", revokedAt: null });
    const res = await findOrIssueCertificate({ ...BASE_ARGS, issueRunItemId: "item-9" });
    expect(res.ok).toBe(true);
    // Reuse with a loadable PDF must not touch the cert row at all — the
    // send phase recomputes delivery sets, so re-pointing would steal the
    // cert out of another in-flight run's bundle (review fix, 2026-07-10).
    expect(mockDb.issuedCertificate.update).not.toHaveBeenCalled();
  });

  it("stamps issueRunItemId on FRESH creates only", async () => {
    const res = await findOrIssueCertificate({ ...BASE_ARGS, issueRunItemId: "item-9" });
    expect(res.ok).toBe(true);
    expect(mockDb.issuedCertificate.create.mock.calls[0][0].data.issueRunItemId).toBe("item-9");
  });

  it("resolves a P2002 race to the winner row (reused, winner's serial)", async () => {
    mockDb.issuedCertificate.create.mockRejectedValue(p2002());
    // First findFirst (pre-check) → null; second (post-race) → winner.
    mockDb.issuedCertificate.findFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: "cert-winner", serial: "OMM-ATT-0007", pdfUrl: "/uploads/certificates/evt/w.pdf", revokedAt: null });
    const res = await findOrIssueCertificate(BASE_ARGS);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.cert).toMatchObject({ certificateId: "cert-winner", serial: "OMM-ATT-0007", reused: true });
  });

  it("throws a distinct serial-collision error (not the winner path) when P2002 fires on the GLOBAL serial index (M1)", async () => {
    const serialP2002 = new Prisma.PrismaClientKnownRequestError("Unique constraint", {
      code: "P2002",
      clientVersion: "test",
      meta: { target: ["serial"] },
    });
    mockDb.issuedCertificate.create.mockRejectedValue(serialP2002);
    // Pre-check returns null (no existing cert for this recipient) — the OLD
    // code would then findFirst→null→rethrow raw P2002; now it must NOT even
    // consult the winner lookup.
    mockDb.issuedCertificate.findFirst.mockResolvedValue(null);
    await expect(findOrIssueCertificate(BASE_ARGS)).rejects.toThrow(/collided across events/);
    // Only the pre-check findFirst ran; no winner lookup.
    expect(mockDb.issuedCertificate.findFirst).toHaveBeenCalledTimes(1);
  });
});

describe("sendCertificateBundleEmail", () => {
  const SEND_ARGS = {
    eventId: "evt-1",
    organizationId: "org-1",
    recipientEmail: "jane@x.com",
    recipientName: "Dr. Jane Doe",
    registrationId: "reg-1",
    speakerId: "spk-1",
    emailSubjectTemplate: "Subject",
    emailBodyTemplate: "<p>Body</p>",
    triggeredByUserId: "user-1",
  };
  const cert = (serial: string, type: "ATTENDANCE" | "APPRECIATION") => ({
    serial,
    type,
    templateName: "T",
    pdfBuffer: Buffer.from("%PDF"),
  });

  it("sends ONE email with one attachment per cert; a bundle carrying an APPRECIATION cert anchors the EmailLog on the SPEAKER", async () => {
    const res = await sendCertificateBundleEmail({
      ...SEND_ARGS,
      certs: [cert("ATT-1", "ATTENDANCE"), cert("APP-2", "APPRECIATION")],
    });
    expect(res.success).toBe(true);
    expect(mockSend).toHaveBeenCalledTimes(1);
    const sent = mockSend.mock.calls[0][0];
    expect(sent.attachments.map((a: { name: string }) => a.name)).toEqual(["ATT-1.pdf", "APP-2.pdf"]);
    // Speaker-facet certs must stay visible on the speaker sheet's Email
    // History (it queries strictly SPEAKER) — review fix, 2026-07-10.
    expect(sent.logContext).toMatchObject({
      entityType: "SPEAKER",
      entityId: "spk-1",
      templateSlug: "certificate-delivery",
      organizationId: "org-1",
    });
  });

  it("loads the recipient's title and name when the wording uses them and the caller only had the full name", async () => {
    // The Issue worker's run items keep only recipientName; a "Dear {{title}}
    // {{lastName}}" greeting used to render as "Dear ,".
    mockLoadRecipient.mockResolvedValue({ ...RECIPIENT, title: "DR" });
    await sendCertificateBundleEmail({
      ...SEND_ARGS,
      emailBodyTemplate: "<p>Dear {{title}} {{lastName}},</p>",
      certs: [cert("ATT-1", "ATTENDANCE")],
    });
    expect(mockLoadRecipient).toHaveBeenCalledWith("reg-1", "spk-1");
    expect(mockSend.mock.calls[0][0].htmlContent).toContain("Dear Dr. Doe,");
  });

  it("still sends with what the caller had when looking the recipient up fails", async () => {
    mockLoadRecipient.mockRejectedValue(new Error("pool timeout"));
    const res = await sendCertificateBundleEmail({
      ...SEND_ARGS,
      recipientLastName: "Doe",
      emailBodyTemplate: "<p>Dear {{title}} {{lastName}},</p>",
      certs: [cert("ATT-1", "ATTENDANCE")],
    });
    expect(res.success).toBe(true);
    expect(mockSend.mock.calls[0][0].htmlContent).toContain("Dear  Doe,");
    const { apiLogger } = await import("@/lib/logger");
    expect(apiLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ msg: "cert-bundle:recipient-name-load-failed", registrationId: "reg-1" }),
    );
  });

  it("does not look the recipient up when the wording uses no name part, or the caller passed them", async () => {
    await sendCertificateBundleEmail({ ...SEND_ARGS, certs: [cert("ATT-1", "ATTENDANCE")] });
    await sendCertificateBundleEmail({
      ...SEND_ARGS,
      emailBodyTemplate: "<p>Dear {{title}} {{lastName}},</p>",
      recipientFirstName: "Jane",
      recipientLastName: "Doe",
      recipientTitle: null,
      certs: [cert("ATT-1", "ATTENDANCE")],
    });
    expect(mockLoadRecipient).not.toHaveBeenCalled();
    expect(mockSend.mock.calls[1][0].htmlContent).toContain("Dear  Doe,");
  });

  it("anchors a pure-attendance bundle on the registration", async () => {
    await sendCertificateBundleEmail({ ...SEND_ARGS, certs: [cert("ATT-1", "ATTENDANCE")] });
    expect(mockSend.mock.calls[0][0].logContext).toMatchObject({ entityType: "REGISTRATION", entityId: "reg-1" });
  });

  it("anchors on the speaker when there is no registration facet", async () => {
    await sendCertificateBundleEmail({ ...SEND_ARGS, registrationId: null, certs: [cert("APP-1", "APPRECIATION")] });
    expect(mockSend.mock.calls[0][0].logContext).toMatchObject({ entityType: "SPEAKER", entityId: "spk-1" });
  });

  it("refuses an empty bundle", async () => {
    const res = await sendCertificateBundleEmail({ ...SEND_ARGS, certs: [] });
    expect(res.success).toBe(false);
    expect(mockSend).not.toHaveBeenCalled();
  });

  it("refuses when combined attachments exceed the size cap", async () => {
    const big = { serial: "BIG-1", type: "ATTENDANCE" as const, templateName: "T", pdfBuffer: Buffer.alloc(9 * 1024 * 1024) };
    const res = await sendCertificateBundleEmail({ ...SEND_ARGS, certs: [big] });
    expect(res.success).toBe(false);
    expect(res.error).toContain("too large");
    expect(mockSend).not.toHaveBeenCalled();
  });

  it("fails cleanly when the event is gone", async () => {
    mockDb.event.findUnique.mockResolvedValue(null);
    const res = await sendCertificateBundleEmail({ ...SEND_ARGS, certs: [cert("ATT-1", "ATTENDANCE")] });
    expect(res).toEqual({ success: false, error: "Event not found" });
  });
});

// ── buildCertCoverEmailPreview ───────────────────────────────────────────────
// The token resolver is identity-mocked, so these pin the subject/body
// PRECEDENCE (single saved cover → per-category default → multi default →
// custom override) — the same rules coverEmailFor applies on the real send.

describe("buildCertCoverEmailPreview", () => {
  const PREVIEW_ATT = {
    name: "Standard Attendance",
    category: "ATTENDANCE" as const,
    emailSubject: "Sub",
    emailBody: "<p>Hi {{recipientName}}</p>",
  };
  const PREVIEW_APP = {
    name: "Speaker",
    category: "APPRECIATION" as const,
    emailSubject: null,
    emailBody: null,
  };

  beforeEach(() => {
    mockDb.event.findUnique.mockResolvedValue(SEND_EVENT);
    mockGetEventTemplate.mockResolvedValue(null);
  });

  it("single template with a saved cover email → uses it", async () => {
    const res = await buildCertCoverEmailPreview({ eventId: "evt-1", templates: [PREVIEW_ATT] });
    expect(res).toEqual({ subject: "Sub", htmlContent: "<p>Hi {{recipientName}}</p>" });
  });

  it("single template without a saved cover → per-category system default", async () => {
    const res = await buildCertCoverEmailPreview({ eventId: "evt-1", templates: [PREVIEW_APP] });
    expect(res?.subject).toContain("Your {{certificateType}}");
    expect(res?.htmlContent).toContain("{{abstractTitle}}"); // appreciation default body
  });

  it("single template without a saved cover uses the event's Email Template for its category", async () => {
    mockGetEventTemplate.mockResolvedValue({
      subject: "Org-edited appreciation subject",
      htmlContent: "<p>Org-edited appreciation</p>",
      textContent: "",
      branding: {},
    });
    const res = await buildCertCoverEmailPreview({ eventId: "evt-1", templates: [PREVIEW_APP] });
    expect(mockGetEventTemplate).toHaveBeenCalledWith("evt-1", "certificate-appreciation-delivery");
    expect(res?.subject).toBe("Org-edited appreciation subject");
    // A template with its own saved cover never reads the event template.
    mockGetEventTemplate.mockClear();
    const own = await buildCertCoverEmailPreview({ eventId: "evt-1", templates: [PREVIEW_ATT] });
    expect(own?.subject).toBe("Sub");
    expect(mockGetEventTemplate).not.toHaveBeenCalled();
  });

  it("multiple templates → multi (bundle) system default", async () => {
    const res = await buildCertCoverEmailPreview({
      eventId: "evt-1",
      templates: [PREVIEW_ATT, PREVIEW_APP],
    });
    expect(res?.subject).toContain("Your certificates");
    expect(res?.htmlContent).toContain("{{certificateList}}");
  });

  it("multi preview uses the event's editable bundle cover template when present", async () => {
    mockGetEventTemplate.mockResolvedValue({
      subject: "Org-edited certs subject",
      htmlContent: "<p>Org-edited {{certificateList}}</p>",
      textContent: "",
      branding: {},
    });
    const res = await buildCertCoverEmailPreview({
      eventId: "evt-1",
      templates: [PREVIEW_ATT, PREVIEW_APP],
    });
    expect(mockGetEventTemplate).toHaveBeenCalledWith("evt-1", "certificate-bundle-delivery");
    expect(res?.subject).toBe("Org-edited certs subject");
    expect(res?.htmlContent).toContain("Org-edited");
  });

  it("operator custom subject/message override wins over everything", async () => {
    const res = await buildCertCoverEmailPreview({
      eventId: "evt-1",
      templates: [PREVIEW_ATT, PREVIEW_APP],
      customSubject: "Here are your certs",
      customMessage: "<p>Custom {{certificateList}}</p>",
    });
    expect(res).toEqual({
      subject: "Here are your certs",
      htmlContent: "<p>Custom {{certificateList}}</p>",
    });
  });

  it("returns null when the event vanished or no templates passed", async () => {
    mockDb.event.findUnique.mockResolvedValue(null);
    expect(await buildCertCoverEmailPreview({ eventId: "evt-1", templates: [PREVIEW_ATT] })).toBeNull();
    mockDb.event.findUnique.mockResolvedValue(SEND_EVENT);
    expect(await buildCertCoverEmailPreview({ eventId: "evt-1", templates: [] })).toBeNull();
  });
});

describe("buildCertCoverTemplatePreview (Email Templates editor)", () => {
  beforeEach(() => {
    mockDb.event.findUnique.mockResolvedValue(SEND_EVENT);
  });

  it("renders a certificate cover template for the sample recipient, title included", async () => {
    const res = await buildCertCoverTemplatePreview({
      eventId: "evt-1",
      slug: "certificate-appreciation-delivery",
      subject: "Your {{certificateType}}",
      htmlContent: "<p>Dear {{title}} {{lastName}},</p>",
    });
    expect(res?.subject).toBe("Your {{certificateType}}");
    expect(res?.htmlContent).toContain("Dear Dr. Attendee,");
  });

  it("returns null without reading anything for a slug that is not a certificate cover", async () => {
    const res = await buildCertCoverTemplatePreview({
      eventId: "evt-1",
      slug: "registration-confirmation",
      subject: "s",
      htmlContent: "<p>h</p>",
    });
    expect(res).toBeNull();
    expect(mockDb.event.findUnique).not.toHaveBeenCalled();
  });
});

describe("sendCertificateBundleEmail — event auto-CC and stream (Sep 18, 2026)", () => {
  const args = {
    eventId: "evt-1",
    organizationId: "org-1",
    recipientEmail: "jane@x.com",
    recipientName: "Dr. Jane Doe",
    registrationId: "reg-1",
    speakerId: null,
    certs: [{ serial: "ATT-1", type: "ATTENDANCE" as const, templateName: "T", pdfBuffer: Buffer.from("%PDF") }],
    emailSubjectTemplate: "Subject",
    emailBodyTemplate: "<p>Body</p>",
    triggeredByUserId: "user-1",
    event: { ...SEND_EVENT, emailCcAddresses: ["finance@x.com", "JANE@x.com"] },
  };

  it("CCs the event's auto-CC list minus the recipient, like every other attendee email", async () => {
    await sendCertificateBundleEmail(args);
    const sent = mockSend.mock.calls[0][0];
    expect(sent.cc).toEqual([{ email: "finance@x.com" }]);
  });

  it("a run or a Communications send is a bulk stream; a single issue stays transactional", async () => {
    await sendCertificateBundleEmail({ ...args, stream: "bulk" });
    expect(mockSend.mock.calls[0][0].stream).toBe("bulk");
    mockSend.mockClear();
    await sendCertificateBundleEmail(args);
    expect(mockSend.mock.calls[0][0].stream).toBe("transactional");
  });
});
