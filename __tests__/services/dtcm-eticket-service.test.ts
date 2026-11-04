/**
 * The DET purchase rules (docs/DTCM_ETICKET_PLAN.md §5.2, step 3). Each test
 * pins one way a real ticket could be bought twice, lost, or put on the wrong
 * person. DET and the database are mocked.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { Prisma } from "@prisma/client";

const { mockDb, det, mockGetCreds, logger } = vi.hoisted(() => ({
  mockDb: {
    event: { findFirst: vi.fn() },
    registration: { findFirst: vi.fn(), updateMany: vi.fn(), count: vi.fn(), findMany: vi.fn() },
    dtcmOrder: { create: vi.fn(), update: vi.fn(), updateMany: vi.fn(), findUnique: vi.fn(), findUniqueOrThrow: vi.fn(), findFirst: vi.fn(), findMany: vi.fn() },
    auditLog: { create: vi.fn() },
    $transaction: vi.fn(),
  },
  det: {
    getDetPerformance: vi.fn(),
    createDetBasket: vi.fn(),
    createDetCustomer: vi.fn(),
    purchaseDetBasket: vi.fn(),
    detBasketExists: vi.fn(),
    deleteDetBasket: vi.fn(),
    getDetOrder: vi.fn(),
    reverseDetOrder: vi.fn(),
  },
  mockGetCreds: vi.fn(),
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock("@/lib/db", () => ({ db: mockDb }));
vi.mock("@/lib/logger", () => ({ apiLogger: logger }));
vi.mock("@/lib/tenant-context", () => ({ runWithTenant: (_o: string, fn: () => unknown) => fn() }));
vi.mock("@/lib/dtcm-eticket/credentials", () => ({ getDetCredentials: mockGetCreds }));
vi.mock("@/lib/dtcm-eticket/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/dtcm-eticket/client")>()),
  ...det,
}));

import {
  buyForRegistration,
  issueDtcmTicket,
  loadDtcmPurchaseContext,
  listUnusedDtcmOrders,
  markDtcmOrderReversed,
  resolveDtcmOrder,
  reverseDtcmOrder,
  STALE_PENDING_MS,
  unusedReason,
} from "@/services/dtcm-eticket-service";
import { DetApiError } from "@/lib/dtcm-eticket/client";

const creds = (environment: "staging" | "production" = "staging") => ({
  organizationId: "org1",
  environment,
  clientId: "AMMEE1",
  clientSecret: "s",
  apiKey: "k",
  version: "v",
});

const event = {
  requiresDtcmBarcode: true,
  dtcmPerformanceCode: "PDUB01DEC2023B",
  settings: {
    dtcm: {
      sections: { "tt-1": { area: "SVIP2", priceTypeCode: "C" } },
      environment: "staging",
      performanceCode: "PDUB01DEC2023B",
      checkedAt: "2026-11-03T12:00:00Z",
    },
  },
};

const registration = (over: Record<string, unknown> = {}) => ({
  id: "reg-1",
  status: "CONFIRMED",
  attendanceMode: "IN_PERSON",
  dtcmBarcode: null,
  ticketTypeId: "tt-1",
  attendee: { title: "DR", firstName: "Aisha", lastName: "Khan", email: "a@example.com", phone: "+971 50 123 4567", country: "United Arab Emirates" },
  ...over,
});

const performance = {
  performanceCode: "PDUB01DEC2023B",
  name: "Batch 3",
  startDate: null,
  endDate: null,
  venueCode: null,
  sections: [{ code: "SVIP2", name: "VIP2", categoryId: 78, capacity: 100, holds: 0 }],
  priceTypes: [{ code: "C", name: "Comps", categoryId: 78, price: 0 }],
};

const input = { organizationId: "org1", eventId: "evt1", registrationId: "reg-1", userId: "u1", source: "rest" as const };
const unknownOutcome = () => new DetApiError("DET purchaseBasket answered 504", "purchaseBasket", 504);
const refused = (stage: "createBasket" | "createCustomer" | "purchaseBasket") =>
  new DetApiError(`DET ${stage} failed (HTTP 400, code 5005): Section soldout`, stage, 400, "5005");

/** The order row as the mock database holds it, so updates compose. */
let row: Record<string, unknown>;

