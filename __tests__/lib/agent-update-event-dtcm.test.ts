/**
 * The agent's create_event / update_event and the DTCM performance code rule
 * (review MED-2, Nov 3, 2026). Both doors call resolveDtcmEventConfig; these
 * pin that the executors pass the right stored values and write what it says.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockDb } = vi.hoisted(() => ({
  mockDb: {
    event: { findFirst: vi.fn(), update: vi.fn(), create: vi.fn() },
    auditLog: { create: vi.fn() },
  },
}));

vi.mock("@/lib/db", () => ({ db: mockDb, dbOperator: mockDb, tenantTransaction: vi.fn() }));
vi.mock("@/lib/tenant-context", () => ({ runWithTenant: (_org: string, fn: () => unknown) => fn() }));
vi.mock("@/lib/logger", () => ({
  apiLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  dbLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { EVENT_EXECUTORS } from "@/lib/agent/tools/events";

const ctx = { eventId: "", organizationId: "org-1", userId: "user-1", source: "mcp" as const, counters: { creates: 0, emailsSent: 0 } };
const update = (input: Record<string, unknown>) => EVENT_EXECUTORS.update_event({ eventId: "evt-1", ...input }, ctx);

function storedEvent(over: Record<string, unknown> = {}) {
  mockDb.event.findFirst.mockResolvedValue({
    id: "evt-1",
    name: "Congress",
    code: "CG26",
    requiresDtcmBarcode: false,
    dtcmPerformanceCode: null,
    ...over,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockDb.event.update.mockResolvedValue({ id: "evt-1" });
  mockDb.auditLog.create.mockReturnValue(Promise.resolve());
});

describe("update_event: DTCM performance code", () => {
  it("refuses turning DTCM on without a code, and writes nothing", async () => {
    storedEvent();
    expect(await update({ requiresDtcmBarcode: true })).toMatchObject({ code: "DTCM_PERFORMANCE_CODE_REQUIRED" });
    expect(mockDb.event.update).not.toHaveBeenCalled();
  });

  it("writes DTCM on with the code normalised", async () => {
    storedEvent();
    await update({ requiresDtcmBarcode: true, dtcmPerformanceCode: " pdub01dec2026a " });
    expect(mockDb.event.update.mock.calls[0][0].data).toMatchObject({
      requiresDtcmBarcode: true,
      dtcmPerformanceCode: "PDUB01DEC2026A",
    });
  });

  it("refuses clearing the code while DTCM is on", async () => {
    storedEvent({ requiresDtcmBarcode: true, dtcmPerformanceCode: "PDUB01DEC2026A" });
    expect(await update({ dtcmPerformanceCode: null })).toMatchObject({ code: "DTCM_PERFORMANCE_CODE_REQUIRED" });
    expect(mockDb.event.update).not.toHaveBeenCalled();
  });

  it("clears the code while DTCM is off", async () => {
    storedEvent({ dtcmPerformanceCode: "PDUB01DEC2026A" });
    await update({ dtcmPerformanceCode: null });
    expect(mockDb.event.update.mock.calls[0][0].data).toMatchObject({ dtcmPerformanceCode: null });
  });

  it("refuses a code that is not text", async () => {
    storedEvent({ dtcmPerformanceCode: "PDUB01DEC2026A" });
    expect(await update({ dtcmPerformanceCode: 123 })).toMatchObject({ code: "INVALID_DTCM_PERFORMANCE_CODE" });
  });

  it("does not touch DTCM on an unrelated edit to the legacy event", async () => {
    storedEvent({ requiresDtcmBarcode: true });
    await update({ venue: "Dubai World Trade Centre" });
    const data = mockDb.event.update.mock.calls[0][0].data;
    expect(data).not.toHaveProperty("requiresDtcmBarcode");
    expect(data).not.toHaveProperty("dtcmPerformanceCode");
  });
});

describe("create_event: DTCM performance code", () => {
  it("refuses DTCM on without a code before creating anything", async () => {
    const out = await EVENT_EXECUTORS.create_event(
      { name: "Dubai Congress", startDate: "2027-03-01T08:00:00Z", endDate: "2027-03-02T17:00:00Z", requiresDtcmBarcode: true },
      ctx,
    );
    expect(out).toMatchObject({ code: "DTCM_PERFORMANCE_CODE_REQUIRED" });
    expect(mockDb.event.create).not.toHaveBeenCalled();
  });
});
