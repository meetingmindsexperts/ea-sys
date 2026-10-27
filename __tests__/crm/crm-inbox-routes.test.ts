/**
 * CRM inbox routes (read-only).
 *
 * Pins: the staff-only boundary (MEMBER passes the generic CRM read gate but
 * must NEVER read sponsor negotiation threads — 403 on every inbox surface,
 * using the REAL canViewCrmInbox predicate), org-bound lookups, and the
 * shared-inbox unread-clear on open. Since Oct 27, 2026: folders, filters and
 * paging on the list, and archive / mark unread (PATCH) on a thread.
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

// Gates pass-through with a configurable role — canViewCrmInbox stays REAL.
// Full module mock (importOriginal would drag next-auth into vitest via
// getOrgContext); the gates themselves are pinned by the gate-drift test.
const gate = vi.hoisted(() => ({ role: "ADMIN", fromApiKey: false }));
vi.mock("@/crm/lib/crm-route", async () => ({
  // The REAL permission check: routes ask `crmCan` since custom roles Phase 2.
  crmCan: (await vi.importActual<typeof import("@/crm/lib/crm-visibility")>("@/crm/lib/crm-visibility")).crmCan,
  requireCrmRead: vi.fn(async () => ({
    ctx: { organizationId: "org-1", userId: "u-1", role: gate.role, fromApiKey: gate.fromApiKey },
  })),
  requireCrmWrite: vi.fn(async () => ({
    ctx: { organizationId: "org-1", userId: "u-1", role: gate.role, fromApiKey: gate.fromApiKey },
  })),
  crmErrorResponse: vi.fn(() => new Response(null, { status: 500 })),
}));

import { db } from "@/lib/db";
import { GET as listThreads } from "@/app/api/crm/inbox/route";
import { GET as getThread, PATCH as patchThread } from "@/app/api/crm/inbox/[threadId]/route";
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
const attParams = Promise.resolve({ messageId: "m-1", index: "0" });

beforeEach(() => {
  vi.clearAllMocks();
  gate.role = "ADMIN";
  gate.fromApiKey = false;
  vi.mocked(db.crmEmailThread.findMany).mockResolvedValue([] as never);
  vi.mocked(db.crmEmailThread.count).mockResolvedValue(0 as never);
  vi.mocked(db.crmEmailThread.findFirst).mockResolvedValue(threadDetail as never);
  vi.mocked(db.crmEmailThread.updateMany).mockResolvedValue({ count: 1 } as never);
  vi.mocked(db.crmEmailMessage.findFirst).mockResolvedValue({
    attachments: [{ filename: "quote.pdf", mimeType: "application/pdf", path: "/uploads/crm-email-attachments/t-1/abc.pdf" }],
  } as never);
  fsMock.realpath.mockImplementation(async (p: string) => p);
  fsMock.readFile.mockResolvedValue(Buffer.from("%PDF-1.7"));
});

describe("staff-only boundary (real canViewCrmInbox)", () => {
  it("MEMBER is 403 on the list, the thread AND an attachment — never reads rival negotiations", async () => {
    gate.role = "MEMBER";
    expect((await listThreads(new Request("http://test/api/crm/inbox"))).status).toBe(403);
    expect((await getThread(new Request("http://test"), { params: threadParams })).status).toBe(403);
    expect((await getAttachment(new Request("http://test"), { params: attParams })).status).toBe(403);
    expect(db.crmEmailThread.findMany).not.toHaveBeenCalled();
    expect(db.crmEmailMessage.findFirst).not.toHaveBeenCalled();
    expect(fsMock.readFile).not.toHaveBeenCalled();
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

// ── folders, filters, paging (Oct 27, 2026) ───────────────────────────────────

function patch(body: unknown) {
  return patchThread(
    new Request("http://test", { method: "PATCH", body: JSON.stringify(body) }),
    { params: threadParams },
  );
}

describe("thread list: folders and paging", () => {
  it("defaults to the Inbox folder: replied and not archived", async () => {
    await listThreads(new Request("http://test/api/crm/inbox"));
    const where = vi.mocked(db.crmEmailThread.findMany).mock.calls[0]![0]!.where as { AND: unknown[] };
    expect(where.AND).toContainEqual({ lastInboundAt: { not: null }, archivedAt: null });
  });

  it("refuses an unknown folder with a 400, not the whole mailbox", async () => {
    const res = await listThreads(new Request("http://test/api/crm/inbox?folder=everything"));
    expect(res.status).toBe(400);
    expect(db.crmEmailThread.findMany).not.toHaveBeenCalled();
  });

  it("returns a keyset cursor from the last row's own position, and pages after it", async () => {
    const at = new Date("2026-10-27T10:00:00.000Z");
    const rows = Array.from({ length: 51 }, (_, i) => ({ id: `t-${i}`, lastMessageAt: at }));
    vi.mocked(db.crmEmailThread.findMany).mockResolvedValue(rows as never);
    const body = await (await listThreads(new Request("http://test/api/crm/inbox?folder=sent"))).json();
    expect(body.threads).toHaveLength(50);
    expect(body.nextCursor).toBe("2026-10-27T10:00:00.000Z|t-49");
    expect(body.unreadCount).toBe(0);

    vi.mocked(db.crmEmailThread.count).mockClear();
    const page2 = await listThreads(
      new Request(`http://test/api/crm/inbox?folder=sent&cursor=${encodeURIComponent(body.nextCursor)}`),
    );
    const where = vi.mocked(db.crmEmailThread.findMany).mock.calls[1]![0]!.where as { AND: unknown[] };
    expect(where.AND[1]).toEqual({
      OR: [{ lastMessageAt: { lt: at } }, { lastMessageAt: at, id: { lt: "t-49" } }],
    });
    // Later pages skip the org-wide unread count.
    expect(db.crmEmailThread.count).not.toHaveBeenCalled();
    expect((await page2.json()).unreadCount).toBeNull();
  });

  it("400s a cursor that does not parse", async () => {
    const res = await listThreads(new Request("http://test/api/crm/inbox?cursor=garbage"));
    expect(res.status).toBe(400);
    expect(db.crmEmailThread.findMany).not.toHaveBeenCalled();
  });
});

describe("PATCH thread: archive and mark unread", () => {
  it("archives, org-bound", async () => {
    expect((await patch({ archived: true })).status).toBe(200);
    expect(db.crmEmailThread.updateMany).toHaveBeenCalledWith({
      where: { id: "t-1", organizationId: "org-1" },
      data: { archivedAt: expect.any(Date) },
    });
  });

  it("moves back to the Inbox and marks unread", async () => {
    await patch({ archived: false, unread: true });
    expect(db.crmEmailThread.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: { archivedAt: null, hasUnread: true } }),
    );
  });

  it("404s a thread outside the organisation", async () => {
    vi.mocked(db.crmEmailThread.updateMany).mockResolvedValue({ count: 0 } as never);
    expect((await patch({ archived: true })).status).toBe(404);
  });

  it("400s an empty change", async () => {
    expect((await patch({})).status).toBe(400);
    expect(db.crmEmailThread.updateMany).not.toHaveBeenCalled();
  });

  it("MEMBER is refused by the inbox permission (the write gate is pinned by the route matrix)", async () => {
    gate.role = "MEMBER";
    expect((await patch({ archived: true })).status).toBe(403);
    expect(db.crmEmailThread.updateMany).not.toHaveBeenCalled();
  });
});