beforeEach(() => {
  vi.clearAllMocks();
  mockDb.event.findFirst.mockResolvedValue(event);
  mockDb.registration.findFirst.mockResolvedValue(registration());
  mockDb.registration.updateMany.mockResolvedValue({ count: 1 });
  mockDb.auditLog.create.mockResolvedValue({});
  mockGetCreds.mockResolvedValue(creds());
  det.getDetPerformance.mockResolvedValue(performance);
  det.createDetBasket.mockResolvedValue("B1");
  det.createDetCustomer.mockResolvedValue({ id: "C1", account: "0", aFile: "tel" });
  det.purchaseDetBasket.mockResolvedValue("O1");
  det.getDetOrder.mockResolvedValue({ orderId: "O1", barcode: "BAR-1" });
  det.deleteDetBasket.mockResolvedValue(undefined);
  mockDb.dtcmOrder.create.mockImplementation(async ({ data }) => (row = { id: "do-1", updatedAt: new Date(), ...data }));
  mockDb.dtcmOrder.update.mockImplementation(async ({ data }) => (row = { ...row, ...data }));
  // A conditional write: applies only while the row still has the status it was read with.
  mockDb.dtcmOrder.updateMany.mockImplementation(async ({ where, data }) => {
    if (where.status !== undefined && row.status !== where.status) return { count: 0 };
    row = { ...row, ...data };
    return { count: 1 };
  });
  mockDb.dtcmOrder.findUniqueOrThrow.mockImplementation(async () => row);
  // Both forms: an array of operations, or an interactive callback given the client.
  mockDb.$transaction.mockImplementation(async (ops: unknown) =>
    typeof ops === "function" ? (ops as (tx: typeof mockDb) => unknown)(mockDb) : Promise.all(ops as Promise<unknown>[]),
  );
  mockDb.registration.count.mockResolvedValue(0);
  mockDb.registration.findMany.mockResolvedValue([]);
});

const statusWrites = () =>
  [...mockDb.dtcmOrder.update.mock.calls, ...mockDb.dtcmOrder.updateMany.mock.calls]
    .map(([a], i) => ({ a, order: i }))
    .map(({ a }) => a.data);
/** The row's final state, which is what the rules are about. */
const finalRow = () => row;

describe("the purchase", () => {
  it("writes the intent row first, buys at DET's price, and puts the barcode on a code-less registration", async () => {
    const out = await issueDtcmTicket(input);
    expect(out).toMatchObject({ ok: true, barcode: "BAR-1" });
    const created = mockDb.dtcmOrder.create.mock.calls[0][0].data;
    expect(created).toMatchObject({ activeKey: "reg-1", status: "PENDING", environment: "staging", area: "SVIP2", priceTypeCode: "C" });
    expect(created.amount).toEqual(new Prisma.Decimal(0));
    expect(mockDb.dtcmOrder.create.mock.invocationCallOrder[0]).toBeLessThan(det.createDetBasket.mock.invocationCallOrder[0]);
    expect(det.purchaseDetBasket.mock.calls[0][3]).toBe(0);
    expect(det.createDetCustomer.mock.calls[0][1]).toMatchObject({
      externalId: "reg-1",
      title: "Dr",
      nationality: "AE",
      countryCode: "AE",
      phoneNumber: "+971501234567",
    });
    expect(mockDb.registration.updateMany).toHaveBeenCalledWith({ where: { id: "reg-1", dtcmBarcode: null }, data: { dtcmBarcode: "BAR-1" } });
  });

  it("stops at the insert when an attempt is already live: no DET call at all", async () => {
    mockDb.dtcmOrder.create.mockRejectedValue(new Prisma.PrismaClientKnownRequestError("dup", { code: "P2002", clientVersion: "x" }));
    mockDb.dtcmOrder.findUnique.mockResolvedValue({ id: "do-0", status: "PENDING", updatedAt: new Date() });
    expect(await issueDtcmTicket(input)).toMatchObject({ ok: false, code: "ALREADY_IN_PROGRESS" });
    expect(det.createDetBasket).not.toHaveBeenCalled();
  });

  it("refuses a mapping checked in the other environment before writing anything", async () => {
    mockGetCreds.mockResolvedValue(creds("production"));
    expect(await issueDtcmTicket(input)).toMatchObject({ ok: false, code: "MAPPING_STALE" });
    expect(mockDb.dtcmOrder.create).not.toHaveBeenCalled();
  });

  it("refuses an attendee DET cannot take (no phone) before writing anything", async () => {
    mockDb.registration.findFirst.mockResolvedValue(registration({ attendee: { ...registration().attendee, phone: null } }));
    expect(await issueDtcmTicket(input)).toMatchObject({ ok: false, code: "MISSING_PHONE" });
    expect(mockDb.dtcmOrder.create).not.toHaveBeenCalled();
  });
});

