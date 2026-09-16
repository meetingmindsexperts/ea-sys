/**
 * Document numbers: the format the owner chose, the Dubai-year boundary (a
 * request raised at 23:30 on 31 December in Dubai belongs to that year even
 * though UTC has not turned), and the upsert shape that makes the sequence
 * safe under concurrency (the real-Postgres case lives in tests/integration-db).
 */
import { describe, it, expect, vi } from "vitest";
import { documentYear, formatDocumentNumber, nextDocumentNumber } from "@/procurement/lib/document-numbers";

describe("formatDocumentNumber", () => {
  it("pads to four digits and grows past them", () => {
    expect(formatDocumentNumber("PR", 2026, 1)).toBe("PR-2026-0001");
    expect(formatDocumentNumber("PO", 2026, 42)).toBe("PO-2026-0042");
    expect(formatDocumentNumber("PO", 2027, 12345)).toBe("PO-2027-12345");
  });
  it("refuses a serial below 1", () => {
    expect(() => formatDocumentNumber("PR", 2026, 0)).toThrow(RangeError);
  });
});

describe("documentYear", () => {
  it("is the Dubai calendar year, not the UTC one", () => {
    expect(documentYear(new Date("2026-12-31T19:59:00.000Z"))).toBe(2026);
    expect(documentYear(new Date("2026-12-31T20:00:00.000Z"))).toBe(2027);
    expect(documentYear(new Date("2026-06-14T09:00:00.000Z"))).toBe(2026);
  });
});

describe("nextDocumentNumber", () => {
  it("upserts the (org, year) row with an atomic increment and formats the result", async () => {
    const tx = {
      spendRequestCounter: { upsert: vi.fn().mockResolvedValue({ organizationId: "org-1", year: 2026, lastSerial: 7 }) },
      commitmentCounter: { upsert: vi.fn().mockResolvedValue({ organizationId: "org-1", year: 2026, lastSerial: 1 }) },
    };
    const at = new Date("2026-03-01T08:00:00.000Z");
    expect(await nextDocumentNumber(tx as never, "PR", "org-1", at)).toBe("PR-2026-0007");
    expect(tx.spendRequestCounter.upsert).toHaveBeenCalledWith({
      where: { organizationId_year: { organizationId: "org-1", year: 2026 } },
      create: { organizationId: "org-1", year: 2026, lastSerial: 1 },
      update: { lastSerial: { increment: 1 } },
    });
    expect(await nextDocumentNumber(tx as never, "PO", "org-1", at)).toBe("PO-2026-0001");
    expect(tx.commitmentCounter.upsert).toHaveBeenCalledTimes(1);
  });
});
