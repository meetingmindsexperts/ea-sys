/**
 * CRM inbox — outbound threading (Batch 1).
 *
 * Pins: the env-driven dormancy contract (no CRM_REPLY_DOMAIN → no Reply-To,
 * but thread rows STILL record as sent-history), token shape, org-bound append,
 * the never-throws bookkeeping rule, and the sendOne wiring (Reply-To carries
 * the token when the domain is set; a FAILED send records no thread).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("@/lib/logger", () => ({
  apiLogger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

vi.mock("@/lib/db", () => ({
  db: {
    event: { findFirst: vi.fn() },
    crmDeal: { findMany: vi.fn(), findFirst: vi.fn() },
    user: { findUnique: vi.fn() },
    crmEmailThread: { create: vi.fn(), updateMany: vi.fn() },
    crmEmailMessage: { create: vi.fn() },
  },
}));

vi.mock("@/lib/email", () => ({
  sendEmail: vi.fn(),
  renderAndWrap: vi.fn(() => ({ subject: "Rendered subject", htmlContent: "<p>h</p>", textContent: "t" })),
  brandingFrom: vi.fn(() => ({ email: "events@mmg.com", name: "MMG Events" })),
  brandingCc: vi.fn(() => undefined),
}));

vi.mock("@/crm/lib/crm-activity", () => ({
  recordCrmActivity: vi.fn(() => Promise.resolve({})),
}));

import { db } from "@/lib/db";
import { sendEmail } from "@/lib/email";
import { apiLogger } from "@/lib/logger";
import {
  crmReplyAddress,
  crmReplyDomain,
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
});

describe("env dormancy contract", () => {
  it("no CRM_REPLY_DOMAIN → domain null, address null", () => {
    expect(crmReplyDomain()).toBeNull();
    expect(crmReplyAddress("tok")).toBeNull();
  });

  it("with the domain set, the address is <token>@domain", () => {
    process.env.CRM_REPLY_DOMAIN = "reply.mmg.com";
    expect(crmReplyAddress("abc123")).toBe("abc123@reply.mmg.com");
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
    vi.mocked(db.crmEmailThread.updateMany).mockResolvedValue({ count: 0 } as never);

    await recordOutboundEmail({ ...baseRecord, threadId: "other-orgs-thread" });

    expect(db.crmEmailThread.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "other-orgs-thread", organizationId: ORG } }),
    );
    expect(db.crmEmailMessage.create).not.toHaveBeenCalled();
  });

  it("append mode bumps lastMessageAt and appends the message", async () => {
    await recordOutboundEmail({ ...baseRecord, threadId: "t-1" });

    expect(db.crmEmailMessage.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ threadId: "t-1", direction: "OUTBOUND" }) }),
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
