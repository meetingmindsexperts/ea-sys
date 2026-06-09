/**
 * Pins the scheduled-emails worker's recipientIds passthrough — the
 * reason ScheduledEmail gained a recipientIds column (2026-06-09). A
 * queued row with explicit recipient ids must forward them to
 * executeBulkEmail (so "send to selected" survives the queue); an empty
 * array must forward `undefined` (so executeBulkEmail falls back to the
 * filter-based recipient resolution, which keys off recipientIds?.length).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockDb, mockExecuteBulkEmail, mockNotify, mockLogger } = vi.hoisted(() => ({
  mockDb: {
    scheduledEmail: { updateMany: vi.fn(), findMany: vi.fn(), update: vi.fn() },
    user: { findMany: vi.fn() },
    auditLog: { create: vi.fn().mockReturnValue({ catch: () => {} }) },
  },
  mockExecuteBulkEmail: vi.fn(),
  mockNotify: vi.fn().mockReturnValue({ catch: () => {} }),
  mockLogger: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

vi.mock("@/lib/db", () => ({ db: mockDb }));
vi.mock("@/lib/logger", () => ({ apiLogger: mockLogger }));
vi.mock("@/lib/notifications", () => ({ notifyEventAdmins: mockNotify }));
vi.mock("@/lib/bulk-email", () => ({ executeBulkEmail: mockExecuteBulkEmail }));

import { runScheduledEmailsTick } from "@/lib/scheduled-emails-worker";

function dueRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "se_1",
    eventId: "ev_1",
    organizationId: "org_1",
    createdById: "user_1",
    recipientType: "registrations",
    emailType: "custom",
    customSubject: "Hi",
    customMessage: "Body",
    attachments: null,
    filters: null,
    recipientIds: [],
    retryCount: 0,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  // sweep updateMany → 0 stuck; subsequent claim updateMany → 1 (we own it)
  mockDb.scheduledEmail.updateMany.mockResolvedValueOnce({ count: 0 }).mockResolvedValue({ count: 1 });
  mockDb.scheduledEmail.update.mockResolvedValue({});
  mockDb.user.findMany.mockResolvedValue([
    { id: "user_1", firstName: "Ana", lastName: "Org", email: "ana@x.com", emailSignature: null },
  ]);
  mockExecuteBulkEmail.mockResolvedValue({ total: 2, successCount: 2, failureCount: 0, errors: [] });
});

describe("scheduled-emails worker — recipientIds passthrough", () => {
  it("forwards explicit recipientIds to executeBulkEmail (send-to-selected survives the queue)", async () => {
    mockDb.scheduledEmail.findMany.mockResolvedValue([
      dueRow({ recipientIds: ["r1", "r2"] }),
    ]);

    const report = await runScheduledEmailsTick();

    expect(report.processed).toBe(1);
    expect(mockExecuteBulkEmail).toHaveBeenCalledTimes(1);
    expect(mockExecuteBulkEmail.mock.calls[0][0]).toMatchObject({
      recipientIds: ["r1", "r2"],
    });
  });

  it("forwards undefined when recipientIds is empty (filter-based send)", async () => {
    mockDb.scheduledEmail.findMany.mockResolvedValue([dueRow({ recipientIds: [] })]);

    await runScheduledEmailsTick();

    expect(mockExecuteBulkEmail).toHaveBeenCalledTimes(1);
    expect(mockExecuteBulkEmail.mock.calls[0][0].recipientIds).toBeUndefined();
  });

  it("marks the row SENT with the executeBulkEmail counts", async () => {
    mockDb.scheduledEmail.findMany.mockResolvedValue([dueRow({ recipientIds: ["r1"] })]);

    await runScheduledEmailsTick();

    expect(mockDb.scheduledEmail.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "se_1" },
        data: expect.objectContaining({ status: "SENT", successCount: 2, totalCount: 2 }),
      }),
    );
  });

  it("includes retryCount in the scheduled-email:sent log line", async () => {
    mockDb.scheduledEmail.findMany.mockResolvedValue([dueRow({ retryCount: 2, recipientIds: ["r1"] })]);

    await runScheduledEmailsTick();

    const sentLog = mockLogger.info.mock.calls.find(
      (c: unknown[]) => (c[0] as { msg?: string })?.msg === "scheduled-email:sent",
    );
    expect(sentLog?.[0]).toMatchObject({ retryCount: 2 });
  });
});
