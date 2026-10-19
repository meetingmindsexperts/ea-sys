/**
 * ensureEntryBarcode (Oct 19, 2026): an in-person registration that reached a
 * speaker link, a speaker import or its completion without an entry barcode
 * gets one; nothing else changes.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { updateMany } = vi.hoisted(() => ({ updateMany: vi.fn() }));
vi.mock("@/lib/db", () => ({ db: { registration: { updateMany } } }));
vi.mock("@/lib/logger", () => ({ apiLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

import { ensureEntryBarcode } from "@/lib/entry-barcode-mint";

beforeEach(() => {
  updateMany.mockReset();
  updateMany.mockResolvedValue({ count: 1 });
});

describe("ensureEntryBarcode", () => {
  it("mints one for an in-person registration without one, guarded on qrCode: null", async () => {
    const code = await ensureEntryBarcode({ id: "r1", qrCode: null, attendanceMode: "IN_PERSON" }, "test");
    expect(code).toMatch(/^\d{13,}$/);
    expect(updateMany).toHaveBeenCalledWith({ where: { id: "r1", qrCode: null }, data: { qrCode: code } });
  });

  it("never replaces a barcode and gives a virtual attendee none", async () => {
    expect(await ensureEntryBarcode({ id: "r1", qrCode: "QR1", attendanceMode: "IN_PERSON" }, "test")).toBeNull();
    expect(await ensureEntryBarcode({ id: "r2", qrCode: null, attendanceMode: "VIRTUAL" }, "test")).toBeNull();
    expect(updateMany).not.toHaveBeenCalled();
  });

  it("returns null when another caller set one meanwhile", async () => {
    updateMany.mockResolvedValue({ count: 0 });
    expect(await ensureEntryBarcode({ id: "r1", qrCode: null, attendanceMode: "IN_PERSON" }, "test")).toBeNull();
  });

  it("writes through the transaction it is given", async () => {
    const txUpdateMany = vi.fn().mockResolvedValue({ count: 1 });
    await ensureEntryBarcode({ id: "r1", qrCode: null, attendanceMode: "IN_PERSON" }, "test", { registration: { updateMany: txUpdateMany } } as never);
    expect(txUpdateMany).toHaveBeenCalled();
    expect(updateMany).not.toHaveBeenCalled();
  });
});
