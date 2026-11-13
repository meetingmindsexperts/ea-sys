/**
 * The badge route tells the operator who was left out for payment (owner,
 * Nov 13, 2026). It prints only whom the door admits; a mixed selection used
 * to come back as a PDF for the rest and nothing else. The REAL door rule
 * runs here (check-in.ts is not mocked), so the left-out set is the door's.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockDb, mockAuth, generateSpy, auditCreateSpy, warnSpy } = vi.hoisted(() => ({
  mockDb: { event: { findFirst: vi.fn() }, registration: { findMany: vi.fn() } },
  mockAuth: vi.fn(),
  generateSpy: vi.fn(),
  auditCreateSpy: vi.fn().mockResolvedValue({}),
  warnSpy: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({ auth: () => mockAuth() }));
vi.mock("@/lib/db", () => ({
  db: mockDb,
  tenantTransaction: (cb: (tx: unknown) => unknown) =>
    cb({
      registration: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
      auditLog: { create: auditCreateSpy },
    }),
}));
vi.mock("@/lib/logger", () => ({ apiLogger: { info: vi.fn(), warn: warnSpy, error: vi.fn(), debug: vi.fn() } }));
vi.mock("@/lib/security", () => ({ getClientIp: () => "1.2.3.4" }));
vi.mock("@/lib/badge-pdf", () => ({
  generateBadgePDF: (...args: unknown[]) => {
    generateSpy(...args);
    return Promise.resolve(Buffer.from("%PDF-test"));
  },
}));

import { POST } from "@/app/api/events/[eventId]/registrations/badges/route";
import { badgeLeftOutMessage, readBadgePrintResult } from "@/lib/badge-print-result";

const params = { params: Promise.resolve({ eventId: "ev1" }) };
const post = (body: unknown) =>
  POST(
    new Request("http://t/api/events/ev1/registrations/badges", {
      method: "POST",
      body: JSON.stringify(body),
      headers: { "content-type": "application/json" },
    }),
    params,
  );

const row = (id: string, serialId: number, over: Record<string, unknown> = {}) => ({
  id,
  serialId,
  qrCode: `qr-${id}`,
  dtcmBarcode: null,
  badgeType: "DELEGATE",
  status: "CONFIRMED",
  paymentStatus: "PAID",
  originalPrice: 200,
  discountAmount: null,
  attendee: { firstName: "A", lastName: id, country: "UAE", organization: null },
  ticketType: { name: "Nurse", price: 0 },
  pricingTier: { price: 200 },
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  mockAuth.mockResolvedValue({ user: { id: "u1", role: "ADMIN", organizationId: "org1" } });
  mockDb.event.findFirst.mockResolvedValue({ id: "ev1", badgeVerticalOffset: 0, settings: {}, requiresDtcmBarcode: false });
});

describe("POST badges: a mixed selection", () => {
  it("prints whom the door admits and names the rest in the response", async () => {
    mockDb.registration.findMany.mockResolvedValue([
      row("paid", 12),
      row("owes", 76, { paymentStatus: "UNPAID" }),
      // A code that takes the whole fee owes nothing, though the status says UNPAID.
      row("covered", 69, { paymentStatus: "UNPAID", discountAmount: 200 }),
      row("pending-pay", 9, { paymentStatus: "PENDING" }),
    ]);
    const res = await post({ registrationIds: ["paid", "owes", "covered", "pending-pay"] });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/pdf");

    const printed = generateSpy.mock.calls[0][0] as { id: string }[];
    expect(printed.map((r) => r.id)).toEqual(["paid", "covered"]);

    const result = readBadgePrintResult(res.headers);
    expect(result).toEqual({ printed: 2, paymentDue: 2, paymentDueNumbers: ["009", "076"] });
    expect(badgeLeftOutMessage(result)).toBe(
      "2 badges ready to print. 2 left out, payment due: 009, 076. Record the payment or set them to Complimentary, then print those.",
    );

    // Logged, and kept on the print's audit row. Only the printed ids are stamped as printed.
    expect(warnSpy.mock.calls.some((c) => c[0]?.msg === "badges:left-out-payment-due" && c[0]?.leftOut === 2 && c[0]?.printed === 2)).toBe(true);
    const audit = auditCreateSpy.mock.calls[0][0].data;
    expect(audit.changes).toMatchObject({ count: 2, paymentDueLeftOut: 2, registrationIds: ["paid", "covered"] });
  });

  it("nobody left out: the count is 0, no warning is logged, and the screen keeps its usual words", async () => {
    mockDb.registration.findMany.mockResolvedValue([row("a", 1), row("b", 2, { paymentStatus: "COMPLIMENTARY" })]);
    const res = await post({ all: true });
    expect(res.status).toBe(200);
    const result = readBadgePrintResult(res.headers);
    expect(result).toEqual({ printed: 2, paymentDue: 0, paymentDueNumbers: [] });
    expect(badgeLeftOutMessage(result)).toBeNull();
    expect(warnSpy.mock.calls.some((c) => c[0]?.msg === "badges:left-out-payment-due")).toBe(false);
    expect(auditCreateSpy.mock.calls[0][0].data.changes.paymentDueLeftOut).toBe(0);
  });

  it("everyone owes: still the refusal with its remedy, and nothing is printed", async () => {
    mockDb.registration.findMany.mockResolvedValue([row("owes", 76, { paymentStatus: "UNPAID" })]);
    const res = await post({ registrationIds: ["owes"] });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: "BADGE_PAYMENT_REQUIRED", blocked: 1 });
    expect(generateSpy).not.toHaveBeenCalled();
  });
});
