/**
 * The registrant portal shows an entry barcode only when the row carries a
 * qrCode, so a webinar's code is left out of the list (owner, Oct 6, 2026:
 * webinars have no barcode). Conferences are unchanged.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockDb, mockAuth } = vi.hoisted(() => ({
  mockAuth: vi.fn(),
  mockDb: { registration: { updateMany: vi.fn(), findMany: vi.fn() } },
}));

vi.mock("next/server", () => ({
  NextResponse: { json: (body: unknown, init?: { status?: number }) => ({ status: init?.status ?? 200, json: async () => body }) },
}));
vi.mock("@/lib/auth", () => ({ auth: mockAuth }));
vi.mock("@/lib/db", () => ({ db: mockDb }));
vi.mock("@/lib/logger", () => ({ apiLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock("@/lib/tenant/resolver", () => ({ resolveRequestOrgId: vi.fn(async () => null) }));
vi.mock("@/lib/tenant-lane", () => ({ runWithTenantLane: (_o: unknown, _c: unknown, fn: () => unknown) => fn() }));
vi.mock("@/lib/contact-sync", () => ({ syncToContact: vi.fn() }));

import { GET } from "@/app/api/registrant/registrations/route";

beforeEach(() => {
  vi.clearAllMocks();
  mockAuth.mockResolvedValue({ user: { id: "u1", email: "a@b.com", role: "REGISTRANT" } });
  mockDb.registration.updateMany.mockResolvedValue({ count: 0 });
});

describe("GET /api/registrant/registrations", () => {
  it("leaves out the qrCode on a webinar registration, keeps it on a conference", async () => {
    mockDb.registration.findMany.mockResolvedValue([
      { id: "w", qrCode: "WEB-1", event: { eventType: "WEBINAR" } },
      { id: "c", qrCode: "CONF-1", event: { eventType: "CONFERENCE" } },
    ]);
    const body = (await (await GET(new Request("http://x"))).json()) as { id: string; qrCode: string | null }[];
    expect(body.find((r) => r.id === "w")?.qrCode).toBeNull();
    expect(body.find((r) => r.id === "c")?.qrCode).toBe("CONF-1");
    expect(mockDb.registration.findMany.mock.calls[0][0].include.event.select.eventType).toBe(true);
  });
});