describe("failures before the sale are definite: released and retryable", () => {
  it("basket refused: FAILED, activeKey cleared, nothing to release", async () => {
    det.createDetBasket.mockRejectedValue(refused("createBasket"));
    expect(await issueDtcmTicket(input)).toMatchObject({ ok: false, code: "DET_REFUSED" });
    expect(finalRow()).toMatchObject({ status: "FAILED", activeKey: null, errorStage: "createBasket" });
    expect(det.deleteDetBasket).not.toHaveBeenCalled();
  });

  it("customer refused: the basket's seat is released", async () => {
    det.createDetCustomer.mockRejectedValue(refused("createCustomer"));
    await issueDtcmTicket(input);
    expect(det.deleteDetBasket).toHaveBeenCalledWith(expect.anything(), "B1");
    expect(finalRow()).toMatchObject({ status: "FAILED", activeKey: null });
  });

  it("purchase refused with a definite 4xx: released and FAILED", async () => {
    det.purchaseDetBasket.mockRejectedValue(refused("purchaseBasket"));
    expect(await issueDtcmTicket(input)).toMatchObject({ code: "DET_REFUSED" });
    expect(det.detBasketExists).not.toHaveBeenCalled();
    expect(det.deleteDetBasket).toHaveBeenCalled();
  });
});

describe("a lost purchase answer is never retried blindly", () => {
  it("basket still at DET: nothing was bought, released and FAILED", async () => {
    det.purchaseDetBasket.mockRejectedValue(unknownOutcome());
    det.detBasketExists.mockResolvedValue(true);
    expect(await issueDtcmTicket(input)).toMatchObject({ code: "DET_REFUSED" });
    expect(det.deleteDetBasket).toHaveBeenCalled();
    expect(finalRow()).toMatchObject({ status: "FAILED", activeKey: null });
  });

  it("basket gone: UNCERTAIN, activeKey KEPT, basket untouched, nothing on the registration", async () => {
    det.purchaseDetBasket.mockRejectedValue(unknownOutcome());
    det.detBasketExists.mockResolvedValue(false);
    expect(await issueDtcmTicket(input)).toMatchObject({ ok: false, code: "UNCERTAIN" });
    expect(finalRow()).toMatchObject({ status: "UNCERTAIN", activeKey: "reg-1" });
    expect(det.deleteDetBasket).not.toHaveBeenCalled();
    expect(mockDb.registration.updateMany).not.toHaveBeenCalled();
    expect(mockDb.auditLog.create.mock.calls[0][0].data.action).toBe("DTCM_ORDER_UNCERTAIN");
  });

  it("basket seen but its delete fails: UNCERTAIN, never FAILED or pooled (review HIGH 1)", async () => {
    // Our timeout fired while DET was still committing: the basket is visible,
    // then sold, so the delete answers 5001. That is not proof of "not bought".
    det.purchaseDetBasket.mockRejectedValue(new DetApiError("DET purchaseBasket timed out after 30s", "purchaseBasket", null));
    det.detBasketExists.mockResolvedValue(true);
    det.deleteDetBasket.mockRejectedValue(new DetApiError("DET deleteBasket failed (HTTP 400, code 5001)", "deleteBasket", 400, "5001"));
    expect(await issueDtcmTicket(input)).toMatchObject({ ok: false, code: "UNCERTAIN" });
    expect(finalRow()).toMatchObject({ status: "UNCERTAIN", activeKey: "reg-1" });
  });

  it("basket check itself fails: UNCERTAIN, not FAILED", async () => {
    det.purchaseDetBasket.mockRejectedValue(unknownOutcome());
    det.detBasketExists.mockRejectedValue(new DetApiError("no answer", "getBasket", null));
    expect(await issueDtcmTicket(input)).toMatchObject({ code: "UNCERTAIN" });
  });
});

