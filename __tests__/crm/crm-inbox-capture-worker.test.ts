/**
 * The inbound worker's partnerships capture path (Oct 27, 2026): an email with
 * no reply token that names the partnerships mailbox is filed into the inbox.
 * Pins: dormancy without CRM_CAPTURE_ORG_ID / CRM_CAPTURE_ADDRESS, only mail
 * SES received for the secret capture address via Microsoft 365, only SES's
 * own headers believed (a sender cannot forge DMARC or the spam verdict), a
 * fresh sender becoming a thread, outbound needing SES's dmarc=pass, internal
 * mail skipped, a wrong org id never stalling the queue, the contact budget,
 * one filing per message, and History. MIME goes through the REAL mailparser; the capture
 * service is mocked (its own suite covers it).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("@/lib/logger", () => ({
  apiLogger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

const s3Send = vi.hoisted(() => vi.fn());
vi.mock("@aws-sdk/client-s3", () => ({
  S3Client: vi.fn(function () {
    return { send: s3Send };
  }),
  ListObjectsV2Command: vi.fn(function (input: unknown) {
    return { cmd: "List", input };
  }),
  GetObjectCommand: vi.fn(function (input: unknown) {
    return { cmd: "Get", input };
  }),
  CopyObjectCommand: vi.fn(function (input: unknown) {
    return { cmd: "Copy", input };
  }),
  DeleteObjectCommand: vi.fn(function (input: unknown) {
    return { cmd: "Delete", input };
  }),
}));

vi.mock("@/lib/db", () => {
  const crmEmailMessage = { findFirst: vi.fn(), create: vi.fn() };
  const crmEmailThread = { findUnique: vi.fn(), findFirst: vi.fn(), create: vi.fn(), update: vi.fn() };
  const client = {
    crmEmailMessage,
    crmEmailThread,
    user: { findUnique: vi.fn() },
    organization: { findUnique: vi.fn() },
  };
  return {
    db: client,
    dbOperator: client,
    tenantTransaction: (fn: (tx: unknown) => unknown) => fn({ crmEmailMessage, crmEmailThread }),
  };
});

vi.mock("@/lib/email", () => ({ sendEmail: vi.fn() }));
vi.mock("@/crm/lib/crm-activity", () => ({ recordCrmActivity: vi.fn(() => Promise.resolve({})) }));
vi.mock("@/crm/lib/crm-notifications", () => ({ notifyCrmUser: vi.fn(() => Promise.resolve({})) }));
vi.mock("@/crm/services/inbox-capture-service", () => ({
  alreadyCaptured: vi.fn(),
  findCaptureThread: vi.fn(),
  recordCaptureActivity: vi.fn(),
  resolveCaptureContact: vi.fn(),
  soleDealForContact: vi.fn(),
}));

import { db } from "@/lib/db";
import { sendEmail } from "@/lib/email";
import { notifyCrmUser } from "@/crm/lib/crm-notifications";
import {
  alreadyCaptured,
  findCaptureThread,
  recordCaptureActivity,
  resolveCaptureContact,
  soleDealForContact,
} from "@/crm/services/inbox-capture-service";
import { runTick } from "@/crm/inbound-email-worker";

const MAILBOX = "partnerships@meetingmindsdubai.com";
const CAPTURE = "capture-s3cr3t@reply.meetingmindsexperts.com";

/** SES's own first Received line, as on a real stored email. */
const sesReceived = (rcpt: string, from = "AU1P273CU002.outbound.protection.outlook.com") =>
  `Received: from ${from} (mail.outbound.protection.outlook.com [52.101.159.127]) by inbound-smtp.ap-south-1.amazonaws.com with SMTP id q1 for ${rcpt}; Tue, 27 Oct 2026 10:55:23 +0000 (UTC)`;

