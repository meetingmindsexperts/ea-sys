/**
 * DTCM QR on the badge + the admin barcode PNG route (Aug 2026).
 *
 * DTCM barcodes are externally-issued Dubai compliance UUIDs (CSV-imported or
 * hand-entered). They now render as a QR in the badge's bottom band — ONLY on
 * events flagged `requiresDtcmBarcode` and only for rows carrying a value —
 * and the detail-sheet PNG endpoint serves them via `?code=dtcm`. Pins:
 *   - flag ON  → one QR render per UNIQUE DTCM value; audit row carries
 *     `dtcmQrCount` (the compliance trail: how many printed badges had a QR).
 *   - flag OFF → zero QR renders even when rows hold stale values.
 *   - PNG route: barcode-boundary 403 for MEMBER; dtcm 404s (unflagged event /
 *     value not set) are logged; entry path unchanged.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// Minimal valid 1x1 PNG so pdfkit can embed what the mocked renderers return.
const TINY_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64",
);

const { mockDb, mockAuth, renderBarcodeSpy, renderQrSpy, auditCreateSpy, warnSpy, infoSpy } =
  vi.hoisted(() => ({
    mockDb: {
      event: { findFirst: vi.fn() },
      registration: { findMany: vi.fn(), findFirst: vi.fn() },
    },
    mockAuth: vi.fn(),
    renderBarcodeSpy: vi.fn(),
    renderQrSpy: vi.fn(),
    auditCreateSpy: vi.fn().mockResolvedValue({}),
    warnSpy: vi.fn(),
    infoSpy: vi.fn(),
  }));

vi.mock("next/server", () => {
  class FakeNextResponse {
    status: number;
    private jsonBody: unknown;
    body: unknown;
    headers: { get: (k: string) => string | null };
    constructor(body: unknown, init?: { status?: number; headers?: Record<string, string> }) {
      this.body = body;
      this.status = init?.status ?? 200;
      this.headers = { get: (k: string) => init?.headers?.[k] ?? null };
    }
    async json() {
      return this.jsonBody;
    }
    static json(b: unknown, i?: { status?: number; headers?: Record<string, string> }) {
      const r = new FakeNextResponse(null, i);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (r as any).jsonBody = b;
      return r;
    }
  }
  return { NextResponse: FakeNextResponse };
});
vi.mock("@/lib/auth", () => ({ auth: () => mockAuth() }));
vi.mock("@/lib/db", () => ({
  db: mockDb,
  tenantTransaction: (cb: (tx: unknown) => unknown) =>
    cb({
      registration: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
      auditLog: { create: auditCreateSpy },
    }),
}));
vi.mock("@/lib/tenant-context", () => ({
  runWithTenant: (_org: string, cb: () => unknown) => cb(),
}));
vi.mock("@/lib/logger", () => ({
  apiLogger: { info: infoSpy, warn: warnSpy, error: vi.fn() },
}));
vi.mock("@/lib/auth-guards", () => ({
  denyReviewer: () => null,
  REGISTRATION_DESK_ALLOW: {},
}));
vi.mock("@/lib/security", () => ({ getClientIp: () => "1.2.3.4" }));
vi.mock("@/lib/check-in", () => ({ isPaymentAdmissible: () => true }));
vi.mock("@/lib/barcode", () => ({
  renderBarcodePng: (...args: unknown[]) => {
    renderBarcodeSpy(...args);
    return Promise.resolve(TINY_PNG);
  },
  renderQrPng: (...args: unknown[]) => {
    renderQrSpy(...args);
    return Promise.resolve(TINY_PNG);
  },
  entryBarcodeValue: (q: string, s?: number | null) =>
    s == null ? q : `${q}-${String(s).padStart(3, "0")}`,
}));
// Real barcode-visibility + event-access — the gates under test.
vi.mock("@/lib/barcode-visibility", async () => await vi.importActual("@/lib/barcode-visibility"));

import { POST as BADGES_POST } from "@/app/api/events/[eventId]/registrations/badges/route";
import { GET as BARCODE_GET } from "@/app/api/events/[eventId]/registrations/[registrationId]/barcode/route";

const DTCM_UUID = "f83dc515-ade6-46e8-b846-1f216f694b44";
const DTCM_UUID_2 = "0a1b2c3d-0000-4111-8222-333344445555";

const badgeParams = { params: Promise.resolve({ eventId: "ev1" }) };
const badgeReq = () =>
  new Request("http://t/api/events/ev1/registrations/badges", {
    method: "POST",
    body: JSON.stringify({ all: true }),
    headers: { "content-type": "application/json" },
  });

const regRow = (id: string, dtcm: string | null) => ({
  id,
  serialId: 7,
  qrCode: "1753791234567123456",
  dtcmBarcode: dtcm,
  badgeType: "DELEGATE",
  paymentStatus: "PAID",
  attendee: { firstName: "A", lastName: `B${id}`, country: "UAE" },
  ticketType: { name: "Std", price: 100 },
  pricingTier: null,
});

beforeEach(() => {
  vi.clearAllMocks();
  mockAuth.mockResolvedValue({
    user: { id: "u1", role: "ADMIN", organizationId: "org1" },
  });
});

describe("badge PDF — DTCM QR", () => {
  it("flag ON: renders one QR per UNIQUE DTCM value and audits dtcmQrCount", async () => {
    mockDb.event.findFirst.mockResolvedValue({
      id: "ev1",
      badgeVerticalOffset: 0,
      requiresDtcmBarcode: true,
    });
    // Two rows share one DTCM value (dedup → single render), one row has none.
    mockDb.registration.findMany.mockResolvedValue([
      regRow("r1", DTCM_UUID),
      regRow("r2", DTCM_UUID),
      regRow("r3", null),
    ]);

    const res = await BADGES_POST(badgeReq(), badgeParams);
    expect(res.status).toBe(200);
    expect(renderQrSpy).toHaveBeenCalledTimes(1);
    expect(renderQrSpy).toHaveBeenCalledWith(DTCM_UUID);
    // Compliance trail: 2 of 3 printed badges carried the DTCM QR.
    const audit = auditCreateSpy.mock.calls[0][0].data;
    expect(audit.action).toBe("BADGE_PRINTED");
    expect(audit.changes.dtcmQrCount).toBe(2);
    // The rendered-summary log line fired.
    expect(infoSpy.mock.calls.some((c) => c[0]?.msg === "badges:dtcm-rendered")).toBe(true);
  });

  it("flag ON with distinct values: each unique value renders once", async () => {
    mockDb.event.findFirst.mockResolvedValue({
      id: "ev1",
      badgeVerticalOffset: 0,
      requiresDtcmBarcode: true,
    });
    mockDb.registration.findMany.mockResolvedValue([
      regRow("r1", DTCM_UUID),
      regRow("r2", DTCM_UUID_2),
    ]);

    const res = await BADGES_POST(badgeReq(), badgeParams);
    expect(res.status).toBe(200);
    expect(renderQrSpy).toHaveBeenCalledTimes(2);
  });

  it("flag OFF: zero QR renders even when rows hold stale DTCM values; audit says 0", async () => {
    mockDb.event.findFirst.mockResolvedValue({
      id: "ev1",
      badgeVerticalOffset: 0,
      requiresDtcmBarcode: false,
    });
    mockDb.registration.findMany.mockResolvedValue([regRow("r1", DTCM_UUID)]);

    const res = await BADGES_POST(badgeReq(), badgeParams);
    expect(res.status).toBe(200);
    expect(renderQrSpy).not.toHaveBeenCalled();
    expect(auditCreateSpy.mock.calls[0][0].data.changes.dtcmQrCount).toBe(0);
  });
});

describe("admin barcode PNG route", () => {
  const pngParams = { params: Promise.resolve({ eventId: "ev1", registrationId: "r1" }) };
  const pngReq = (qs = "") =>
    new Request(`http://t/api/events/ev1/registrations/r1/barcode${qs}`);

  it("403s MEMBER — barcode boundary (both codes are door/compliance credentials)", async () => {
    mockAuth.mockResolvedValue({ user: { id: "m1", role: "MEMBER", organizationId: "org1" } });
    const res = await BARCODE_GET(pngReq(), pngParams);
    expect(res.status).toBe(403);
    expect(warnSpy.mock.calls.some((c) => c[0]?.msg === "registration-barcode:role-refused")).toBe(true);
    expect(renderBarcodeSpy).not.toHaveBeenCalled();
  });

  it("?code=dtcm on an unflagged event → 404, logged (stale values never render)", async () => {
    mockDb.event.findFirst.mockResolvedValue({ id: "ev1", requiresDtcmBarcode: false });
    mockDb.registration.findFirst.mockResolvedValue({
      qrCode: "123",
      serialId: 1,
      dtcmBarcode: DTCM_UUID,
    });
    const res = await BARCODE_GET(pngReq("?code=dtcm"), pngParams);
    expect(res.status).toBe(404);
    expect(warnSpy.mock.calls.some((c) => c[0]?.msg === "registration-barcode:dtcm-not-flagged")).toBe(true);
    expect(renderQrSpy).not.toHaveBeenCalled();
  });

  it("?code=dtcm with no value → 404, logged", async () => {
    mockDb.event.findFirst.mockResolvedValue({ id: "ev1", requiresDtcmBarcode: true });
    mockDb.registration.findFirst.mockResolvedValue({
      qrCode: "123",
      serialId: 1,
      dtcmBarcode: null,
    });
    const res = await BARCODE_GET(pngReq("?code=dtcm"), pngParams);
    expect(res.status).toBe(404);
    expect(warnSpy.mock.calls.some((c) => c[0]?.msg === "registration-barcode:dtcm-not-set")).toBe(true);
  });

  it("?code=dtcm happy path renders the QR of the stored value", async () => {
    mockDb.event.findFirst.mockResolvedValue({ id: "ev1", requiresDtcmBarcode: true });
    mockDb.registration.findFirst.mockResolvedValue({
      qrCode: "123",
      serialId: 1,
      dtcmBarcode: DTCM_UUID,
    });
    const res = await BARCODE_GET(pngReq("?code=dtcm"), pngParams);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("image/png");
    expect(renderQrSpy).toHaveBeenCalledWith(DTCM_UUID);
    expect(renderBarcodeSpy).not.toHaveBeenCalled();
  });

  it("default path renders the ENTRY Code 128 (serial-suffixed), never DTCM", async () => {
    mockDb.event.findFirst.mockResolvedValue({ id: "ev1", requiresDtcmBarcode: true });
    mockDb.registration.findFirst.mockResolvedValue({
      qrCode: "1753791234567123456",
      serialId: 7,
      dtcmBarcode: DTCM_UUID,
    });
    const res = await BARCODE_GET(pngReq(), pngParams);
    expect(res.status).toBe(200);
    expect(renderBarcodeSpy).toHaveBeenCalledWith("1753791234567123456-007", { includetext: true });
    expect(renderQrSpy).not.toHaveBeenCalled();
  });
});