describe("after the sale", () => {
  it("an unreadable order is PURCHASED without a barcode, never FAILED", async () => {
    det.getDetOrder.mockRejectedValue(new DetApiError("no answer", "getOrder", null));
    expect(await issueDtcmTicket(input)).toMatchObject({ ok: false, code: "PURCHASED_NO_BARCODE" });
    expect(statusWrites().some((d) => d.status === "FAILED")).toBe(false);
    expect(row).toMatchObject({ status: "PURCHASED", orderId: "O1" });
  });

  it("a registration that got a code meanwhile keeps it, and the sale is reported", async () => {
    mockDb.registration.updateMany.mockResolvedValue({ count: 0 });
    expect(await issueDtcmTicket(input)).toMatchObject({ ok: false, code: "CODE_ARRIVED_MEANWHILE" });
    expect(row).toMatchObject({ status: "PURCHASED", barcode: "BAR-1" });
  });

  it("records a sale that lands after a person resolved the attempt, and says so", async () => {
    det.purchaseDetBasket.mockImplementation(async () => {
      row = { ...row, status: "FAILED", activeKey: null }; // a person marked it not bought meanwhile
      return "O1";
    });
    await issueDtcmTicket(input);
    expect(row).toMatchObject({ orderId: "O1", status: "PURCHASED" });
    expect(logger.error).toHaveBeenCalledWith(expect.objectContaining({ msg: "dtcm-eticket:sold-after-resolution" }));
  });

  it("tells the desk which barcode DET already sold, instead of 'in progress'", async () => {
    mockDb.dtcmOrder.create.mockRejectedValue(new Prisma.PrismaClientKnownRequestError("dup", { code: "P2002", clientVersion: "x" }));
    mockDb.dtcmOrder.findUnique.mockResolvedValue({ id: "do-0", status: "PURCHASED", orderId: "O9", barcode: "BAR-9", updatedAt: new Date() });
    const out = await issueDtcmTicket(input);
    expect(out).toMatchObject({ ok: false, code: "ALREADY_IN_PROGRESS" });
    expect(out.ok ? "" : out.message).toContain("BAR-9");
  });

  it("logs the DET order number BEFORE writing it, so a crash cannot lose it", async () => {
    await issueDtcmTicket(input);
    const logged = logger.info.mock.calls.findIndex(([o]) => o?.msg === "dtcm-eticket:issue-purchased");
    const loggedAt = logger.info.mock.invocationCallOrder[logged];
    const writeAt = mockDb.dtcmOrder.updateMany.mock.invocationCallOrder[
      mockDb.dtcmOrder.updateMany.mock.calls.findIndex(([a]) => a.data.orderId === "O1")
    ];
    expect(loggedAt).toBeLessThan(writeAt);
  });
});

