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
    registration: { findFirst: vi.fn(), updateMany: vi.fn() },
    dtcmOrder: { create: vi.fn(), update: vi.fn(), findUnique: vi.fn(), findUniqueOrThrow: vi.fn(), findFirst: vi.fn() },
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

import { issueDtcmTicket, resolveDtcmOrder, STALE_PENDING_MS } from "@/services/dtcm-eticket-service";
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
  mockDb.dtcmOrder.findUniqueOrThrow.mockImplementation(async () => row);
  mockDb.$transaction.mockImplementation(async (ops: Promise<unknown>[]) => Promise.all(ops));
});

const statusWrites = () => mockDb.dtcmOrder.update.mock.calls.map(([a]) => a.data);

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
    expect(statusWrites().at(-1)).toMatchObject({ status: "FAILED", activeKey: null, errorStage: "createBasket" });
    expect(det.deleteDetBasket).not.toHaveBeenCalled();
  });

  it("customer refused: the basket's seat is released", async () => {
    det.createDetCustomer.mockRejectedValue(refused("createCustomer"));
    await issueDtcmTicket(input);
    expect(det.deleteDetBasket).toHaveBeenCalledWith(expect.anything(), "B1");
    expect(statusWrites().at(-1)).toMatchObject({ status: "FAILED", activeKey: null });
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
    expect(statusWrites().at(-1)).toMatchObject({ status: "FAILED", activeKey: null });
  });

  it("basket gone: UNCERTAIN, activeKey KEPT, basket untouched, nothing on the registration", async () => {
    det.purchaseDetBasket.mockRejectedValue(unknownOutcome());
    det.detBasketExists.mockResolvedValue(false);
    expect(await issueDtcmTicket(input)).toMatchObject({ ok: false, code: "UNCERTAIN" });
    const last = statusWrites().at(-1);
    expect(last).toMatchObject({ status: "UNCERTAIN" });
    expect(last).not.toHaveProperty("activeKey");
    expect(det.deleteDetBasket).not.toHaveBeenCalled();
    expect(mockDb.registration.updateMany).not.toHaveBeenCalled();
    expect(mockDb.auditLog.create.mock.calls[0][0].data.action).toBe("DTCM_ORDER_UNCERTAIN");
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

  it("logs the DET order number BEFORE writing it, so a crash cannot lose it", async () => {
    await issueDtcmTicket(input);
    const logged = logger.info.mock.calls.findIndex(([o]) => o?.msg === "dtcm-eticket:issue-purchased");
    const loggedAt = logger.info.mock.invocationCallOrder[logged];
    const writeAt = mockDb.dtcmOrder.update.mock.invocationCallOrder[statusWrites().findIndex((d) => d.orderId === "O1")];
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
    mockDb.dtcmOrder.findFirst.mockResolvedValue(row);
    mockGetCreds.mockResolvedValue(creds("production"));
    det.getDetOrder.mockResolvedValue({ orderId: "777", barcode: "BAR-7" });
    const out = await resolveDtcmOrder(resolveInput({ kind: "found", detOrderId: "777" }));
    expect(out).toMatchObject({ ok: true, barcode: "BAR-7" });
    expect(mockGetCreds).toHaveBeenCalledWith("org1", "production");
    expect(mockDb.registration.updateMany).toHaveBeenCalledWith({ where: { id: "reg-1", dtcmBarcode: null }, data: { dtcmBarcode: "BAR-7" } });
  });

  it("refuses an order number DET does not know", async () => {
    mockDb.dtcmOrder.findFirst.mockResolvedValue(uncertain());
    det.getDetOrder.mockResolvedValue(null);
    expect(await resolveDtcmOrder(resolveInput({ kind: "found", detOrderId: "1" }))).toMatchObject({ ok: false, code: "DET_ORDER_NOT_FOUND" });
    expect(mockDb.registration.updateMany).not.toHaveBeenCalled();
  });

  it("'not bought' ends the attempt so a new one may start", async () => {
    row = uncertain();
    mockDb.dtcmOrder.findFirst.mockResolvedValue(row);
    expect(await resolveDtcmOrder(resolveInput({ kind: "not-bought" }))).toMatchObject({ ok: true });
    expect(statusWrites().at(-1)).toMatchObject({ status: "FAILED", activeKey: null });
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
