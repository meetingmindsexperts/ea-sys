/**
 * CRM inbox — outbound threading (Batch 1).
 *
 * Pins: the env-driven dormancy contract (no CRM_REPLY_DOMAIN → no Reply-To,
 * but thread rows STILL record as sent-history), token shape, org-bound append,
 * the never-throws bookkeeping rule, and the sendOne wiring (Reply-To carries
 * the token when the domain is set; a FAILED send records no thread).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// The organisation's reply domain (crm-email-identity.ts), driven here by
// CRM_REPLY_DOMAIN so each test can switch it; resolveIdentity has its own tests.
vi.mock("@/lib/crm-email-identity", () => ({
  crmEmailIdentity: vi.fn(async () => ({
    sender: null,
    forwardTo: null,
    replyDomain: process.env.CRM_REPLY_DOMAIN ?? null,
    captureAddress: null,
    source: "environment",
  })),
}));

vi.mock("@/lib/logger", () => ({
  apiLogger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

// The transaction client is its OWN object, so a test can tell a statement run
// inside the tenant transaction from one run on the bare client.
const { tx } = vi.hoisted(() => ({ tx: { $executeRaw: vi.fn(), crmEmailMessage: { create: vi.fn() } } }));

vi.mock("@/lib/db", () => ({
  db: {
    event: { findFirst: vi.fn() },
    crmDeal: { findMany: vi.fn(), findFirst: vi.fn() },
    user: { findUnique: vi.fn() },
    crmEmailThread: { create: vi.fn(), updateMany: vi.fn(), findFirst: vi.fn() },
    crmEmailMessage: { create: vi.fn() },
    $executeRaw: vi.fn(),
  },
  // tenantTransaction with the flag off IS db.$transaction: hand over the tx.
  tenantTransaction: (fn: (t: typeof tx) => Promise<unknown>) => fn(tx),
}));

vi.mock("@/lib/email", () => ({
  sendEmail: vi.fn(),
  renderAndWrap: vi.fn(() => ({ subject: "Rendered subject", htmlContent: "<p>h</p>", textContent: "t" })),
  brandingFrom: vi.fn(() => ({ email: "events@mmg.com", name: "MMG Events" })),
  brandingCc: vi.fn(() => undefined),
  sesRfcMessageId: vi.fn((id: string) => `<${id}@ap-south-1.amazonses.com>`),
}));

vi.mock("@/crm/lib/crm-activity", () => ({
  recordCrmActivity: vi.fn(() => Promise.resolve({})),
}));

import { db } from "@/lib/db";
import { sendEmail } from "@/lib/email";
import { apiLogger } from "@/lib/logger";
import {
  crmReplyAddress,
  mintReplyToken,
  recordOutboundEmail,
} from "@/crm/services/crm-email-thread-service";
import { sendDealEmail } from "@/crm/services/sponsor-email-service";

const ORG = "org-1";

const baseRecord = {
  organizationId: ORG,
  dealId: "d-1",
  crmContactId: "c-1",
  counterpartyEmail: "Jane@Abbott.com",
  counterpartyName: "Jane Doe",
  subject: "Sponsorship",
  htmlBody: "<p>hi</p>",
  textBody: "hi",
  replyToken: "tok123",
  providerMessageId: "ses-1",
  sentByUserId: "u-1",
  fromEmail: "events@mmg.com",
  fromName: "MMG",
};

afterEach(() => {
  delete process.env.CRM_REPLY_DOMAIN;
});

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env.CRM_REPLY_DOMAIN;
  vi.mocked(db.crmEmailThread.create).mockResolvedValue({} as never);
  vi.mocked(db.crmEmailThread.updateMany).mockResolvedValue({ count: 1 } as never);
  vi.mocked(db.crmEmailMessage.create).mockResolvedValue({} as never);
  tx.crmEmailMessage.create.mockResolvedValue({});
});

describe("env dormancy contract", () => {
  it("no reply domain on the organisation → no address", () => {
    expect(crmReplyAddress("tok", null)).toBeNull();
  });

  it("with the organisation's domain, the address is <token>@domain", () => {
    expect(crmReplyAddress("abc123", "reply.mmg.com")).toBe("abc123@reply.mmg.com");
  });

  it("tokens are 20 hex chars and unique per mint", () => {
    const a = mintReplyToken();
    const b = mintReplyToken();
    expect(a).toMatch(/^[0-9a-f]{20}$/);
    expect(a).not.toBe(b);
  });
});

describe("recordOutboundEmail", () => {
  it("new send → thread + first message in one create; counterparty email lowercased", async () => {
    await recordOutboundEmail(baseRecord);

    const data = vi.mocked(db.crmEmailThread.create).mock.calls[0]![0]!.data as Record<string, unknown>;
    expect(data.organizationId).toBe(ORG);
    expect(data.dealId).toBe("d-1");
    expect(data.replyToken).toBe("tok123");
    expect(data.counterpartyEmail).toBe("jane@abbott.com");
    const msg = (data.messages as { create: Record<string, unknown> }).create;
    expect(msg.direction).toBe("OUTBOUND");
    expect(msg.htmlBody).toBe("<p>hi</p>");
    expect(msg.providerMessageId).toBe("ses-1");
  });

  it("append mode is ORG-BOUND — a foreign threadId records nothing", async () => {
    tx.$executeRaw.mockResolvedValue(0);

    await recordOutboundEmail({ ...baseRecord, threadId: "other-orgs-thread" });

    const values = tx.$executeRaw.mock.calls[0]!.slice(1);
    expect(values).toContain("other-orgs-thread");
    expect(values).toContain(ORG);
    expect(tx.crmEmailMessage.create).not.toHaveBeenCalled();
    expect(apiLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ msg: "crm-email-thread:append-thread-not-found", threadId: "other-orgs-thread" }),
    );
  });

  // Nov 11, 2026: the update ran as db.$executeRaw. A raw statement on the bare
  // client carries no tenant setting, so under row-level security it matched no
  // thread: the reply went out and was never recorded. Proven against the
  // policies in tests/tenancy/crm-email-append-rls.test.ts; this pins the shape.
  it("append mode runs the update AND the message inside the tenant transaction, never on the bare client", async () => {
    tx.$executeRaw.mockResolvedValue(1);

    await recordOutboundEmail({ ...baseRecord, threadId: "t-1" });

    expect(tx.$executeRaw).toHaveBeenCalledTimes(1);
    expect(tx.crmEmailMessage.create).toHaveBeenCalledTimes(1);
    expect(db.$executeRaw).not.toHaveBeenCalled();
    expect(db.crmEmailMessage.create).not.toHaveBeenCalled();
  });

  it("append mode: a message that will not save is logged, and nothing is thrown at the sender", async () => {
    tx.$executeRaw.mockResolvedValue(1);
    tx.crmEmailMessage.create.mockRejectedValue(new Error("db down"));

    await expect(recordOutboundEmail({ ...baseRecord, threadId: "t-1" })).resolves.toBeUndefined();
    // The failed append rolls back whole, so the log line must name the thread.
    expect(apiLogger.error).toHaveBeenCalledWith(
      expect.objectContaining({ msg: "crm-email-thread:record-outbound-failed", threadId: "t-1" }),
    );
  });

  it("append mode appends the message with its Message-ID; only INTERNAL colleagues a reply copied join the forward list", async () => {
    tx.$executeRaw.mockResolvedValue(1);
    await recordOutboundEmail({
      ...baseRecord,
      threadId: "t-1",
      messageId: "<ses-1@ap-south-1.amazonses.com>",
      notifyEmails: ["Boss@MeetingMindsDubai.com", "agency@outside.example"],
    });

    // One statement (no read-then-write race); the external address is dropped.
    const values = tx.$executeRaw.mock.calls[0]!.slice(1);
    expect(values).toContainEqual(["boss@meetingmindsdubai.com"]);
    expect(JSON.stringify(values)).not.toContain("agency@outside.example");
    expect(tx.crmEmailMessage.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          threadId: "t-1",
          direction: "OUTBOUND",
          messageId: "<ses-1@ap-south-1.amazonses.com>",
        }),
      }),
    );
    expect(db.crmEmailThread.create).not.toHaveBeenCalled();
  });

  it("NEVER throws — the email already left; a DB failure logs and returns", async () => {
    vi.mocked(db.crmEmailThread.create).mockRejectedValue(new Error("db down") as never);

    await expect(recordOutboundEmail(baseRecord)).resolves.toBeUndefined();
    expect(apiLogger.error).toHaveBeenCalledWith(
      expect.objectContaining({ msg: "crm-email-thread:record-outbound-failed" }),
    );
  });
});

describe("sendOne wiring (via sendDealEmail)", () => {
  const deal = {
    id: "d-1",
    name: "Abbott deal",
    company: { name: "Abbott" },
    contacts: [
      {
        crmContact: {
          id: "c-1",
          firstName: "Jane",
          lastName: "Doe",
          email: "jane@abbott.com",
          emailKey: "jane@abbott.com",
          archivedAt: null,
          company: { name: "Abbott" },
        },
      },
    ],
    event: null,
  };

  beforeEach(() => {
    vi.mocked(db.crmDeal.findFirst).mockResolvedValue(deal as never);
    vi.mocked(db.user.findUnique).mockResolvedValue({ emailSignature: "" } as never);
    vi.mocked(sendEmail).mockResolvedValue({ success: true, messageId: "ses-9" } as never);
  });

  const sendArgs = {
    organizationId: ORG,
    dealId: "d-1",
    subject: "Hello",
    message: "<p>body</p>",
    actorUserId: "u-1",
    source: "rest" as const,
  };

  it("domain set → the send carries a tokenized Reply-To and the thread stores the SAME token", async () => {
    process.env.CRM_REPLY_DOMAIN = "reply.mmg.com";

    const res = await sendDealEmail(sendArgs);
    expect(res.ok).toBe(true);

    const sendParams = vi.mocked(sendEmail).mock.calls[0]![0] as { replyTo?: { email: string } };
    expect(sendParams.replyTo?.email).toMatch(/^[0-9a-f]{20}@reply\.mmg\.com$/);
    const token = sendParams.replyTo!.email.split("@")[0];

    const threadData = vi.mocked(db.crmEmailThread.create).mock.calls[0]![0]!.data as Record<string, unknown>;
    expect(threadData.replyToken).toBe(token);
    expect(threadData.dealId).toBe("d-1");
  });

  it("domain unset → NO Reply-To (behavior unchanged) but the thread still records", async () => {
    const res = await sendDealEmail(sendArgs);
    expect(res.ok).toBe(true);

    const sendParams = vi.mocked(sendEmail).mock.calls[0]![0] as { replyTo?: unknown };
    expect(sendParams.replyTo).toBeUndefined();
    expect(db.crmEmailThread.create).toHaveBeenCalledOnce();
  });

  it("a FAILED send records no thread — the inbox never shows an email that didn't go", async () => {
    vi.mocked(sendEmail).mockResolvedValue({ success: false, error: "bounce" } as never);

    const res = await sendDealEmail(sendArgs);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.failureCount).toBe(1);
    expect(db.crmEmailThread.create).not.toHaveBeenCalled();
  });
});
