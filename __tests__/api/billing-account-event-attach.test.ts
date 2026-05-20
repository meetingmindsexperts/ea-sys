/**
 * Tests for the EventBillingAccount junction attach/detach route.
 *
 * Per-event payer scoping is finance data — RBAC must block MEMBER (via
 * denyFinance) on top of denyReviewer for write paths. Both ids come
 * from the URL, so org-scoping is the only thing standing between a
 * user in org A and a foreign event/payer in org B (IDOR class) —
 * verify the route refuses to act when either end isn't in the
 * caller's org. Idempotency is asserted because the picker UI toggles
 * checkboxes rapidly and we don't want 4xx on re-attach/re-detach.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockAuth, mockDb } = vi.hoisted(() => ({
  mockAuth: vi.fn(),
  mockDb: {
    event: { findFirst: vi.fn() },
    billingAccount: { findFirst: vi.fn() },
    eventBillingAccount: {
      upsert: vi.fn(),
      deleteMany: vi.fn(),
    },
    auditLog: { create: vi.fn().mockResolvedValue({}) },
  },
}));

vi.mock("next/server", () => ({
  NextResponse: {
    json: (body: unknown, init?: { status?: number }) => ({
      status: init?.status ?? 200,
      json: async () => body,
    }),
  },
}));

vi.mock("@/lib/auth", () => ({ auth: () => mockAuth() }));
vi.mock("@/lib/db", () => ({ db: mockDb }));
vi.mock("@/lib/logger", () => ({
  apiLogger: { error: vi.fn(), info: vi.fn(), warn: vi.fn() },
}));

// Mirror the real guards exactly (REVIEWER/SUBMITTER/REGISTRANT/MEMBER
// blocked by denyReviewer; MEMBER also fails canViewFinance).
vi.mock("@/lib/auth-guards", () => ({
  denyReviewer: (session: { user?: { role?: string } } | null) => {
    const role = session?.user?.role;
    if (
      role === "REVIEWER" ||
      role === "SUBMITTER" ||
      role === "REGISTRANT" ||
      role === "MEMBER"
    ) {
      return { status: 403, json: async () => ({ error: "Forbidden" }) };
    }
    return null;
  },
  denyFinance: (session: { user?: { role?: string } } | null) => {
    const role = session?.user?.role;
    if (
      role !== "SUPER_ADMIN" &&
      role !== "ADMIN" &&
      role !== "ORGANIZER"
    ) {
      return { status: 403, json: async () => ({ error: "FINANCE_FORBIDDEN" }) };
    }
    return null;
  },
}));

import { POST, DELETE } from "@/app/api/events/[eventId]/billing-accounts/[billingAccountId]/route";

const makeParams = (eventId = "evt-1", billingAccountId = "ba-1") => ({
  params: Promise.resolve({ eventId, billingAccountId }),
});

const ADMIN_SESSION = {
  user: { id: "user-1", role: "ADMIN", organizationId: "org-1" },
};

beforeEach(() => {
  vi.clearAllMocks();
  mockDb.auditLog.create.mockResolvedValue({});
});

describe("POST /api/events/[eventId]/billing-accounts/[billingAccountId]", () => {
  it("401 when no session", async () => {
    mockAuth.mockResolvedValue(null);
    const res = (await POST(new Request("http://x"), makeParams()))!;
    expect(res.status).toBe(401);
  });

  it("403 for MEMBER (denyFinance — junction is finance data)", async () => {
    mockAuth.mockResolvedValue({
      user: { id: "u", role: "MEMBER", organizationId: "org-1" },
    });
    const res = (await POST(new Request("http://x"), makeParams()))!;
    expect(res.status).toBe(403);
    // denyReviewer fires first for MEMBER; either way it's blocked.
    expect(mockDb.eventBillingAccount.upsert).not.toHaveBeenCalled();
  });

  it("404 when the event isn't in the caller's org (IDOR-safe)", async () => {
    mockAuth.mockResolvedValue(ADMIN_SESSION);
    mockDb.event.findFirst.mockResolvedValue(null);
    mockDb.billingAccount.findFirst.mockResolvedValue({ id: "ba-1", isActive: true });
    const res = (await POST(new Request("http://x"), makeParams()))!;
    expect(res.status).toBe(404);
    expect(mockDb.eventBillingAccount.upsert).not.toHaveBeenCalled();
  });

  it("404 when the BillingAccount isn't in the caller's org (IDOR-safe)", async () => {
    mockAuth.mockResolvedValue(ADMIN_SESSION);
    mockDb.event.findFirst.mockResolvedValue({ id: "evt-1" });
    mockDb.billingAccount.findFirst.mockResolvedValue(null);
    const res = (await POST(new Request("http://x"), makeParams()))!;
    expect(res.status).toBe(404);
    expect(mockDb.eventBillingAccount.upsert).not.toHaveBeenCalled();
  });

  it("400 when the BillingAccount is inactive (reactivate first)", async () => {
    mockAuth.mockResolvedValue(ADMIN_SESSION);
    mockDb.event.findFirst.mockResolvedValue({ id: "evt-1" });
    mockDb.billingAccount.findFirst.mockResolvedValue({ id: "ba-1", isActive: false });
    const res = (await POST(new Request("http://x"), makeParams()))!;
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe("BILLING_ACCOUNT_INACTIVE");
    expect(mockDb.eventBillingAccount.upsert).not.toHaveBeenCalled();
  });

  it("idempotent attach: upsert with eventId_billingAccountId compound key", async () => {
    mockAuth.mockResolvedValue(ADMIN_SESSION);
    mockDb.event.findFirst.mockResolvedValue({ id: "evt-1" });
    mockDb.billingAccount.findFirst.mockResolvedValue({ id: "ba-1", isActive: true });
    mockDb.eventBillingAccount.upsert.mockResolvedValue({
      id: "eba-1",
      eventId: "evt-1",
      billingAccountId: "ba-1",
    });

    const res = (await POST(new Request("http://x"), makeParams()))!;
    expect(res.status).toBe(200);
    const upsertArg = mockDb.eventBillingAccount.upsert.mock.calls[0][0];
    expect(upsertArg.where.eventId_billingAccountId).toEqual({
      eventId: "evt-1",
      billingAccountId: "ba-1",
    });
    expect(upsertArg.create.addedByUserId).toBe("user-1");
    // Re-attach = no-op update path (the empty {} is the contract).
    expect(upsertArg.update).toEqual({});
    expect(mockDb.auditLog.create).toHaveBeenCalled();
  });
});

describe("DELETE /api/events/[eventId]/billing-accounts/[billingAccountId]", () => {
  it("403 for MEMBER", async () => {
    mockAuth.mockResolvedValue({
      user: { id: "u", role: "MEMBER", organizationId: "org-1" },
    });
    const res = (await DELETE(new Request("http://x"), makeParams()))!;
    expect(res.status).toBe(403);
    expect(mockDb.eventBillingAccount.deleteMany).not.toHaveBeenCalled();
  });

  it("404 on foreign event (IDOR-safe)", async () => {
    mockAuth.mockResolvedValue(ADMIN_SESSION);
    mockDb.event.findFirst.mockResolvedValue(null);
    mockDb.billingAccount.findFirst.mockResolvedValue({ id: "ba-1", isActive: true });
    const res = (await DELETE(new Request("http://x"), makeParams()))!;
    expect(res.status).toBe(404);
    expect(mockDb.eventBillingAccount.deleteMany).not.toHaveBeenCalled();
  });

  it("idempotent detach: removed:true when the row existed", async () => {
    mockAuth.mockResolvedValue(ADMIN_SESSION);
    mockDb.event.findFirst.mockResolvedValue({ id: "evt-1" });
    mockDb.billingAccount.findFirst.mockResolvedValue({ id: "ba-1", isActive: true });
    mockDb.eventBillingAccount.deleteMany.mockResolvedValue({ count: 1 });

    const res = (await DELETE(new Request("http://x"), makeParams()))!;
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.removed).toBe(true);
  });

  it("idempotent detach: removed:false (no error) when nothing was attached", async () => {
    mockAuth.mockResolvedValue(ADMIN_SESSION);
    mockDb.event.findFirst.mockResolvedValue({ id: "evt-1" });
    mockDb.billingAccount.findFirst.mockResolvedValue({ id: "ba-1", isActive: true });
    mockDb.eventBillingAccount.deleteMany.mockResolvedValue({ count: 0 });

    const res = (await DELETE(new Request("http://x"), makeParams()))!;
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.removed).toBe(false);
  });
});