function rawEmail(
  over: { from?: string; to?: string; dmarc?: string; extra?: string[]; received?: string; spam?: string[] } = {},
): string {
  return [
    over.received ?? sesReceived(CAPTURE),
    ...(over.spam ?? ["X-SES-Spam-Verdict: PASS"]),
    "X-SES-Virus-Verdict: PASS",
    `Authentication-Results: amazonses.com; spf=pass; dmarc=${over.dmarc ?? "pass"} header.from=x`,
    `From: ${over.from ?? "Jane Doe <jane@abbott.com>"}`,
    `To: ${over.to ?? MAILBOX}`,
    "Subject: Sponsorship enquiry",
    "Message-ID: <fresh-1@abbott.com>",
    ...(over.extra ?? []),
    "Content-Type: text/plain; charset=utf-8",
    "",
    "We would like to sponsor.",
  ].join("\r\n");
}

function mockS3(objects: Record<string, string>) {
  s3Send.mockImplementation(async (command: { cmd: string; input: Record<string, unknown> }) => {
    if (command.cmd === "List") return { Contents: Object.keys(objects).map((Key) => ({ Key })) };
    if (command.cmd === "Get") {
      return { Body: { transformToByteArray: async () => Buffer.from(objects[command.input.Key as string]!) } };
    }
    return {};
  });
}

const movedTo = () =>
  s3Send.mock.calls
    .map((c) => c[0] as { cmd: string; input: { Key?: string } })
    .filter((c) => c.cmd === "Copy")
    .map((c) => c.input.Key);

beforeEach(() => {
  vi.clearAllMocks();
  process.env.CRM_INBOUND_S3_BUCKET = "bucket";
  process.env.CRM_REPLY_DOMAIN = "reply.meetingmindsexperts.com";
  process.env.CRM_EMAIL_FROM_ADDRESS = MAILBOX;
  process.env.CRM_CAPTURE_ORG_ID = "org-1";
  process.env.CRM_CAPTURE_ADDRESS = CAPTURE;
  vi.mocked(db.organization.findUnique).mockResolvedValue({ id: "org-1" } as never);
  vi.mocked(db.crmEmailMessage.findFirst).mockResolvedValue(null as never);
  vi.mocked(db.crmEmailThread.findUnique).mockResolvedValue(null as never);
  vi.mocked(db.crmEmailThread.create).mockResolvedValue({ id: "t-new" } as never);
  vi.mocked(db.crmEmailThread.update).mockResolvedValue({} as never);
  vi.mocked(db.crmEmailThread.findFirst).mockResolvedValue({
    id: "t-new",
    subject: "Sponsorship enquiry",
    dealId: "d-1",
    deal: { name: "Abbott deal", ownerId: "u-owner" },
  } as never);
  vi.mocked(alreadyCaptured).mockResolvedValue(false);
  vi.mocked(findCaptureThread).mockResolvedValue(null);
  vi.mocked(resolveCaptureContact).mockResolvedValue({ id: "c-new", companyId: "co-1", created: true });
  vi.mocked(soleDealForContact).mockResolvedValue("d-1");
});

afterEach(() => {
  for (const k of ["CRM_INBOUND_S3_BUCKET", "CRM_REPLY_DOMAIN", "CRM_EMAIL_FROM_ADDRESS", "CRM_CAPTURE_ORG_ID", "CRM_CAPTURE_ADDRESS"]) {
    delete process.env[k];
  }
});

