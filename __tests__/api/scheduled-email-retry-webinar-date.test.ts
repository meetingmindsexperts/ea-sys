/**
 * Retry refuses a webinar reminder made for a date the webinar has since left (review MED, Oct 28, 2026):
 * it would email people about the old date beside the new date's own reminder.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockAuth, mockDb } = vi.hoisted(() => ({
  mockAuth: vi.fn(),
  mockDb: {
    scheduledEmail: { findFirst: vi.fn(), updateMany: vi.fn(), findUnique: vi.fn() },
    eventSession: { findFirst: vi.fn() },
    auditLog: { create: vi.fn() },
  },
}));

vi.mock("next/server", () => ({
  NextResponse: { json: (body: unknown, init?: { status?: number }) => ({ status: init?.status ?? 200, json: async () => body }) },
}));
vi.mock("@/lib/logger", () => ({ apiLogger: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock("@/lib/auth", () => ({ auth: () => mockAuth() }));
vi.mock("@/lib/db", () => ({ db: mockDb, tenantTransaction: (fn: (tx: unknown) => unknown) => fn(mockDb) }));
vi.mock("@/lib/tenant-context", () => ({ runWithTenant: (_org: string, fn: () => unknown) => fn() }));

import { POST } from "@/app/api/events/[eventId]/emails/schedule/[id]/retry/route";

const START = new Date("2026-10-30T10:00:00Z");
const ANCHOR = { startTime: START, endTime: new Date("2026-10-30T11:30:00Z") };
const SETTINGS = { webinar: { sessionId: "anchor1" } };
const call = () => POST(new Request("http://x", { method: "POST" }), { params: Promise.resolve({ eventId: "e1", id: "se1" }) });

beforeEach(() => {
  vi.clearAllMocks();
  mockAuth.mockResolvedValue({ user: { id: "u1", role: "ADMIN", organizationId: "org1" } });
  mockDb.eventSession.findFirst.mockResolvedValue(ANCHOR);
  mockDb.scheduledEmail.updateMany.mockResolvedValue({ count: 1 });
  mockDb.scheduledEmail.findUnique.mockResolvedValue({ id: "se1", retryCount: 1 });
  mockDb.auditLog.create.mockResolvedValue({});
});

describe("Retry on a webinar reminder after the webinar moved", () => {
  it("refuses a row made for a date more than 12 hours away (409, nothing written)", async () => {
    mockDb.scheduledEmail.findFirst.mockResolvedValue({
      emailType: "webinar-live-now", scheduledFor: new Date("2026-10-28T10:00:00Z"),
      filters: { status: "CONFIRMED", webinarStartsAt: "2026-10-28T10:00:00.000Z" }, event: { settings: SETTINGS },
    });
    const res = await call();
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe("WEBINAR_DATE_CHANGED");
    expect(mockDb.scheduledEmail.updateMany).not.toHaveBeenCalled();
  });

  it("retries a row for the current date", async () => {
    mockDb.scheduledEmail.findFirst.mockResolvedValue({
      emailType: "webinar-live-now", scheduledFor: new Date("2026-10-30T10:00:00Z"),
      filters: { status: "CONFIRMED", webinarStartsAt: START.toISOString() }, event: { settings: SETTINGS },
    });
    expect((await call()).status).toBe(200);
    expect(mockDb.scheduledEmail.updateMany).toHaveBeenCalledTimes(1);
  });

  it("leaves every other email type alone", async () => {
    mockDb.scheduledEmail.findFirst.mockResolvedValue({
      emailType: "custom", scheduledFor: new Date("2026-01-01T00:00:00Z"), filters: null, event: { settings: SETTINGS },
    });
    expect((await call()).status).toBe(200);
    expect(mockDb.eventSession.findFirst).not.toHaveBeenCalled();
  });
});
