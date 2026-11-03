/**
 * Bulk DET runs (docs/DTCM_ETICKET_PLAN.md §5.3, step 4): who a run buys for,
 * what it refuses to start, and when it stops. The purchase itself
 * (buyForRegistration) is mocked; its rules are pinned in
 * dtcm-eticket-service.test.ts.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { Prisma } from "@prisma/client";

const { mockDb, svc, logger } = vi.hoisted(() => ({
  mockDb: {
    registration: { findMany: vi.fn() },
    dtcmOrder: { findMany: vi.fn(), groupBy: vi.fn() },
    dtcmIssueRun: { create: vi.fn(), findUnique: vi.fn(), update: vi.fn(), updateMany: vi.fn() },
    auditLog: { create: vi.fn() },
  },
  svc: { loadDtcmPurchaseContext: vi.fn(), buyForRegistration: vi.fn() },
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock("@/lib/db", () => ({ db: mockDb }));
vi.mock("@/lib/logger", () => ({ apiLogger: logger }));
vi.mock("@/services/dtcm-eticket-service", () => svc);

import { dtcmRunPreflight, startDtcmRun, tickDtcmRun } from "@/services/dtcm-issue-run-service";

const event = {
  requiresDtcmBarcode: true,
  dtcmPerformanceCode: "P1",
  settings: {
    dtcm: {
      sections: { "tt-a": { area: "SVIP2", priceTypeCode: "C" }, "tt-b": { area: "SGOLDA", priceTypeCode: "D" } },
      environment: "staging",
      performanceCode: "P1",
      checkedAt: "x",
    },
  },
};
const ctx = (environment = "staging", code = "P1") => ({
  organizationId: "org1",
  eventId: "evt1",
  creds: { environment },
  performance: {
    sections: [
      { code: "SVIP2", name: "VIP2", categoryId: 78, capacity: 2, holds: 0 },
      { code: "SGOLDA", name: "GOLDA", categoryId: 79, capacity: 100, holds: 0 },
    ],
    priceTypes: [],
  },
  event: { ...event, dtcmPerformanceCode: code },
  userId: "u1",
  source: "worker",
  runId: null,
});

const attendee = { title: null, firstName: "A", lastName: "B", email: "a@x", phone: "+97150000000", country: "UAE" };
const reg = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  status: "CONFIRMED",
  attendanceMode: "IN_PERSON",
  dtcmBarcode: null,
  ticketTypeId: "tt-a",
  createdAt: new Date(),
  attendee,
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  // clearAllMocks keeps queued mockResolvedValueOnce answers; a leftover one
  // would leak into the next test.
  mockDb.registration.findMany.mockReset();
  svc.buyForRegistration.mockReset();
  svc.loadDtcmPurchaseContext.mockResolvedValue({ ok: true, context: ctx() });
  mockDb.dtcmOrder.findMany.mockResolvedValue([]);
  mockDb.dtcmOrder.groupBy.mockResolvedValue([]);
  mockDb.auditLog.create.mockResolvedValue({});
  mockDb.dtcmIssueRun.update.mockResolvedValue({});
  mockDb.dtcmIssueRun.updateMany.mockResolvedValue({ count: 1 });
});

describe("preflight", () => {
  it("sorts registrations into to-buy, not-needed and problems, and totals per section", async () => {
    mockDb.registration.findMany.mockResolvedValue([
      reg("r1"),
      reg("r2", { ticketTypeId: "tt-b" }),
      reg("r3", { dtcmBarcode: "X" }),
      reg("r4", { status: "CANCELLED" }),
      reg("r5", { attendee: { ...attendee, phone: null } }),
      reg("r6", { ticketTypeId: "tt-none" }),
      reg("r7"),
    ]);
    mockDb.dtcmOrder.findMany.mockResolvedValue([{ registrationId: "r7" }]);
    const out = await dtcmRunPreflight("org1", "evt1", "u1");
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.preflight.eligibleIds).toEqual(["r1", "r2"]);
    expect(out.preflight.notNeeded).toBe(2);
    expect(out.preflight.problems).toEqual({ MISSING_PHONE: 1, TYPE_NOT_MAPPED: 1, AWAITING_RESOLUTION: 1 });
    expect(out.preflight.sections).toEqual([
      { area: "SVIP2", name: "VIP2", needed: 1, headroom: 2, over: false },
      { area: "SGOLDA", name: "GOLDA", needed: 1, headroom: 100, over: false },
    ]);
  });

  it("refuses outright on a stale mapping", async () => {
    svc.loadDtcmPurchaseContext.mockResolvedValue({ ok: true, context: ctx("production") });
    mockDb.registration.findMany.mockResolvedValue([reg("r1")]);
    expect(await dtcmRunPreflight("org1", "evt1", "u1")).toMatchObject({ ok: false, code: "MAPPING_STALE" });
  });
});

describe("start", () => {
  const start = (confirm: { environment: "staging" | "production"; count: number }) =>
    startDtcmRun({ organizationId: "org1", eventId: "evt1", userId: "u1", confirm });

  it("refuses when the confirmed count or environment no longer matches", async () => {
    mockDb.registration.findMany.mockResolvedValue([reg("r1"), reg("r2", { ticketTypeId: "tt-b" })]);
    expect(await start({ environment: "staging", count: 1 })).toMatchObject({ ok: false, code: "CONFIRMATION_STALE" });
    expect(await start({ environment: "production", count: 2 })).toMatchObject({ ok: false, code: "CONFIRMATION_STALE" });
    expect(mockDb.dtcmIssueRun.create).not.toHaveBeenCalled();
  });

  it("refuses a run a section cannot hold", async () => {
    mockDb.registration.findMany.mockResolvedValue([reg("r1"), reg("r2"), reg("r3")]); // SVIP2 holds 2
    expect(await start({ environment: "staging", count: 3 })).toMatchObject({ ok: false, code: "OVER_CAPACITY" });
  });

  it("refuses when nobody needs a code", async () => {
    mockDb.registration.findMany.mockResolvedValue([reg("r1", { dtcmBarcode: "X" })]);
    expect(await start({ environment: "staging", count: 1 })).toMatchObject({ ok: false, code: "NOTHING_TO_BUY" });
  });

  it("starts one live run per event, the second stopping at the insert", async () => {
    mockDb.registration.findMany.mockResolvedValue([reg("r1")]);
    mockDb.dtcmIssueRun.create.mockResolvedValueOnce({ id: "run1", expected: 1, environment: "staging", performanceCode: "P1" });
    expect(await start({ environment: "staging", count: 1 })).toMatchObject({ ok: true });
    expect(mockDb.dtcmIssueRun.create.mock.calls[0][0].data).toMatchObject({ activeKey: "evt1", expected: 1, environment: "staging", status: "RUNNING" });
    mockDb.dtcmIssueRun.create.mockRejectedValueOnce(new Prisma.PrismaClientKnownRequestError("dup", { code: "P2002", clientVersion: "x" }));
    expect(await start({ environment: "staging", count: 1 })).toMatchObject({ ok: false, code: "RUN_ACTIVE" });
  });
});

describe("tick", () => {
  const running = (over: Record<string, unknown> = {}) => ({
    id: "run1",
    eventId: "evt1",
    organizationId: "org1",
    status: "RUNNING",
    environment: "staging",
    performanceCode: "P1",
    soldOutAreas: [] as string[],
    createdById: "u1",
    ...over,
  });
  const stopWrite = () =>
    mockDb.dtcmIssueRun.updateMany.mock.calls.map(([a]) => a.data).find((d) => d.status === "STOPPED" || d.status === "COMPLETED");

  beforeEach(() => {
    mockDb.dtcmIssueRun.findUnique.mockImplementation(async ({ select }) => (select ? { status: "RUNNING" } : running()));
  });

  it("buys for each candidate, then completes when nobody is left", async () => {
    mockDb.registration.findMany.mockResolvedValueOnce([reg("r1"), reg("r2")]);
    svc.buyForRegistration.mockResolvedValue({ ok: true });
    await tickDtcmRun("run1", 10_000, 0);
    expect(svc.buyForRegistration).toHaveBeenCalledTimes(2);
    expect(stopWrite()).toMatchObject({ status: "COMPLETED", activeKey: null });
  });

  it("completes even when people who can never be bought for remain, and only reads mapped types", async () => {
    // The bug found in the sandbox run: an unmapped Faculty or a missing phone
    // kept the run RUNNING forever, and with a page size could hide eligible
    // people behind them.
    mockDb.registration.findMany.mockResolvedValueOnce([reg("r1", { attendee: { ...attendee, phone: null } }), reg("r2")]);
    svc.buyForRegistration.mockResolvedValue({ ok: true });
    await tickDtcmRun("run1", 10_000, 0);
    expect(svc.buyForRegistration.mock.calls.map(([, r]) => r.id)).toEqual(["r2"]);
    expect(stopWrite()).toMatchObject({ status: "COMPLETED" });
    const where = mockDb.registration.findMany.mock.calls[0][0].where;
    expect(where.ticketTypeId).toEqual({ in: ["tt-a", "tt-b"] });
    expect(mockDb.registration.findMany.mock.calls[0][0]).not.toHaveProperty("take");
  });

  it("does not complete a run whose budget ran out mid-pass", async () => {
    mockDb.registration.findMany.mockResolvedValueOnce([reg("r1"), reg("r2")]);
    svc.buyForRegistration.mockImplementation(async () => {
      await new Promise((r) => setTimeout(r, 30));
      return { ok: true };
    });
    await tickDtcmRun("run1", 10, 0);
    expect(stopWrite()).toBeUndefined();
  });

  it("stops the whole run on an UNCERTAIN purchase, before the next person", async () => {
    mockDb.registration.findMany.mockResolvedValueOnce([reg("r1"), reg("r2")]);
    svc.buyForRegistration.mockResolvedValueOnce({ ok: false, code: "UNCERTAIN", message: "lost" });
    await tickDtcmRun("run1", 10_000, 0);
    expect(svc.buyForRegistration).toHaveBeenCalledTimes(1);
    expect(stopWrite()).toMatchObject({ status: "STOPPED", activeKey: null });
  });

  it("skips a section DET calls sold out and carries on with the others", async () => {
    mockDb.registration.findMany.mockResolvedValueOnce([reg("r1"), reg("r2"), reg("r3", { ticketTypeId: "tt-b" })]);
    svc.buyForRegistration
      .mockResolvedValueOnce({ ok: false, code: "DET_REFUSED", message: "x", order: { errorMessage: "DET createBasket failed (HTTP 400, code 5005): Section soldout" } })
      .mockResolvedValueOnce({ ok: true });
    await tickDtcmRun("run1", 10_000, 0);
    expect(svc.buyForRegistration.mock.calls.map(([, r]) => r.id)).toEqual(["r1", "r3"]);
    expect(mockDb.dtcmIssueRun.update).toHaveBeenCalledWith({ where: { id: "run1" }, data: { soldOutAreas: ["SVIP2"] } });
  });

  it("stops after five refusals in a row that are not 'sold out'", async () => {
    mockDb.registration.findMany.mockResolvedValueOnce(["r1", "r2", "r3", "r4", "r5", "r6"].map((id) => reg(id, { ticketTypeId: "tt-b" })));
    svc.buyForRegistration.mockResolvedValue({ ok: false, code: "DET_REFUSED", message: "500", order: { errorMessage: "HTTP 500" } });
    await tickDtcmRun("run1", 10_000, 0);
    expect(svc.buyForRegistration).toHaveBeenCalledTimes(5);
    expect(stopWrite()).toMatchObject({ status: "STOPPED" });
  });

  it("stops rather than buy in an environment the run was not confirmed for", async () => {
    svc.loadDtcmPurchaseContext.mockResolvedValue({ ok: true, context: ctx("production") });
    await tickDtcmRun("run1", 10_000, 0);
    expect(svc.buyForRegistration).not.toHaveBeenCalled();
    expect(stopWrite()).toMatchObject({ status: "STOPPED" });
  });

  it("honours a cancel at the next person", async () => {
    mockDb.registration.findMany.mockResolvedValueOnce([reg("r1"), reg("r2")]);
    let calls = 0;
    mockDb.dtcmIssueRun.findUnique.mockImplementation(async ({ select }) => {
      if (!select) return running();
      return { status: calls++ === 0 ? "RUNNING" : "CANCELLED" };
    });
    svc.buyForRegistration.mockResolvedValue({ ok: true });
    await tickDtcmRun("run1", 10_000, 0);
    expect(svc.buyForRegistration).toHaveBeenCalledTimes(1);
  });

  it("does nothing for a run that is no longer RUNNING", async () => {
    mockDb.dtcmIssueRun.findUnique.mockResolvedValue(running({ status: "CANCELLED" }));
    await tickDtcmRun("run1", 10_000, 0);
    expect(svc.loadDtcmPurchaseContext).not.toHaveBeenCalled();
  });
});