describe("partnerships capture", () => {
  it("files a fresh sender's email: contact resolved, new thread on their deal, unread, History, the owner's bell", async () => {
    mockS3({ "inbound/a": rawEmail() });
    expect(await runTick()).toMatchObject({ stored: 1, unmatched: 0 });

    expect(resolveCaptureContact).toHaveBeenCalledWith({
      organizationId: "org-1",
      email: "jane@abbott.com",
      displayName: "Jane Doe",
      automated: false,
    });
    expect(db.crmEmailThread.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          organizationId: "org-1",
          dealId: "d-1",
          crmContactId: "c-new",
          counterpartyEmail: "jane@abbott.com",
          subject: "Sponsorship enquiry",
        }),
      }),
    );
    expect(db.crmEmailMessage.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ direction: "INBOUND", threadId: "t-new", messageId: "<fresh-1@abbott.com>" }),
      }),
    );
    expect(db.crmEmailThread.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ hasUnread: true, archivedAt: null }) }),
    );
    expect(recordCaptureActivity).toHaveBeenCalledWith(
      expect.objectContaining({ direction: "INBOUND", dealId: "d-1", contact: expect.objectContaining({ id: "c-new" }) }),
    );
    expect(notifyCrmUser).toHaveBeenCalledWith(expect.objectContaining({ recipientId: "u-owner", type: "EMAIL_RECEIVED" }));
    // The mailbox already has it: no email copy is sent.
    expect(sendEmail).not.toHaveBeenCalled();
    expect(movedTo()).toEqual(["processed/a"]);
  });

  it("joins the existing conversation it replies to", async () => {
    vi.mocked(findCaptureThread).mockResolvedValue("t-old");
    mockS3({ "inbound/b": rawEmail({ extra: ["In-Reply-To: <ours@amazonses.com>"] }) });
    await runTick();
    expect(findCaptureThread).toHaveBeenCalledWith(expect.objectContaining({ references: ["<ours@amazonses.com>"] }));
    expect(db.crmEmailThread.create).not.toHaveBeenCalled();
    expect(db.crmEmailMessage.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ threadId: "t-old" }) }));
  });

  it("machine mail is filed but flagged as automated, so no contact is created for it", async () => {
    mockS3({ "inbound/c": rawEmail({ extra: ["Auto-Submitted: auto-replied"] }) });
    await runTick();
    expect(resolveCaptureContact).toHaveBeenCalledWith(expect.objectContaining({ automated: true }));
  });

  it("captures a rep's Outlook email to a sponsor only with SES's dmarc=pass", async () => {
    mockS3({ "inbound/d": rawEmail({ from: `Partnerships <${MAILBOX}>`, to: "jane@abbott.com", dmarc: "pass" }) });
    expect(await runTick()).toMatchObject({ stored: 1 });
    expect(db.crmEmailMessage.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ direction: "OUTBOUND" }) }));

    vi.mocked(db.crmEmailMessage.create).mockClear();
    mockS3({ "inbound/e": rawEmail({ from: `Partnerships <${MAILBOX}>`, to: "jane@abbott.com", dmarc: "fail" }) });
    expect(await runTick()).toMatchObject({ stored: 0, unmatched: 1 });
    expect(db.crmEmailMessage.create).not.toHaveBeenCalled();
  });

  it("a forged second Authentication-Results cannot pass SES's dmarc=fail (review BLOCKER)", async () => {
    mockS3({
      "inbound/forged": rawEmail({
        from: `Partnerships <${MAILBOX}>`,
        to: "ceo@sponsor.com",
        dmarc: "fail",
        extra: ["Authentication-Results: evil.example; dmarc=pass"],
      }),
    });
    expect(await runTick()).toMatchObject({ stored: 0, unmatched: 1 });
    expect(db.crmEmailMessage.create).not.toHaveBeenCalled();
  });

  it("a forged second spam verdict cannot hide SES's FAIL", async () => {
    mockS3({ "inbound/spam": rawEmail({ spam: ["X-SES-Spam-Verdict: FAIL", "X-SES-Spam-Verdict: PASS"] }) });
    expect(await runTick()).toMatchObject({ quarantined: 1 });
    expect(resolveCaptureContact).not.toHaveBeenCalled();
  });

  it("quarantines what Microsoft 365 called junk, though SES passed the relayed copy (Oct 28 scam)", async () => {
    mockS3({
      "inbound/scam": rawEmail({
        from: '"COMPENSATION FUND" <hr@bda.com.sa>',
        extra: ["X-Forefront-Antispam-Report: CIP:172.81.118.15;CTRY:US;LANG:en;SCL:5;SRV:;IPV:NLI;SFV:SPM;CAT:OSPM;DIR:OUT;SFP:1501"],
      }),
    });
    expect(await runTick()).toMatchObject({ quarantined: 1, stored: 0 });
    expect(movedTo()).toEqual(["quarantine/scam"]);
    expect(resolveCaptureContact).not.toHaveBeenCalled();
    expect(db.crmEmailMessage.create).not.toHaveBeenCalled();
  });

  it("quarantines junk even when a reply-token address rides in its Cc", async () => {
    mockS3({
      "inbound/scam-token": rawEmail({
        to: `${MAILBOX}, abcdef0123456789abcd@reply.meetingmindsexperts.com`,
        extra: ["X-Forefront-Antispam-Report: SCL:9;SFV:SPM;", " CAT:HSPM"],
      }),
    });
    expect(await runTick()).toMatchObject({ quarantined: 1, stored: 0 });
    expect(db.crmEmailMessage.create).not.toHaveBeenCalled();
  });

  it("files mail Microsoft called clean", async () => {
    mockS3({ "inbound/clean": rawEmail({ extra: ["X-Forefront-Antispam-Report: CIP:1.2.3.4;SCL:1;SFV:NSPM;CAT:NONE;DIR:INB"] }) });
    expect(await runTick()).toMatchObject({ stored: 1 });
  });

  it("an inbound message is verified only with SES's dmarc=pass", async () => {
    mockS3({ "inbound/none": rawEmail({ dmarc: "none" }) });
    await runTick();
    expect(db.crmEmailMessage.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ unverifiedSender: true }) }),
    );
  });

  it("refuses mail that did not come through the mailbox rule (wrong address, or not via Microsoft 365)", async () => {
    mockS3({
      "inbound/direct": rawEmail({ received: sesReceived("anything@reply.meetingmindsexperts.com") }),
      "inbound/notms": rawEmail({ received: sesReceived(CAPTURE, "mx.attacker.example") }),
    });
    expect(await runTick()).toMatchObject({ stored: 0, unmatched: 2 });
    expect(resolveCaptureContact).not.toHaveBeenCalled();
  });

  it("a wrong CRM_CAPTURE_ORG_ID leaves mail unmatched, checked once per tick, never stalling the queue", async () => {
    vi.mocked(db.organization.findUnique).mockResolvedValue(null as never);
    mockS3({ "inbound/x1": rawEmail(), "inbound/x2": rawEmail() });
    expect(await runTick()).toMatchObject({ unmatched: 2, failures: 0 });
    expect(db.organization.findUnique).toHaveBeenCalledTimes(1);
  });

  it("defers once the per-tick contact budget is spent", async () => {
    const objects = Object.fromEntries(Array.from({ length: 22 }, (_, i) => [`inbound/n${i}`, rawEmail()]));
    mockS3(objects);
    const res = await runTick();
    expect(res.stored).toBe(20);
    expect(res.deferred).toBe(2);
  });

  it("captures a sponsor who only Bcc'd partnerships (the mailbox is not in To/Cc)", async () => {
    mockS3({ "inbound/bcc": rawEmail({ to: "someone-else@abbott.com" }) });
    expect(await runTick()).toMatchObject({ stored: 1 });
  });

  it("skips internal mail and the CRM's own forward copies", async () => {
    mockS3({
      "inbound/f": rawEmail({ from: "Saleh <saleh@meetingmindsdubai.com>" }),
      "inbound/g": rawEmail({ from: `Partnerships <${MAILBOX}>`, to: MAILBOX, dmarc: "pass" }),
    });
    expect(await runTick()).toMatchObject({ stored: 0, unmatched: 2 });
    expect(resolveCaptureContact).not.toHaveBeenCalled();
  });

  it("files one email once (the capture copy and the reply-token copy)", async () => {
    vi.mocked(alreadyCaptured).mockResolvedValue(true);
    mockS3({ "inbound/h": rawEmail() });
    expect(await runTick()).toMatchObject({ duplicates: 1 });
    expect(db.crmEmailMessage.create).not.toHaveBeenCalled();
  });

  it("sets an email aside after it fails three ticks running", async () => {
    vi.mocked(resolveCaptureContact).mockRejectedValue(new Error("db down"));
    mockS3({ "inbound/poison": rawEmail() });
    await runTick();
    await runTick();
    expect(movedTo()).not.toContain("failed/poison");
    await runTick();
    expect(movedTo()).toContain("failed/poison");
  });

  it("is dormant without CRM_CAPTURE_ORG_ID: no-token mail stays unmatched", async () => {
    delete process.env.CRM_CAPTURE_ORG_ID;
    mockS3({ "inbound/i": rawEmail() });
    expect(await runTick()).toMatchObject({ unmatched: 1 });
    expect(resolveCaptureContact).not.toHaveBeenCalled();
    expect(movedTo()).toEqual(["unmatched/i"]);
  });
});