describe("resolving", () => {
  const uncertain = (over: Record<string, unknown> = {}) => ({
    id: "do-9",
    eventId: "evt1",
    registrationId: "reg-1",
    environment: "production",
    status: "UNCERTAIN",
    orderId: null,
    barcode: null,
    errorMessage: "504",
    updatedAt: new Date(),
    ...over,
  });
  const resolveInput = (action: Parameters<typeof resolveDtcmOrder>[0]["action"]) => ({
    organizationId: "org1",
    eventId: "evt1",
    dtcmOrderId: "do-9",
    userId: "u1",
    action,
  });

  it("checks a found order with DET in the ORDER's environment, then records its barcode", async () => {
    row = uncertain();
    // First lookup: the order row; second: "does another row hold 777?" (no).
    mockDb.dtcmOrder.findFirst.mockResolvedValueOnce(row).mockResolvedValueOnce(null);
    mockGetCreds.mockResolvedValue(creds("production"));
    det.getDetOrder.mockResolvedValue({ orderId: "777", barcode: "BAR-7", section: null, priceTypeCode: null, customerId: null });
    const out = await resolveDtcmOrder(resolveInput({ kind: "found", detOrderId: "777" }));
    expect(out).toMatchObject({ ok: true, barcode: "BAR-7" });
    expect(mockGetCreds).toHaveBeenCalledWith("org1", "production");
    expect(mockDb.registration.updateMany).toHaveBeenCalledWith({ where: { id: "reg-1", dtcmBarcode: null }, data: { dtcmBarcode: "BAR-7" } });
  });

  it("refuses a real order that is not this purchase (another section) (review MED 2)", async () => {
    row = uncertain({ area: "SVIP2", priceTypeCode: "C" });
    mockDb.dtcmOrder.findFirst.mockResolvedValueOnce(row).mockResolvedValueOnce(null);
    det.getDetOrder.mockResolvedValue({ orderId: "778", barcode: "BAR-X", section: "SGOLDA", priceTypeCode: "D", customerId: null });
    expect(await resolveDtcmOrder(resolveInput({ kind: "found", detOrderId: "778" }))).toMatchObject({ ok: false, code: "ORDER_MISMATCH" });
    expect(mockDb.registration.updateMany).not.toHaveBeenCalled();
  });

  it("refuses an order number another row already holds", async () => {
    mockDb.dtcmOrder.findFirst.mockResolvedValueOnce(uncertain()).mockResolvedValueOnce({ id: "do-other" });
    expect(await resolveDtcmOrder(resolveInput({ kind: "found", detOrderId: "68167" }))).toMatchObject({ ok: false, code: "ORDER_ALREADY_LINKED" });
    expect(det.getDetOrder).not.toHaveBeenCalled();
  });

  it("two people resolving at once: the second is refused (review MED 3)", async () => {
    row = uncertain();
    mockDb.dtcmOrder.findFirst.mockResolvedValue({ ...row });
    row = { ...row, status: "FAILED" }; // the other organiser's write landed first
    expect(await resolveDtcmOrder(resolveInput({ kind: "not-bought" }))).toMatchObject({ ok: false, code: "WRONG_STATUS" });
  });

  it("refuses an order number DET does not know", async () => {
    mockDb.dtcmOrder.findFirst.mockResolvedValueOnce(uncertain()).mockResolvedValueOnce(null);
    det.getDetOrder.mockResolvedValue(null);
    expect(await resolveDtcmOrder(resolveInput({ kind: "found", detOrderId: "1" }))).toMatchObject({ ok: false, code: "DET_ORDER_NOT_FOUND" });
    expect(mockDb.registration.updateMany).not.toHaveBeenCalled();
  });

  it("'not bought' ends the attempt so a new one may start", async () => {
    row = uncertain();
    mockDb.dtcmOrder.findFirst.mockResolvedValue(row);
    expect(await resolveDtcmOrder(resolveInput({ kind: "not-bought" }))).toMatchObject({ ok: true });
    expect(finalRow()).toMatchObject({ status: "FAILED", activeKey: null });
  });

  it("only an unresolved order can be resolved: a fresh PENDING is still in flight", async () => {
    mockDb.dtcmOrder.findFirst.mockResolvedValue(uncertain({ status: "PENDING", updatedAt: new Date() }));
    expect(await resolveDtcmOrder(resolveInput({ kind: "not-bought" }))).toMatchObject({ ok: false, code: "WRONG_STATUS" });
  });

  it("but a PENDING left by a crash can be", async () => {
    row = uncertain({ status: "PENDING", updatedAt: new Date(Date.now() - STALE_PENDING_MS - 1000) });
    mockDb.dtcmOrder.findFirst.mockResolvedValue(row);
    expect(await resolveDtcmOrder(resolveInput({ kind: "not-bought" }))).toMatchObject({ ok: true });
  });
});

