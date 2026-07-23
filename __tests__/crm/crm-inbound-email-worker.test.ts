/**
 * CRM inbound email worker (Batch 2).
 *
 * Pins: env dormancy (no bucket → no S3 traffic), token extraction (domain
 * must match when set), the SES spam/virus quarantine gate, the s3Key dedupe
 * (crash-between-row-and-move retry safety), per-object failure isolation, and
 * the stored happy path (INBOUND row + unread flag + owner notify/forward +
 * move out of inbound/). MIME goes through the REAL mailparser.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("@/lib/logger", () => ({
  apiLogger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

const s3Send = vi.hoisted(() => vi.fn());
vi.mock("@aws-sdk/client-s3", () => ({
  // `new`-able mocks: a function returning an object satisfies `new X()`.
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

vi.mock("@/lib/db", () => ({
  db: {
    crmEmailMessage: { findFirst: vi.fn(), create: vi.fn() },
    crmEmailThread: { findUnique: vi.fn(), update: vi.fn() },
    user: { findUnique: vi.fn() },
    // The store is a $transaction([create, update]) — execute the passed ops.
    $transaction: vi.fn((ops: Promise<unknown>[]) => Promise.all(ops)),
  },
}));

vi.mock("@/lib/email", () => ({ sendEmail: vi.fn() }));
vi.mock("@/crm/lib/crm-activity", () => ({ recordCrmActivity: vi.fn(() => Promise.resolve({})) }));
vi.mock("@/crm/lib/crm-notifications", () => ({ notifyCrmUser: vi.fn(() => Promise.resolve({})) }));

import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { sendEmail } from "@/lib/email";
import { notifyCrmUser } from "@/crm/lib/crm-notifications";
import { runTick, extractReplyToken, verifySender } from "@/crm/inbound-email-worker";

const TOKEN = "abcdef0123456789abcd";
const BUCKET = "test-inbound";

function rawEmail(over: { to?: string; spam?: string; from?: string; dmarc?: string } = {}): string {
  return [
    `From: ${over.from ?? "Jane Doe <jane@abbott.com>"}`,
    `To: ${over.to ?? `${TOKEN}@reply.mmg.com`}`,
    "Subject: Re: Sponsorship",
    "Message-ID: <msg-1@abbott.com>",
    `X-SES-Spam-Verdict: ${over.spam ?? "PASS"}`,
    "X-SES-Virus-Verdict: PASS",
    ...(over.dmarc ? [`Authentication-Results: mx.ses; dmarc=${over.dmarc} header.from=abbott.com`] : []),
    "Content-Type: text/plain; charset=utf-8",
    "",
    "Sounds good, send the contract.",
  ].join("\r\n");
}

const thread = {
  id: "t-1",
  organizationId: "org-1",
  subject: "Sponsorship",
  crmContactId: "c-1",
  // verifySender compares the From domain against this — jane@abbott.com matches.
  counterpartyEmail: "jane@abbott.com",
  expiresAt: null,
  revokedAt: null,
  deal: { id: "d-1", name: "Abbott deal", ownerId: "u-owner" },
};

function mockS3(objects: Record<string, string>) {
  s3Send.mockImplementation(async (command: { cmd: string; input: Record<string, unknown> }) => {
    if (command.cmd === "List") {
      return { Contents: Object.keys(objects).map((Key) => ({ Key })) };
    }
    if (command.cmd === "Get") {
      const body = objects[command.input.Key as string];
      if (body === undefined) throw new Error("NoSuchKey");
      return { Body: { transformToByteArray: async () => Buffer.from(body) } };
    }
    return {};
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.CRM_INBOUND_S3_BUCKET = BUCKET;
  process.env.CRM_REPLY_DOMAIN = "reply.mmg.com";
  vi.mocked(db.crmEmailMessage.findFirst).mockResolvedValue(null as never);
  vi.mocked(db.crmEmailMessage.create).mockResolvedValue({ id: "m-1" } as never);
  vi.mocked(db.crmEmailThread.findUnique).mockResolvedValue(thread as never);
  vi.mocked(db.crmEmailThread.update).mockResolvedValue({} as never);
  vi.mocked(db.user.findUnique).mockResolvedValue({
    email: "owner@mmg.com",
    firstName: "Olive",
    lastName: "Owner",
  } as never);
  vi.mocked(sendEmail).mockResolvedValue({ success: true } as never);
});

afterEach(() => {
  delete process.env.CRM_INBOUND_S3_BUCKET;
  delete process.env.CRM_REPLY_DOMAIN;
});

describe("extractReplyToken", () => {
  it("matches only token-shaped local parts on the reply domain (case-insensitive)", () => {
    expect(extractReplyToken([`${TOKEN.toUpperCase()}@REPLY.MMG.COM`], "reply.mmg.com")).toBe(TOKEN);
    expect(extractReplyToken(["partnerships@meetingmindsdubai.com"], "reply.mmg.com")).toBeNull();
    // Token shape on the WRONG domain is rejected when the domain is configured.
    expect(extractReplyToken([`${TOKEN}@evil.com`], "reply.mmg.com")).toBeNull();
    // First matching recipient wins across to+cc.
    expect(extractReplyToken(["someone@else.com", `${TOKEN}@reply.mmg.com`], "reply.mmg.com")).toBe(TOKEN);
  });
});

describe("runTick", () => {
  it("is DORMANT without the bucket env — zero S3 traffic", async () => {
    delete process.env.CRM_INBOUND_S3_BUCKET;
    const res = await runTick();
    expect(res.scanned).toBe(0);
    expect(s3Send).not.toHaveBeenCalled();
  });

  it("stores a reply: INBOUND row on the token's thread, unread flag, owner notify + forward, move to processed/", async () => {
    mockS3({ "inbound/msg1": rawEmail() });

    const res = await runTick();
    expect(res).toMatchObject({ scanned: 1, stored: 1, failures: 0 });

    const row = vi.mocked(db.crmEmailMessage.create).mock.calls[0]![0]!.data as Record<string, unknown>;
    expect(row.direction).toBe("INBOUND");
    expect(row.threadId).toBe("t-1");
    expect(row.organizationId).toBe("org-1");
    expect(row.fromEmail).toBe("jane@abbott.com");
    expect(row.textBody).toContain("Sounds good");
    expect(row.s3Key).toBe("processed/msg1");

    expect(db.crmEmailThread.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ hasUnread: true }) }),
    );
    expect(notifyCrmUser).toHaveBeenCalledWith(
      expect.objectContaining({ type: "EMAIL_RECEIVED", recipientId: "u-owner" }),
    );
    // Forward-copy to the owner's real mailbox (owner decision).
    expect(sendEmail).toHaveBeenCalledWith(
      expect.objectContaining({ to: [{ email: "owner@mmg.com", name: "Olive Owner" }] }),
    );
    // Moved out of inbound/ (Copy + Delete).
    const cmds = s3Send.mock.calls.map((c) => (c[0] as { cmd: string }).cmd);
    expect(cmds).toContain("Copy");
    expect(cmds).toContain("Delete");
  });

  it("a FAILING SES spam verdict is quarantined — no row, no notification", async () => {
    mockS3({ "inbound/spam1": rawEmail({ spam: "FAIL" }) });

    const res = await runTick();
    expect(res.quarantined).toBe(1);
    expect(db.crmEmailMessage.create).not.toHaveBeenCalled();
    expect(sendEmail).not.toHaveBeenCalled();
    const copy = s3Send.mock.calls.find((c) => (c[0] as { cmd: string }).cmd === "Copy")![0] as {
      input: { Key: string };
    };
    expect(copy.input.Key).toBe("quarantine/spam1");
  });

  it("an unknown token goes to unmatched/ — never guessed onto a thread", async () => {
    vi.mocked(db.crmEmailThread.findUnique).mockResolvedValue(null as never);
    mockS3({ "inbound/msg2": rawEmail() });

    const res = await runTick();
    expect(res.unmatched).toBe(1);
    expect(db.crmEmailMessage.create).not.toHaveBeenCalled();
  });

  it("dedupe: an object whose row already exists just finishes the move (retry safety)", async () => {
    vi.mocked(db.crmEmailMessage.findFirst).mockResolvedValue({ id: "m-existing" } as never);
    mockS3({ "inbound/msg3": rawEmail() });

    const res = await runTick();
    expect(res.duplicates).toBe(1);
    expect(db.crmEmailMessage.create).not.toHaveBeenCalled();
    const cmds = s3Send.mock.calls.map((c) => (c[0] as { cmd: string }).cmd);
    expect(cmds).toContain("Copy");
  });

  it("one bad object never blocks the queue — failure counted, the rest process", async () => {
    mockS3({ "inbound/bad": undefined as never, "inbound/good": rawEmail() });

    const res = await runTick();
    expect(res.failures).toBe(1);
    expect(res.stored).toBe(1);
  });

  it("a forward failure logs but the received email STAYS recorded", async () => {
    vi.mocked(sendEmail).mockResolvedValue({ success: false, error: "ses down" } as never);
    mockS3({ "inbound/msg4": rawEmail() });

    const res = await runTick();
    expect(res.stored).toBe(1);
    expect(db.crmEmailMessage.create).toHaveBeenCalledOnce();
  });

  // ── H1: sender verification / anti-BEC ─────────────────────────────────────
  it("a verified sender (From domain matches counterparty) is stored verified + forwarded", async () => {
    mockS3({ "inbound/v": rawEmail() });
    await runTick();
    const row = vi.mocked(db.crmEmailMessage.create).mock.calls[0]![0]!.data as Record<string, unknown>;
    expect(row.unverifiedSender).toBe(false);
    expect(sendEmail).toHaveBeenCalled(); // the forward went out
  });

  it("a SPOOFED sender (foreign domain) is stored UNVERIFIED and the forward is SUPPRESSED", async () => {
    mockS3({ "inbound/bec": rawEmail({ from: `"Jane at Abbott" <attacker@evil.com>` }) });
    const res = await runTick();
    expect(res.stored).toBe(1); // stored (visible with a warning badge), not dropped

    const row = vi.mocked(db.crmEmailMessage.create).mock.calls[0]![0]!.data as Record<string, unknown>;
    expect(row.unverifiedSender).toBe(true);
    // In-app bell still fires (staff-only, safe) but with the ⚠ wording…
    expect(notifyCrmUser).toHaveBeenCalledWith(
      expect.objectContaining({ type: "EMAIL_RECEIVED", title: expect.stringContaining("Unverified") }),
    );
    // …and NO email forward to a real mailbox under our branding.
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it("an explicit DMARC=fail is unverified even from the right domain", async () => {
    mockS3({ "inbound/dmarc": rawEmail({ dmarc: "fail" }) });
    await runTick();
    const row = vi.mocked(db.crmEmailMessage.create).mock.calls[0]![0]!.data as Record<string, unknown>;
    expect(row.unverifiedSender).toBe(true);
    expect(sendEmail).not.toHaveBeenCalled();
  });

  // ── M1: token lifecycle ────────────────────────────────────────────────────
  it("a REVOKED token (deal archived) goes unmatched — never filed", async () => {
    vi.mocked(db.crmEmailThread.findUnique).mockResolvedValue({ ...thread, revokedAt: new Date() } as never);
    mockS3({ "inbound/rev": rawEmail() });
    const res = await runTick();
    expect(res.unmatched).toBe(1);
    expect(db.crmEmailMessage.create).not.toHaveBeenCalled();
  });

  it("an EXPIRED token goes unmatched", async () => {
    vi.mocked(db.crmEmailThread.findUnique).mockResolvedValue({
      ...thread,
      expiresAt: new Date(Date.now() - 1000),
    } as never);
    mockS3({ "inbound/exp": rawEmail() });
    const res = await runTick();
    expect(res.unmatched).toBe(1);
    expect(db.crmEmailMessage.create).not.toHaveBeenCalled();
  });

  // ── H2: s3Key race dedupe ──────────────────────────────────────────────────
  it("a P2002 on the store (concurrent tick won the s3Key race) is a duplicate, not a double-forward", async () => {
    vi.mocked(db.$transaction).mockRejectedValueOnce(
      new Prisma.PrismaClientKnownRequestError("unique", { code: "P2002", clientVersion: "x" }) as never,
    );
    mockS3({ "inbound/race": rawEmail() });
    const res = await runTick();
    expect(res.duplicates).toBe(1);
    expect(sendEmail).not.toHaveBeenCalled(); // the loser never forwards
    const cmds = s3Send.mock.calls.map((c) => (c[0] as { cmd: string }).cmd);
    expect(cmds).toContain("Copy"); // still moved out of inbound/
  });
});

describe("verifySender", () => {
  const parsed = (from: string, auth?: string) =>
    ({
      from: { value: [{ address: from }] },
      headers: new Map(auth ? [["authentication-results", auth]] : []),
    }) as never;

  it("same domain as the counterparty → verified", () => {
    expect(verifySender(parsed("bob@abbott.com"), "jane@abbott.com").verified).toBe(true);
  });
  it("foreign domain → unverified (domain-mismatch)", () => {
    expect(verifySender(parsed("x@evil.com"), "jane@abbott.com")).toMatchObject({
      verified: false,
      reason: "domain-mismatch",
    });
  });
  it("explicit dmarc=fail → unverified even on the right domain", () => {
    expect(verifySender(parsed("jane@abbott.com", "mx; dmarc=fail"), "jane@abbott.com")).toMatchObject({
      verified: false,
      reason: "dmarc-fail",
    });
  });
  it("missing From address → unverified", () => {
    expect(verifySender(parsed(""), "jane@abbott.com").verified).toBe(false);
  });
});
