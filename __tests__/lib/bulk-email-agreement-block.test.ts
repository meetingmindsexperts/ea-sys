/**
 * executeBulkEmail — {{agreementBlock}} / {{agreementLink}} minting rules
 * (July 16, 2026, the merged invitation+agreement feature).
 *
 * The load-bearing properties:
 *   1. The link is minted ONLY when the template uses an agreement token —
 *      an unrelated send must never rotate (invalidate) a previously-emailed
 *      agreement link.
 *   2. Signed speakers are never re-asked (no mint, "already accepted" note).
 *   3. Bulk AGREEMENT sends now mint {{agreementLink}} per recipient — they
 *      previously left the default template's CTA href as the literal token.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const {
  mockDb,
  mockSendEmail,
  mockRenderAndWrap,
  mockGetDefaultTemplate,
  mockGetEventTemplate,
  mockMintAgreementLink,
  mockGenAgreementPdf,
} = vi.hoisted(() => ({
  mockDb: {
    event: { findFirst: vi.fn() },
    speaker: { findMany: vi.fn() },
  },
  mockSendEmail: vi.fn(),
  mockRenderAndWrap: vi.fn(),
  mockGetDefaultTemplate: vi.fn(),
  mockGetEventTemplate: vi.fn(),
  mockMintAgreementLink: vi.fn(),
  mockGenAgreementPdf: vi.fn(),
}));

vi.mock("@/lib/db", () => ({ db: mockDb }));
vi.mock("@/lib/logger", () => ({
  apiLogger: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));
vi.mock("@/lib/email", () => ({
  sendEmail: (args: unknown) => mockSendEmail(args),
  getEventTemplate: (...args: unknown[]) => mockGetEventTemplate(...args),
  getDefaultTemplate: (slug: string) => mockGetDefaultTemplate(slug),
  renderMessageValue: vi.fn((m: string) => m),
  renderAndWrap: (...args: unknown[]) => mockRenderAndWrap(...args),
  brandingFrom: vi.fn().mockReturnValue({ email: "from@x.com", name: "From" }),
  brandingCc: vi.fn().mockReturnValue([]),
}));
vi.mock("@/lib/speaker-agreement", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/speaker-agreement")>();
  return {
    ...actual,
    buildSpeakerEmailContext: vi.fn().mockResolvedValue(null),
    generateSpeakerAgreementDocx: vi.fn(),
    generateSpeakerAgreementPdf: (...args: unknown[]) => mockGenAgreementPdf(...args),
    // Real pickAgreementAttachmentMode (from importOriginal) so the soft
    // attach-when-possible gate reads the EVENT fixture's actual content.
    mintSpeakerAgreementLink: (...args: unknown[]) => mockMintAgreementLink(...args),
  };
});
vi.mock("@/lib/email-barcode", () => ({
  buildEntryBarcode: vi.fn(),
  templateUsesEntryBarcode: vi.fn().mockReturnValue(false),
}));
vi.mock("@/lib/payment-reminder", () => ({ buildPaymentReminderVars: vi.fn() }));
vi.mock("@/lib/certificates/bundle", () => ({ loadCertTemplate: vi.fn() }));
vi.mock("@/lib/certificates/bulk-issue", () => ({ executeCertificateBulkSend: vi.fn() }));

import { executeBulkEmail } from "@/lib/bulk-email";

const EVENT = {
  id: "evt-1",
  slug: "osh",
  name: "OSH",
  startDate: new Date("2026-07-01"),
  venue: "Dubai",
  address: null,
  settings: {},
  emailFromAddress: "from@x.com",
  emailFromName: "From",
  emailCcAddresses: null,
  emailHeaderImage: null,
  emailFooterImage: null,
  emailFooterHtml: null,
  speakerAgreementTemplate: null,
  speakerAgreementHtml: "<p>Agreement text</p>",
  surveyConfig: null,
  taxRate: null,
  taxLabel: null,
};

function speaker(id: string, agreementAcceptedAt: Date | null = null) {
  return {
    id,
    email: `${id}@x.com`,
    additionalEmail: null,
    firstName: "A",
    lastName: "B",
    title: "DR",
    agreementAcceptedAt,
  };
}

const BASE_INPUT = {
  eventId: "evt-1",
  recipientType: "speakers" as const,
  emailType: "invitation" as const,
  filters: {},
  organizerName: "Org",
  organizerEmail: "org@x.com",
  organizationId: "org-1",
  triggeredByUserId: "user-1",
};

const TPL_WITH_BLOCK = {
  subject: "{{eventName}}",
  htmlContent: "<p>Hi {{speakerName}}</p>{{agreementBlock}}",
  textContent: "{{agreementBlockText}}",
};
const TPL_WITHOUT_TOKENS = {
  subject: "{{eventName}}",
  htmlContent: "<p>Hi {{speakerName}}</p>",
  textContent: "Hi",
};

beforeEach(() => {
  vi.clearAllMocks();
  mockDb.event.findFirst.mockResolvedValue(EVENT);
  mockDb.speaker.findMany.mockResolvedValue([speaker("spk-1")]);
  mockGetEventTemplate.mockResolvedValue(null);
  mockGetDefaultTemplate.mockReturnValue(TPL_WITH_BLOCK);
  mockRenderAndWrap.mockReturnValue({ subject: "S", htmlContent: "<p>H</p>", textContent: "T" });
  mockSendEmail.mockResolvedValue({ success: true });
  mockMintAgreementLink.mockResolvedValue("https://x.com/e/osh/speaker-agreement?token=tok1");
  mockGenAgreementPdf.mockResolvedValue({ filename: "agreement.pdf", buffer: Buffer.from("pdf") });
});

function varsHandedToRenderer(): Record<string, unknown> {
  expect(mockRenderAndWrap).toHaveBeenCalled();
  return mockRenderAndWrap.mock.calls[0][1] as Record<string, unknown>;
}

describe("executeBulkEmail — {{agreementBlock}} minting", () => {
  it("mints per recipient and renders the CTA when the template uses the token", async () => {
    const res = await executeBulkEmail(BASE_INPUT);
    expect(res.successCount).toBe(1);
    expect(mockMintAgreementLink).toHaveBeenCalledWith("spk-1", "osh");
    const vars = varsHandedToRenderer();
    expect(vars.agreementLink).toBe("https://x.com/e/osh/speaker-agreement?token=tok1");
    expect(String(vars.agreementBlock)).toContain("Review &amp; Agree");
    expect(String(vars.agreementBlockText)).toContain("token=tok1");
  });

  it("does NOT mint (no token rotation) when the template has no agreement token", async () => {
    mockGetDefaultTemplate.mockReturnValue(TPL_WITHOUT_TOKENS);
    await executeBulkEmail(BASE_INPUT);
    expect(mockMintAgreementLink).not.toHaveBeenCalled();
    const vars = varsHandedToRenderer();
    expect(vars.agreementBlock).toBe("");
  });

  it("does NOT re-ask a signed speaker — no mint, already-accepted note", async () => {
    mockDb.speaker.findMany.mockResolvedValue([speaker("spk-1", new Date("2026-07-01"))]);
    await executeBulkEmail(BASE_INPUT);
    expect(mockMintAgreementLink).not.toHaveBeenCalled();
    const vars = varsHandedToRenderer();
    expect(String(vars.agreementBlock)).toContain("already reviewed and accepted");
    expect(vars.agreementLink).toBe("");
  });

  it("bulk AGREEMENT sends now mint {{agreementLink}} (was the literal token)", async () => {
    mockGetDefaultTemplate.mockReturnValue({
      subject: "Agreement — {{eventName}}",
      htmlContent: '<a href="{{agreementLink}}">Review &amp; Accept Agreement</a>',
      textContent: "{{agreementLink}}",
    });
    await executeBulkEmail({ ...BASE_INPUT, emailType: "agreement" });
    expect(mockMintAgreementLink).toHaveBeenCalledWith("spk-1", "osh");
    const vars = varsHandedToRenderer();
    expect(vars.agreementLink).toBe("https://x.com/e/osh/speaker-agreement?token=tok1");
  });

  it("a mint failure is captured per-recipient, not batch-fatal", async () => {
    mockDb.speaker.findMany.mockResolvedValue([speaker("spk-1"), speaker("spk-2")]);
    mockMintAgreementLink
      .mockRejectedValueOnce(new Error("db blip"))
      .mockResolvedValueOnce("https://x.com/e/osh/speaker-agreement?token=tok2");
    const res = await executeBulkEmail(BASE_INPUT);
    expect(res.successCount).toBe(1);
    expect(res.failureCount).toBe(1);
  });
});

describe("executeBulkEmail — attach-when-possible agreement document (owner decision)", () => {
  it("an invitation whose template uses {{agreementBlock}} attaches the personalized agreement", async () => {
    const res = await executeBulkEmail(BASE_INPUT);
    expect(res.successCount).toBe(1);
    expect(mockGenAgreementPdf).toHaveBeenCalledWith({ eventId: "evt-1", speakerId: "spk-1" });
    const sent = mockSendEmail.mock.calls[0][0] as { attachments?: { name: string }[] };
    expect(sent.attachments?.map((a) => a.name)).toContain("agreement.pdf");
  });

  it("skips the attachment for a speaker who already signed", async () => {
    mockDb.speaker.findMany.mockResolvedValue([speaker("spk-1", new Date("2026-07-01"))]);
    const res = await executeBulkEmail(BASE_INPUT);
    expect(res.successCount).toBe(1);
    expect(mockGenAgreementPdf).not.toHaveBeenCalled();
  });

  it("sends CTA-only (no failure) when the event has no agreement content configured", async () => {
    mockDb.event.findFirst.mockResolvedValue({
      ...EVENT,
      speakerAgreementHtml: null,
      speakerAgreementTemplate: null,
    });
    const res = await executeBulkEmail(BASE_INPUT);
    expect(res.successCount).toBe(1);
    expect(mockGenAgreementPdf).not.toHaveBeenCalled();
  });

  it("a soft-attach generation failure still sends the email (CTA works without the PDF)", async () => {
    mockGenAgreementPdf.mockRejectedValue(new Error("pdfkit blip"));
    const res = await executeBulkEmail(BASE_INPUT);
    expect(res.successCount).toBe(1);
    expect(res.failureCount).toBe(0);
    const sent = mockSendEmail.mock.calls[0][0] as { attachments?: { name: string }[] };
    expect(sent.attachments ?? []).toEqual([]);
  });

  it("a STRICT agreement-type generation failure still fails the recipient (unchanged)", async () => {
    mockGenAgreementPdf.mockRejectedValue(new Error("pdfkit blip"));
    const res = await executeBulkEmail({ ...BASE_INPUT, emailType: "agreement" });
    expect(res.failureCount).toBe(1);
  });

  it("a template with no agreement token attaches nothing on an invitation", async () => {
    mockGetDefaultTemplate.mockReturnValue(TPL_WITHOUT_TOKENS);
    const res = await executeBulkEmail(BASE_INPUT);
    expect(res.successCount).toBe(1);
    expect(mockGenAgreementPdf).not.toHaveBeenCalled();
  });
});
