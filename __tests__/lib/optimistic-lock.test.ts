/**
 * Unit tests for the shared optimistic-lock helper.
 *
 * The helper centralises the W2-F8 fix: when callers pass an
 * `expectedUpdatedAt` token, writes go through a conditional
 * `updateMany` that rejects stale writes with a STALE_WRITE outcome
 * the route translates to HTTP 409.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockApiLogger } = vi.hoisted(() => ({
  mockApiLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock("@/lib/logger", () => ({ apiLogger: mockApiLogger }));

import { runOptimisticUpdate } from "@/lib/optimistic-lock";

function makeModel() {
  return {
    updateMany: vi.fn(),
    findFirst: vi.fn(),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("runOptimisticUpdate — with expectedUpdatedAt", () => {
  it("returns ok:true when the conditional write hits exactly one row", async () => {
    const model = makeModel();
    model.updateMany.mockResolvedValueOnce({ count: 1 });

    const result = await runOptimisticUpdate({
      model,
      where: { id: "spk-1", eventId: "evt-1" },
      data: { firstName: "Alice", updatedAt: new Date() },
      expectedUpdatedAt: "2026-04-27T10:00:00.000Z",
      resourceLabel: "speaker",
      resourceId: "spk-1",
    });

    expect(result).toEqual({ ok: true });
    expect(model.updateMany).toHaveBeenCalledTimes(1);
    expect(model.updateMany.mock.calls[0][0].where.updatedAt).toEqual(
      new Date("2026-04-27T10:00:00.000Z")
    );
    expect(model.findFirst).not.toHaveBeenCalled();
    expect(mockApiLogger.warn).not.toHaveBeenCalled();
  });

  it("returns STALE_WRITE when row exists but updatedAt no longer matches", async () => {
    const model = makeModel();
    model.updateMany.mockResolvedValueOnce({ count: 0 });
    model.findFirst.mockResolvedValueOnce({ id: "spk-1" }); // row still exists

    const result = await runOptimisticUpdate({
      model,
      where: { id: "spk-1", eventId: "evt-1" },
      data: { firstName: "Alice", updatedAt: new Date() },
      expectedUpdatedAt: "2026-04-27T10:00:00.000Z",
      resourceLabel: "speaker",
      resourceId: "spk-1",
    });

    expect(result).toEqual({ ok: false, reason: "STALE_WRITE" });
    expect(model.findFirst).toHaveBeenCalledWith({
      where: { id: "spk-1", eventId: "evt-1" },
      select: { id: true },
    });
  });

  it("returns NOT_FOUND when the row no longer exists at all", async () => {
    const model = makeModel();
    model.updateMany.mockResolvedValueOnce({ count: 0 });
    model.findFirst.mockResolvedValueOnce(null);

    const result = await runOptimisticUpdate({
      model,
      where: { id: "spk-gone", eventId: "evt-1" },
      data: { firstName: "Alice", updatedAt: new Date() },
      expectedUpdatedAt: "2026-04-27T10:00:00.000Z",
      resourceLabel: "speaker",
      resourceId: "spk-gone",
    });

    expect(result).toEqual({ ok: false, reason: "NOT_FOUND" });
  });
});

describe("runOptimisticUpdate — without expectedUpdatedAt", () => {
  it("falls back to legacy unconditional write and emits a warn log", async () => {
    const model = makeModel();
    model.updateMany.mockResolvedValueOnce({ count: 1 });

    const result = await runOptimisticUpdate({
      model,
      where: { id: "spk-1", eventId: "evt-1" },
      data: { firstName: "Alice", updatedAt: new Date() },
      expectedUpdatedAt: null,
      resourceLabel: "speaker",
      resourceId: "spk-1",
    });

    expect(result).toEqual({ ok: true });
    // Where clause should NOT have updatedAt — legacy behavior.
    expect(model.updateMany.mock.calls[0][0].where.updatedAt).toBeUndefined();
    expect(mockApiLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        msg: "optimistic-lock:missing-expectedUpdatedAt",
        resource: "speaker",
        resourceId: "spk-1",
      })
    );
  });

  it("treats undefined the same as null — fall back path", async () => {
    const model = makeModel();
    model.updateMany.mockResolvedValueOnce({ count: 1 });

    await runOptimisticUpdate({
      model,
      where: { id: "spk-1" },
      data: { firstName: "Alice" },
      expectedUpdatedAt: undefined,
      resourceLabel: "speaker",
      resourceId: "spk-1",
    });

    expect(mockApiLogger.warn).toHaveBeenCalled();
  });

  it("returns NOT_FOUND when the legacy write affects zero rows (e.g. id wrong)", async () => {
    const model = makeModel();
    model.updateMany.mockResolvedValueOnce({ count: 0 });

    const result = await runOptimisticUpdate({
      model,
      where: { id: "spk-gone" },
      data: { firstName: "Alice" },
      expectedUpdatedAt: null,
      resourceLabel: "speaker",
      resourceId: "spk-gone",
    });

    expect(result).toEqual({ ok: false, reason: "NOT_FOUND" });
    // Legacy path doesn't fall through to a separate findFirst — just
    // reports NOT_FOUND from the count.
    expect(model.findFirst).not.toHaveBeenCalled();
  });
});
