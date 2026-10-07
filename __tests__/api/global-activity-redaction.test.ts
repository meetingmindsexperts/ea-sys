/**
 * Phase 6 review (Oct 7, 2026): /api/activity returned raw audit diffs, and
 * only the page hid money. `activity.org.read` is grantable in a custom role,
 * so a CRM user given it read payment amounts and scanned entry codes. The
 * route now removes what the reader may not see.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockDb, mockAuth } = vi.hoisted(() => ({
  mockDb: { auditLog: { findMany: vi.fn() } },
  mockAuth: vi.fn(),
}));

vi.mock("next/server", () => ({
  NextResponse: { json: (b: unknown, i?: { status?: number }) => ({ status: i?.status ?? 200, json: async () => b }) },
}));
vi.mock("@/lib/auth", () => ({ auth: () => mockAuth() }));
vi.mock("@/lib/db", () => ({ db: mockDb }));
vi.mock("@/lib/logger", () => ({ apiLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock("@/lib/tenant-context", () => ({ runWithTenant: (_o: unknown, fn: () => unknown) => fn() }));

import { GET } from "@/app/api/activity/route";

const ROWS = [
  { id: "a1", action: "PAYMENT", entityType: "Registration", entityId: "r1", createdAt: new Date(), user: null, event: null,
    changes: { amount: 250, paymentReference: "pi_1", status: "PAID" } },
  { id: "a2", action: "CHECK_IN", entityType: "Registration", entityId: "r2", createdAt: new Date(), user: null, event: null,
    changes: { qrCode: "QR-9", source: "desk" } },
];
const req = () => new Request("http://localhost/api/activity");

beforeEach(() => {
  vi.clearAllMocks();
  mockDb.auditLog.findMany.mockResolvedValue(ROWS);
});

describe("GET /api/activity redacts the diffs for the reader", () => {
  it("a custom role with activity.org.read and no finance or barcode key gets neither", async () => {
    mockAuth.mockResolvedValue({ user: { id: "c1", role: "CRM_USER", organizationId: "org1", procurementPermissions: ["activity.org.read"] } });
    const res = await GET(req());
    expect(res.status).toBe(200);
    const body = JSON.stringify(await res.json());
    expect(body).not.toContain("250");
    expect(body).not.toContain("pi_1");
    expect(body).not.toContain("QR-9");
    expect(body).toContain("PAID");
    expect(body).toContain("desk");
  });

  it("an ADMIN gets the diffs whole", async () => {
    mockAuth.mockResolvedValue({ user: { id: "a1", role: "ADMIN", organizationId: "org1" } });
    const body = JSON.stringify(await (await GET(req())).json());
    expect(body).toContain("250");
    expect(body).toContain("QR-9");
  });
});