describe("reversing an unused ticket (step 5)", () => {
  const bought = (over: Record<string, unknown> = {}) => ({
    id: "do-5",
    eventId: "evt1",
    registrationId: "reg-1",
    environment: "production",
    status: "PURCHASED",
    orderId: "O5",
    barcode: "BAR-5",
    amount: new Prisma.Decimal(0),
    updatedAt: new Date(),
    registration: { status: "CANCELLED", dtcmBarcode: "BAR-5" },
    ...over,
  });
  const reverse = () => reverseDtcmOrder({ organizationId: "org1", eventId: "evt1", dtcmOrderId: "do-5", userId: "u1" });

  beforeEach(() => {
    row = bought();
    mockDb.dtcmOrder.findFirst.mockResolvedValue(row);
    mockGetCreds.mockResolvedValue(creds("production"));
  });

  it("knows which tickets are unused", () => {
    expect(unusedReason({ status: "PURCHASED", barcode: "B" }, null)).toBe("REGISTRATION_DELETED");
    expect(unusedReason({ status: "PURCHASED", barcode: "B" }, { status: "CANCELLED", dtcmBarcode: "B" })).toBe("REGISTRATION_CANCELLED");
    expect(unusedReason({ status: "PURCHASED", barcode: "B" }, { status: "CONFIRMED", dtcmBarcode: "OTHER" })).toBe("BARCODE_NOT_ON_REGISTRATION");
    expect(unusedReason({ status: "PURCHASED", barcode: "B" }, { status: "CONFIRMED", dtcmBarcode: "B" })).toBeNull();
    expect(unusedReason({ status: "FAILED", barcode: null }, null)).toBeNull();
  });

  it("refuses a ticket still on an active registration, without calling DET", async () => {
    mockDb.dtcmOrder.findFirst.mockResolvedValue(bought({ registration: { status: "CONFIRMED", dtcmBarcode: "BAR-5" } }));
    expect(await reverse()).toMatchObject({ ok: false, code: "STILL_IN_USE" });
    expect(det.reverseDetOrder).not.toHaveBeenCalled();
  });

  it("reverses in the order's environment, frees the slot, and clears only a matching code", async () => {
    det.reverseDetOrder.mockResolvedValue("reversed");
    expect(await reverse()).toMatchObject({ ok: true, clearedRegistrationCode: true });
    expect(mockGetCreds).toHaveBeenCalledWith("org1", "production");
    expect(det.reverseDetOrder).toHaveBeenCalledWith(expect.anything(), "O5", 0);
    expect(row).toMatchObject({ status: "REVERSED", activeKey: null });
    // Cleared only while the registration still holds this barcode AND is still cancelled.
    expect(mockDb.registration.updateMany).toHaveBeenCalledWith({
      where: { id: "reg-1", dtcmBarcode: "BAR-5", status: "CANCELLED" },
      data: { dtcmBarcode: null },
    });
    expect(mockDb.auditLog.create.mock.calls.at(-1)?.[0].data.action).toBe("DTCM_ORDER_REVERSED");
  });

  it("refuses when the barcode is on someone else's active registration (shared code, review HIGH 1)", async () => {
    mockDb.registration.count.mockResolvedValue(1);
    expect(await reverse()).toMatchObject({ ok: false, code: "STILL_IN_USE" });
    expect(det.reverseDetOrder).not.toHaveBeenCalled();
  });

  it("leaves a shared, in-use ticket off the unused list", async () => {
    mockDb.dtcmOrder.findMany.mockResolvedValue([
      { ...bought(), registration: { status: "CANCELLED", dtcmBarcode: "BAR-5", attendee: { firstName: "A", lastName: "C" } } },
      { ...bought({ id: "do-6", barcode: "BAR-6" }), registration: { status: "CANCELLED", dtcmBarcode: "BAR-6", attendee: { firstName: "D", lastName: "E" } } },
    ]);
    mockDb.registration.findMany.mockResolvedValue([{ dtcmBarcode: "BAR-5" }]); // BAR-5 moved to an active person
    const list = await listUnusedDtcmOrders("evt1");
    expect(list.map((o) => o.id)).toEqual(["do-6"]);
  });

  it("records nothing when someone else settled the order first (review LOW 3)", async () => {
    det.reverseDetOrder.mockResolvedValue("reversed");
    mockDb.dtcmOrder.updateMany.mockResolvedValueOnce({ count: 0 });
    expect(await reverse()).toMatchObject({ ok: false, code: "WRONG_STATUS" });
    expect(mockDb.registration.updateMany).not.toHaveBeenCalled();
    expect(mockDb.auditLog.create.mock.calls.some(([a]) => a.data.action === "DTCM_ORDER_REVERSED")).toBe(false);
  });

  it("'mark as reversed' believes DET only when DET no longer has the order (review MED 2)", async () => {
    det.getDetOrder.mockResolvedValueOnce({ orderId: "O5" });
    expect(await markDtcmOrderReversed({ organizationId: "org1", eventId: "evt1", dtcmOrderId: "do-5", userId: "u1" })).toMatchObject({
      ok: false,
      code: "DET_FAILED",
    });
    expect(row.status).toBe("PURCHASED");
    det.getDetOrder.mockResolvedValueOnce(null);
    expect(await markDtcmOrderReversed({ organizationId: "org1", eventId: "evt1", dtcmOrderId: "do-5", userId: "u1" })).toMatchObject({ ok: true });
    expect(row.status).toBe("REVERSED");
    expect(mockDb.auditLog.create.mock.calls.at(-1)?.[0].data.action).toBe("DTCM_ORDER_MARKED_REVERSED");
  });

  it("does NOT mark it reversed on DET's 'not found' (it may be another environment's)", async () => {
    det.reverseDetOrder.mockResolvedValue("not-found");
    expect(await reverse()).toMatchObject({ ok: false, code: "DET_NOT_FOUND" });
    expect(row.status).toBe("PURCHASED");
  });

  it("settles a lost answer by reading the order back", async () => {
    det.reverseDetOrder.mockRejectedValue(new DetApiError("no answer", "reverseOrder", null));
    det.getDetOrder.mockResolvedValueOnce(null);
    expect(await reverse()).toMatchObject({ ok: true });
    expect(row.status).toBe("REVERSED");

    row = bought();
    mockDb.dtcmOrder.findFirst.mockResolvedValue(row);
    det.getDetOrder.mockResolvedValueOnce({ orderId: "O5", barcode: "BAR-5" });
    expect(await reverse()).toMatchObject({ ok: false, code: "DET_FAILED" });
    expect(row.status).toBe("PURCHASED");
  });
});

