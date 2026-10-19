/**
 * Import from Registrations (speakers): each new speaker's badge and check-in
 * use their registration's barcode, so a registration without one gets one
 * (Oct 19, 2026: Uzma Sharif on BHS2026).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockDb, ensureMock } = vi.hoisted(() => ({
  mockDb: {
    event: { findFirst: vi.fn() },
    registration: { findMany: vi.fn() },
    speaker: { findMany: vi.fn(), createMany: vi.fn() },
    auditLog: { create: vi.fn() },
  },
  ensureMock: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({ auth: async () => ({ user: { id: "u1", role: "ADMIN", organizationId: "org-1" } }) }));
vi.mock("@/lib/db", () => ({ db: mockDb }));
vi.mock("@/lib/logger", () => ({ apiLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock("@/lib/tenant-context", () => ({ runWithTenant: (_: string, fn: () => unknown) => fn() }));
vi.mock("@/lib/require-org", () => ({ requireOrgId: () => ({ orgId: "org-1" }) }));
vi.mock("@/lib/permissions/require-permission", () => ({ requirePermission: () => ({ ok: true, eventWhere: { id: "ev-1" } }) }));
vi.mock("@/lib/audit-data-transfer", () => ({ recordImport: vi.fn() }));
vi.mock("@/lib/event-stats", () => ({ refreshEventStats: vi.fn() }));
vi.mock("@/lib/security", () => ({ getClientIp: () => "1.2.3.4" }));
vi.mock("@/lib/entry-barcode-mint", () => ({ ensureEntryBarcode: ensureMock }));

import { POST } from "@/app/api/events/[eventId]/speakers/import-registrations/route";

const reg = (id: string, email: string, qrCode: string | null) => ({
  id, qrCode, attendanceMode: "IN_PERSON",
  attendee: { email, firstName: "A", lastName: "B", tags: [] },
});

beforeEach(() => {
  vi.clearAllMocks();
  mockDb.event.findFirst.mockResolvedValue({ id: "ev-1" });
  mockDb.speaker.findMany.mockResolvedValue([{ email: "already@x.test" }]);
  mockDb.speaker.createMany.mockResolvedValue({ count: 2 });
  mockDb.auditLog.create.mockResolvedValue({});
  ensureMock.mockResolvedValue(null);
});

describe("speakers import-registrations", () => {
  it("gives each new speaker's registration a barcode if it has none; existing speakers are untouched", async () => {
    mockDb.registration.findMany.mockResolvedValue([
      reg("r1", "uzma@x.test", null),
      reg("r2", "dina@x.test", "QR2"),
      reg("r3", "already@x.test", null),
    ]);
    const res = await POST(
      new Request("http://localhost/api/x", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ registrationIds: ["r1", "r2", "r3"] }) }),
      { params: Promise.resolve({ eventId: "ev-1" }) },
    );
    expect(res.status).toBe(200);
    expect(ensureMock.mock.calls.map((c) => c[0].id)).toEqual(["r1", "r2"]);
  });

  it("a failed barcode mint does not fail the import (review L1)", async () => {
    mockDb.registration.findMany.mockResolvedValue([reg("r1", "uzma@x.test", null), reg("r2", "dina@x.test", null)]);
    ensureMock.mockRejectedValueOnce(new Error("db blip"));
    const res = await POST(
      new Request("http://localhost/api/x", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ registrationIds: ["r1", "r2"] }) }),
      { params: Promise.resolve({ eventId: "ev-1" }) },
    );
    expect(res.status).toBe(200);
    // The next row is still attempted.
    expect(ensureMock.mock.calls.map((c) => c[0].id)).toEqual(["r1", "r2"]);
  });
});
