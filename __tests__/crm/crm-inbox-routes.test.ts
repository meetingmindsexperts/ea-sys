/**
 * CRM inbox routes (Batch 3).
 *
 * Pins: the staff-only boundary (MEMBER passes the generic CRM read gate but
 * must NEVER read sponsor negotiation threads — 403 on every inbox surface,
 * using the REAL canViewCrmInbox predicate), org-bound lookups, the
 * shared-inbox unread-clear on open, the reply flow (send → append via
 * recordOutboundEmail with threadId; a failed send records NOTHING), and
 * composer HTML escaping.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/logger", () => ({
  apiLogger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

vi.mock("@/lib/db", () => ({
  db: {
    crmEmailThread: { findMany: vi.fn(), findFirst: vi.fn(), count: vi.fn(), updateMany: vi.fn() },
    crmEmailMessage: { findFirst: vi.fn() },
    user: { findUnique: vi.fn() },
  },
}));

const fsMock = vi.hoisted(() => ({ realpath: vi.fn(), readFile: vi.fn() }));
vi.mock("fs/promises", () => ({ default: fsMock, ...fsMock }));

vi.mock("@/lib/email", () => ({ sendEmail: vi.fn() }));
vi.mock("@/crm/lib/crm-activity", () => ({ recordCrmActivity: vi.fn(() => Promise.resolve({})) }));
vi.mock("@/crm/services/crm-email-thread-service", () => ({
  crmReplyAddress: vi.fn((token: string) => `${token}@reply.mmg.com`),
  recordOutboundEmail: vi.fn(() => Promise.resolve()),
}));

// The reply route resolves its From via crmSenderFrom — stub it (its real impl
// calls brandingFrom from @/lib/email, which this file mocks down to sendEmail).
vi.mock("@/crm/services/sponsor-email-service", () => ({
  crmSenderFrom: vi.fn(() => undefined),
}));

// Gates pass-through with a configurable role — canViewCrmInbox stays REAL.
// Full module mock (importOriginal would drag next-auth into vitest via
// getOrgContext); the gates themselves are pinned by the gate-drift test.
const gate = vi.hoisted(() => ({ role: "ADMIN", fromApiKey: false }));
vi.mock("@/crm/lib/crm-route", () => ({
  requireCrmRead: vi.fn(async () => ({
    ctx: { organizationId: "org-1", userId: "u-1", role: gate.role, fromApiKey: gate.fromApiKey },
  })),
  requireCrmWrite: vi.fn(async () => ({
    ctx: { organizationId: "org-1", userId: "u-1", role: gate.role, fromApiKey: gate.fromApiKey },
  })),
  crmErrorResponse: vi.fn(() => new Response(null, { status: 500 })),
}));

import { db } from "@/lib/db";
import { sendEmail } from "@/lib/email";
import { recordOutboundEmail } from "@/crm/services/crm-email-thread-service";
import { GET as listThreads } from "@/app/api/crm/inbox/route";
import { GET as getThread } from "@/app/api/crm/inbox/[threadId]/route";
import { POST as postReply, composeReplyHtml } from "@/app/api/crm/inbox/[threadId]/reply/route";
import { GET as getAttachment } from "@/app/api/crm/inbox/messages/[messageId]/attachments/[index]/route";

const threadDetail = {
  id: "t-1",
  subject: "Sponsorship",
  replyToken: "abcdef0123456789abcd",
  counterpartyEmail: "jane@abbott.com",
  counterpartyName: "Jane Doe",
  hasUnread: true,
  lastMessageAt: new Date(),
  createdAt: new Date(),
  deal: { id: "d-1", name: "Abbott deal" },
  crmContact: null,
  messages: [],
};

const threadParams = Promise.resolve({ threadId: "t-1" });
const replyReq = () =>
  new Request("http://test/api/crm/inbox/t-1/reply", {
    method: "POST",
    body: JSON.stringify({ message: "Thanks — attached below." }),
  });

beforeEach(() => {
  vi.clearAllMocks();
  gate.role = "ADMIN";
  gate.fromApiKey = false;
  vi.mocked(db.crmEmailThread.findMany).mockResolvedValue([] as never);
  vi.mocked(db.crmEmailThread.count).mockResolvedValue(0 as never);
  vi.mocked(db.crmEmailThread.findFirst).mockResolvedValue(threadDetail as never);
  vi.mocked(db.crmEmailThread.updateMany).mockResolvedValue({ count: 1 } as never);
  vi.mocked(db.user.findUnique).mockResolvedValue({
    emailSignature: "<p>— Sara</p>",
    firstName: "Sara",
    lastName: "K",
  } as never);
  vi.mocked(sendEmail).mockResolvedValue({ success: true, messageId: "ses-1" } as never);
  vi.mocked(db.crmEmailMessage.findFirst).mockResolvedValue({
    attachments: [{ filename: "quote.pdf", mimeType: "application/pdf", path: "/uploads/crm-email-attachments/t-1/abc.pdf" }],
  } as never);
  fsMock.realpath.mockImplementation(async (p: string) => p);
  fsMock.readFile.mockResolvedValue(Buffer.from("%PDF-1.7"));
});

const attParams = Promise.resolve({ messageId: "m-1", index: "0" });

describe("staff-only boundary (real canViewCrmInbox)", () => {
  it("MEMBER is 403 on the list, the thread, the reply AND an attachment — never reads rival negotiations", async () => {
    gate.role = "MEMBER";
    expect((await listThreads(new Request("http://test/api/crm/inbox"))).status).toBe(403);
    expect((await getThread(new Request("http://test"), { params: threadParams })).status).toBe(403);
    expect((await postReply(replyReq(), { params: threadParams })).status).toBe(403);
    expect((await getAttachment(new Request("http://test"), { params: attParams })).status).toBe(403);
    expect(db.crmEmailThread.findMany).not.toHaveBeenCalled();
    expect(db.crmEmailMessage.findFirst).not.toHaveBeenCalled();
    expect(fsMock.readFile).not.toHaveBeenCalled();
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it("CRM_USER reads the shared inbox (owner decision: one bulk inbox for staff)", async () => {
    gate.role = "CRM_USER";
    expect((await listThreads(new Request("http://test/api/crm/inbox"))).status).toBe(200);
  });
});

describe("thread detail", () => {
  it("is org-bound and clears the unread flag on open (shared-inbox semantics)", async () => {
    const res = await getThread(new Request("http://test"), { params: threadParams });
    expect(res.status).toBe(200);
    expect(db.crmEmailThread.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "t-1", organizationId: "org-1" } }),
    );
    expect(db.crmEmailThread.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "t-1", organizationId: "org-1", hasUnread: true },
        data: { hasUnread: false },
      }),
    );
  });

  it("an already-read thread costs no write", async () => {
    vi.mocked(db.crmEmailThread.findFirst).mockResolvedValue({ ...threadDetail, hasUnread: false } as never);
    await getThread(new Request("http://test"), { params: threadParams });
    expect(db.crmEmailThread.updateMany).not.toHaveBeenCalled();
  });
});

describe("reply", () => {
  it("sends to the counterparty with the thread's OWN token as Reply-To and appends via threadId", async () => {
    const res = await postReply(replyReq(), { params: threadParams });
    expect(res.status).toBe(200);

    const sent = vi.mocked(sendEmail).mock.calls[0]![0] as {
      to: Array<{ email: string }>;
      replyTo?: { email: string };
      subject: string;
    };
    expect(sent.to[0].email).toBe("jane@abbott.com");
    expect(sent.replyTo?.email).toBe("abcdef0123456789abcd@reply.mmg.com");
    expect(sent.subject).toBe("Re: Sponsorship");

    expect(recordOutboundEmail).toHaveBeenCalledWith(
      expect.objectContaining({ threadId: "t-1", replyToken: "abcdef0123456789abcd" }),
    );
  });

  it("a subject already starting Re: is not double-prefixed", async () => {
    vi.mocked(db.crmEmailThread.findFirst).mockResolvedValue({
      ...threadDetail,
      subject: "RE: Sponsorship",
    } as never);
    await postReply(replyReq(), { params: threadParams });
    const sent = vi.mocked(sendEmail).mock.calls[0]![0] as { subject: string };
    expect(sent.subject).toBe("RE: Sponsorship");
  });

  it("a FAILED send is a 502 and records NOTHING — the thread never shows an unsent reply", async () => {
    vi.mocked(sendEmail).mockResolvedValue({ success: false, error: "ses down" } as never);
    const res = await postReply(replyReq(), { params: threadParams });
    expect(res.status).toBe(502);
    expect(recordOutboundEmail).not.toHaveBeenCalled();
  });

  it("a foreign thread 404s before any send", async () => {
    vi.mocked(db.crmEmailThread.findFirst).mockResolvedValue(null as never);
    const res = await postReply(replyReq(), { params: threadParams });
    expect(res.status).toBe(404);
    expect(sendEmail).not.toHaveBeenCalled();
  });
});

describe("composeReplyHtml", () => {
  it("escapes typed text (a pasted <script> can't ride the org sender) and keeps the signature raw", () => {
    const html = composeReplyHtml("Hi <script>alert(1)</script>\n\nBest", "<p>— Sara</p>");
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("<p>— Sara</p>");
  });

  it("double newlines become paragraphs, single ones line breaks", () => {
    const html = composeReplyHtml("a\nb\n\nc", "");
    expect(html).toContain("a<br />b");
    expect((html.match(/<p /g) ?? []).length).toBe(2);
  });
});