describe("review of steps 0 to 5", () => {
  const bought = (over: Record<string, unknown> = {}) => ({
    id: "do-5",
    eventId: "evt1",
    registrationId: "reg-1",
    environment: "production",
    status: "PURCHASED",
    orderId: "O5",
    barcode: "BAR-5",
    detClientId: "AMMEE1",
    amount: new Prisma.Decimal(0),
    updatedAt: new Date(),
    registration: { status: "CANCELLED", dtcmBarcode: "BAR-5" },
    ...over,
  });
  const reverse = () => reverseDtcmOrder({ organizationId: "org1", eventId: "evt1", dtcmOrderId: "do-5", userId: "u1" });
  const markReversed = () => markDtcmOrderReversed({ organizationId: "org1", eventId: "evt1", dtcmOrderId: "do-5", userId: "u1" });

  it("MED 2: the purchase re-reads the registration, so a code assigned since the caller's list blocks it", async () => {
    const loaded = await loadDtcmPurchaseContext("org1", "evt1", "u1", "worker", "run1");
    if (!loaded.ok) throw new Error("context");
    // The run's list (a tick old) said no code; the registration has one now.
    mockDb.registration.findFirst.mockResolvedValue(registration({ dtcmBarcode: "POOL-1" }));
    expect(await buyForRegistration(loaded.context, "reg-1")).toMatchObject({ ok: false, code: "ALREADY_HAS_CODE" });
    expect(mockDb.registration.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { id: "reg-1", eventId: "evt1" } }));
    expect(mockDb.dtcmOrder.create).not.toHaveBeenCalled();
    expect(det.createDetBasket).not.toHaveBeenCalled();
  });

  it("MED 2: and a registration cancelled since is not bought for", async () => {
    const loaded = await loadDtcmPurchaseContext("org1", "evt1", "u1", "worker", "run1");
    if (!loaded.ok) throw new Error("context");
    mockDb.registration.findFirst.mockResolvedValue(registration({ status: "CANCELLED" }));
    expect(await buyForRegistration(loaded.context, "reg-1")).toMatchObject({ ok: false, code: "CANCELLED" });
    expect(mockDb.dtcmOrder.create).not.toHaveBeenCalled();
  });

  it("MED 4: a purchase records the DET client id it was bought with", async () => {
    await issueDtcmTicket(input);
    expect(mockDb.dtcmOrder.create.mock.calls[0][0].data).toMatchObject({ detClientId: "AMMEE1" });
  });

  describe("reverse and mark-reversed", () => {
    beforeEach(() => {
      row = bought();
      mockDb.dtcmOrder.findFirst.mockResolvedValue(row);
      mockGetCreds.mockResolvedValue(creds("production"));
    });

    it("MED 3: a code put on an active registration while DET reversed is reported, not hidden", async () => {
      det.reverseDetOrder.mockResolvedValue("reversed");
      // Free before the DET call; on someone's badge again by the time it is recorded.
      mockDb.registration.count.mockResolvedValueOnce(0).mockResolvedValueOnce(1);
      expect(await reverse()).toMatchObject({ ok: true, codeStillInUse: true });
      expect(row.status).toBe("REVERSED");
      expect(logger.error).toHaveBeenCalledWith(expect.objectContaining({ msg: "dtcm-eticket:reversed-code-in-use" }));
    });

    it("MED 4: 'mark reversed' refuses a ticket still in use, without asking DET", async () => {
      mockDb.dtcmOrder.findFirst.mockResolvedValue(bought({ registration: { status: "CONFIRMED", dtcmBarcode: "BAR-5" } }));
      expect(await markReversed()).toMatchObject({ ok: false, code: "STILL_IN_USE" });
      expect(det.getDetOrder).not.toHaveBeenCalled();
    });

    it("MED 4: neither reverse nor mark-reversed acts with another DET client's credentials", async () => {
      mockDb.dtcmOrder.findFirst.mockResolvedValue(bought({ detClientId: "OLDSELLER" }));
      expect(await reverse()).toMatchObject({ ok: false, code: "CREDENTIALS_CHANGED" });
      expect(await markReversed()).toMatchObject({ ok: false, code: "CREDENTIALS_CHANGED" });
      expect(det.reverseDetOrder).not.toHaveBeenCalled();
      expect(det.getDetOrder).not.toHaveBeenCalled();
    });

    it("MED 4: an order from before the column (null client id) is not refused", async () => {
      mockDb.dtcmOrder.findFirst.mockResolvedValue((row = bought({ detClientId: null })));
      det.reverseDetOrder.mockResolvedValue("reversed");
      expect(await reverse()).toMatchObject({ ok: true });
    });
  });

  it("MED 4: resolving an order refuses another DET client's credentials", async () => {
    mockDb.dtcmOrder.findFirst.mockResolvedValue({
      id: "do-1",
      eventId: "evt1",
      registrationId: "reg-1",
      environment: "staging",
      status: "UNCERTAIN",
      detClientId: "OLDSELLER",
      area: "SVIP2",
      priceTypeCode: "C",
      updatedAt: new Date(),
    });
    expect(
      await resolveDtcmOrder({ organizationId: "org1", eventId: "evt1", dtcmOrderId: "do-1", userId: "u1", action: { kind: "found", detOrderId: "O9" } }),
    ).toMatchObject({ ok: false, code: "CREDENTIALS_CHANGED" });
    expect(det.getDetOrder).not.toHaveBeenCalled();
  });
});
