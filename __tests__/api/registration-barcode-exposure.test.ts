/**
 * Check-in review H7/H8 — the registration LIST GET must not hand every
 * attendee's entry barcode to a role that doesn't run the door, and the
 * registrant barcode route's org-staff branch must be assignment-scoped
 * (not org-wide) so an ONSITE temp can't cross events.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockDb, mockOrgCtx, mockRateLimit, capturedBarcodeWhere } = vi.hoisted(() => ({
  mockDb: {
    event: { findFirst: vi.fn() },
    registration: { findMany: vi.fn(), findFirst: vi.fn() },
  },
  mockOrgCtx: vi.fn(),
  mockRateLimit: vi.fn(),
  capturedBarcodeWhere: { value: null as unknown },
}));

vi.mock("next/server", () => ({
  NextResponse: {
    json: (b: unknown, i?: { status?: number }) => ({ status: i?.status ?? 200, json: async () => b, headers: { set: () => {} } }),
  },
}));
vi.mock("@/lib/db", () => ({ db: mockDb }));
vi.mock("@/lib/logger", () => ({ apiLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock("@/lib/api-auth", () => ({ getOrgContext: () => mockOrgCtx() }));
vi.mock("@/lib/auth", () => ({ auth: vi.fn() }));
vi.mock("@/lib/auth-guards", () => ({ denyReviewer: () => null, REGISTRATION_DESK_ALLOW: {} }));
vi.mock("@/lib/security", () => ({ getClientIp: () => "1.2.3.4", checkRateLimit: () => mockRateLimit() }));
vi.mock("@/lib/schemas", () => ({ titleEnum: { optional: () => ({}) }, attendeeRoleEnum: { optional: () => ({}) } }));
// Real event-access + visibility helpers — the point of the test.
vi.mock("@/lib/event-access", async () => await vi.importActual("@/lib/event-access"));
vi.mock("@/lib/finance-visibility", async () => await vi.importActual("@/lib/finance-visibility"));
vi.mock("@/lib/barcode-visibility", async () => await vi.importActual("@/lib/barcode-visibility"));

import { GET as LIST_GET } from "@/app/api/events/[eventId]/registrations/route";
import { GET as BARCODE_GET } from "@/app/api/registrant/registrations/[registrationId]/barcode/route";
import { auth } from "@/lib/auth";

const REGS = [
  { id: "r1", status: "CONFIRMED", paymentStatus: "PAID", qrCode: "ENTRY-1", dtcmBarcode: "DTCM-1", attendee: { firstName: "A", lastName: "B" } },
];

const listParams = { params: Promise.resolve({ eventId: "ev1" }) };
const listReq = () => new Request("http://localhost/x");

beforeEach(() => {
  vi.clearAllMocks();
  mockDb.event.findFirst.mockResolvedValue({ id: "ev1" });
  mockDb.registration.findMany.mockResolvedValue(REGS.map((r) => ({ ...r })));
  mockRateLimit.mockReturnValue({ allowed: true, retryAfterSeconds: 0 });
});

describe("H7 — list GET barcode exposure", () => {
  it("STRIPS qrCode/dtcmBarcode for MEMBER (finance-capable, but not a door role)", async () => {
    mockOrgCtx.mockResolvedValue({ organizationId: "org1", role: "MEMBER", userId: "m1" });
    const res = await LIST_GET(listReq(), listParams);
    const body = await res.json();
    expect("qrCode" in body[0]).toBe(false);
    expect("dtcmBarcode" in body[0]).toBe(false);
  });

  it("KEEPS barcodes for ONSITE (desk staff print badges)", async () => {
    mockOrgCtx.mockResolvedValue({ organizationId: "org1", role: "ONSITE", userId: "o1" });
    const res = await LIST_GET(listReq(), listParams);
    const body = await res.json();
    expect(body[0].qrCode).toBe("ENTRY-1");
  });

  it("KEEPS barcodes for an API-key caller (role null, admin-equivalent)", async () => {
    mockOrgCtx.mockResolvedValue({ organizationId: "org1", role: null, userId: null });
    const res = await LIST_GET(listReq(), listParams);
    const body = await res.json();
    expect(body[0].qrCode).toBe("ENTRY-1");
  });
});

describe("H8 — registrant barcode route assignment-scoping", () => {
  const barcodeParams = { params: Promise.resolve({ registrationId: "r1" }) };
  const barcodeReq = () => new Request("http://localhost/x");

  it("scopes an org-staff caller through buildEventAccessWhere (ONSITE → settings.onsiteUserIds, NOT org-wide)", async () => {
    (auth as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      user: { id: "o1", role: "ONSITE", organizationId: "org1" },
    });
    mockDb.registration.findFirst.mockImplementation((args: { where: unknown }) => {
      capturedBarcodeWhere.value = args.where;
      return Promise.resolve(null); // not assigned → 404
    });
    const res = await BARCODE_GET(barcodeReq(), barcodeParams);
    expect(res.status).toBe(404);
    // The event filter must carry the ONSITE assignment predicate, not a bare org id.
    const where = capturedBarcodeWhere.value as { event?: { settings?: unknown; organizationId?: string } };
    expect(where.event?.settings).toBeDefined();
    expect(where.event?.organizationId).toBe("org1");
  });

  it("owner-scopes a REGISTRANT to their own row", async () => {
    (auth as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      user: { id: "reg-user", role: "REGISTRANT", organizationId: null },
    });
    mockDb.registration.findFirst.mockImplementation((args: { where: unknown }) => {
      capturedBarcodeWhere.value = args.where;
      return Promise.resolve({ qrCode: null }); // no barcode → 404, but the where is what we assert
    });
    await BARCODE_GET(barcodeReq(), barcodeParams);
    const where = capturedBarcodeWhere.value as { userId?: string; event?: unknown };
    expect(where.userId).toBe("reg-user");
    expect(where.event).toBeUndefined();
  });

  it("429s when rate-limited", async () => {
    (auth as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      user: { id: "reg-user", role: "REGISTRANT", organizationId: null },
    });
    mockRateLimit.mockReturnValue({ allowed: false, retryAfterSeconds: 60 });
    const res = await BARCODE_GET(barcodeReq(), barcodeParams);
    expect(res.status).toBe(429);
    expect(mockDb.registration.findFirst).not.toHaveBeenCalled();
  });
});
