/**
 * The badge route tells the operator who was left out for payment (owner,
 * Nov 13, 2026). It prints only whom the door admits; a mixed selection used
 * to come back as a PDF for the rest and nothing else. The REAL door rule
 * runs here (check-in.ts is not mocked), so the left-out set is the door's.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockDb, mockAuth, generateSpy, auditCreateSpy, warnSpy, infoSpy, stampSpy } = vi.hoisted(() => ({
  mockDb: { event: { findFirst: vi.fn() }, registration: { findMany: vi.fn() } },
  mockAuth: vi.fn(),
  generateSpy: vi.fn(),
  auditCreateSpy: vi.fn().mockResolvedValue({}),
  warnSpy: vi.fn(),
  infoSpy: vi.fn(),
  stampSpy: vi.fn().mockResolvedValue({ count: 1 }),
}));

vi.mock("@/lib/auth", () => ({ auth: () => mockAuth() }));
vi.mock("@/lib/db", () => ({
  db: mockDb,
  tenantTransaction: (cb: (tx: unknown) => unknown) =>
    cb({
      registration: { updateMany: stampSpy },
      auditLog: { create: auditCreateSpy },
    }),
}));
vi.mock("@/lib/logger", () => ({ apiLogger: { info: infoSpy, warn: warnSpy, error: vi.fn(), debug: vi.fn() } }));
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
    expect(result).toEqual({ printed: 2, paymentDue: 2, paymentDueNumbers: ["009", "076"], noBadge: 0 });
    expect(badgeLeftOutMessage(result)).toBe(
      "2 badges ready to print. 2 left out, payment due: 009, 076. Record the payment or set them to Complimentary, then print those.",
    );

    // Logged at info (the print succeeded; warn feeds the error-rate card), and kept on the audit row.
    expect(infoSpy.mock.calls.some((c) => c[0]?.msg === "badges:left-out" && c[0]?.paymentDue === 2 && c[0]?.printed === 2)).toBe(true);
    expect(warnSpy).not.toHaveBeenCalled();
    const audit = auditCreateSpy.mock.calls[0][0].data;
    expect(audit.changes).toMatchObject({ count: 2, paymentDueLeftOut: 2, registrationIds: ["paid", "covered"] });
    // Only the printed rows are stamped as printed: both writes name exactly those ids.
    expect(stampSpy).toHaveBeenCalledTimes(2);
    for (const call of stampSpy.mock.calls) expect(call[0].where.id).toEqual({ in: ["paid", "covered"] });
  });

  it("nobody left out: the count is 0, no warning is logged, and the screen keeps its usual words", async () => {
    mockDb.registration.findMany.mockResolvedValue([row("a", 1), row("b", 2, { paymentStatus: "COMPLIMENTARY" })]);
    const res = await post({ all: true });
    expect(res.status).toBe(200);
    const result = readBadgePrintResult(res.headers);
    expect(result).toEqual({ printed: 2, paymentDue: 0, paymentDueNumbers: [], noBadge: 0 });
    expect(badgeLeftOutMessage(result)).toBeNull();
    expect(infoSpy.mock.calls.some((c) => c[0]?.msg === "badges:left-out")).toBe(false);
    expect(auditCreateSpy.mock.calls[0][0].data.changes.paymentDueLeftOut).toBe(0);
  });

  it("a cancelled or refunded row is never called payment due; it is counted with the virtual and the vanished", async () => {
    // Selected by id (the list shows cancelled rows and its select-all ticks them). The query
    // leaves out the virtual one and the one deleted since, so six were asked for and four came back.
    mockDb.registration.findMany.mockResolvedValue([
      row("paid", 12),
      row("owes", 76, { paymentStatus: "UNPAID" }),
      row("cancelled-unpaid", 30, { status: "CANCELLED", paymentStatus: "UNPAID" }),
      row("cancelled-refunded", 31, { status: "CANCELLED", paymentStatus: "REFUNDED" }),
    ]);
    const res = await post({ registrationIds: ["paid", "owes", "cancelled-unpaid", "cancelled-refunded", "virtual", "deleted", "paid"] });
    expect(res.status).toBe(200);
    const result = readBadgePrintResult(res.headers);
    // 1 printed + 1 owing + 4 with no badge = the 6 distinct ids asked for.
    expect(result).toEqual({ printed: 1, paymentDue: 1, paymentDueNumbers: ["076"], noBadge: 4 });
    expect(badgeLeftOutMessage(result)).toBe(
      "1 badge ready to print. 1 left out, payment due: 076. Record the payment or set it to Complimentary, then print that one. 4 others in the selection get no badge (virtual, cancelled or refunded).",
    );
    expect(auditCreateSpy.mock.calls[0][0].data.changes.paymentDueLeftOut).toBe(1);
  });

  it("a refunded registration whose place no longer stands is not payment due on Print All", async () => {
    mockDb.registration.findMany.mockResolvedValue([row("paid", 1), row("refunded-pending", 2, { status: "PENDING", paymentStatus: "REFUNDED" })]);
    const res = await post({ all: true });
    expect(readBadgePrintResult(res.headers)).toEqual({ printed: 1, paymentDue: 0, paymentDueNumbers: [], noBadge: 1 });
  });

  it("the query: by id it filters nothing but virtual, so cancelled rows do reach the rule", async () => {
    mockDb.registration.findMany.mockResolvedValue([row("paid", 12)]);
    await post({ registrationIds: ["paid"] });
    expect(mockDb.registration.findMany.mock.calls[0][0].where).toEqual({ eventId: "ev1", id: { in: ["paid"] }, attendanceMode: { not: "VIRTUAL" } });
    await post({ all: true });
    expect(mockDb.registration.findMany.mock.calls[1][0].where).toEqual({ eventId: "ev1", status: { not: "CANCELLED" }, attendanceMode: { not: "VIRTUAL" } });
  });

  it("a cancelled registration gets no badge, even paid or complimentary (owner, Nov 13, 2026)", async () => {
    // Ticking a page of the list selects its cancelled rows too.
    mockDb.registration.findMany.mockResolvedValue([
      row("paid", 12),
      row("cancelled-paid", 1, { status: "CANCELLED" }),
      row("cancelled-comp", 39, { status: "CANCELLED", paymentStatus: "COMPLIMENTARY" }),
    ]);
    const res = await post({ registrationIds: ["paid", "cancelled-paid", "cancelled-comp"] });
    expect(res.status).toBe(200);
    expect((generateSpy.mock.calls[0][0] as { id: string }[]).map((r) => r.id)).toEqual(["paid"]);
    expect(readBadgePrintResult(res.headers)).toEqual({ printed: 1, paymentDue: 0, paymentDueNumbers: [], noBadge: 2 });
    // Not stamped as printed either: both writes ran, and both name only the printed row.
    expect(stampSpy).toHaveBeenCalledTimes(2);
    for (const call of stampSpy.mock.calls) expect(call[0].where.id).toEqual({ in: ["paid"] });
  });

  it("a cancelled registration on its own is refused as cancelled, not as owing or unmatched", async () => {
    mockDb.registration.findMany.mockResolvedValue([row("cancelled-paid", 1, { status: "CANCELLED" })]);
    const res = await post({ registrationIds: ["cancelled-paid"] });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "This registration is cancelled, so it has no badge.", code: "BADGE_NOT_AVAILABLE" });
    expect(generateSpy).not.toHaveBeenCalled();
    expect(stampSpy).not.toHaveBeenCalled();
    expect(warnSpy.mock.calls.some((c) => c[0]?.msg === "badges:no-eligible-registrations" && c[0]?.code === "BADGE_NOT_AVAILABLE")).toBe(true);
  });

  it("nothing prints from an owing, a cancelled and a virtual one: the refusal counts the three asked for", async () => {
    // The query returns two of the three ids (the virtual one is left out of it).
    mockDb.registration.findMany.mockResolvedValue([
      row("owes", 76, { paymentStatus: "UNPAID" }),
      row("cancelled-paid", 1, { status: "CANCELLED" }),
    ]);
    const res = await post({ registrationIds: ["owes", "cancelled-paid", "virtual"] });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error:
        "None of the 3 selected registrations can be badged: 1 still owes payment (unpaid or pending). Record that payment, or set that registration to Complimentary, then print. The other 2 get no badge (virtual, cancelled or refunded).",
      code: "BADGE_PAYMENT_REQUIRED",
      blocked: 1,
    });
    expect(generateSpy).not.toHaveBeenCalled();
  });

  it("Print All with only a refunded registration whose place no longer stands", async () => {
    mockDb.registration.findMany.mockResolvedValue([row("refunded-pending", 2, { status: "PENDING", paymentStatus: "REFUNDED" })]);
    const res = await post({ all: true });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: "BADGE_NOT_AVAILABLE" });
  });

  it("everyone owes: still the refusal with its remedy, and nothing is printed", async () => {
    mockDb.registration.findMany.mockResolvedValue([row("owes", 76, { paymentStatus: "UNPAID" })]);
    const res = await post({ registrationIds: ["owes"] });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: "BADGE_PAYMENT_REQUIRED", blocked: 1 });
    expect(generateSpy).not.toHaveBeenCalled();
  });
});
