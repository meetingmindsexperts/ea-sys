import { describe, it, expect } from "vitest";
import { isPeggedToAed, keysStillNeedingNote, varianceRows } from "@/procurement/lib/close-out";

const line = (lineKey: string, planned: string, actual: string, over: Partial<{ isContingency: boolean; varianceNote: string | null }> = {}) => ({
  lineKey, planned, actual, isContingency: false, varianceNote: null, ...over,
});

describe("varianceRows (the close-out's rule, spec §14 Q13)", () => {
  it("flags a line past 10% or the AED-5,000 floor in the reporting currency, whichever is larger, never contingency", () => {
    const r = varianceRows(
      [
        line("small", "1000", "1200"), // 20% but only 200 over: under the 5,000 floor
        line("big", "100000", "112000"), // 12% and 12,000 over: past both
        line("floor", "10000", "16000"), // 6,000 over on a 10,000 line: past the floor
        line("cont", "1000", "50000", { isContingency: true }),
        line("noted", "100000", "150000", { varianceNote: "Venue upgrade" }),
      ],
      "AED",
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.floorInReporting).toBe("5000.0000");
    expect(r.rate.source).toBe("peg");
    expect(r.rows.map((x) => [x.lineKey, x.needsNote, x.hasNote, x.variancePercent])).toEqual([
      ["small", false, false, 20],
      ["big", true, false, 12],
      ["floor", true, false, 60],
      ["cont", false, false, 4900],
      ["noted", true, true, 50],
    ]);
    expect(keysStillNeedingNote(r.rows, {})).toEqual(["big", "floor"]);
    expect(keysStillNeedingNote(r.rows, { big: "  Extra AV  " })).toEqual(["floor"]);
    expect(keysStillNeedingNote(r.rows, { floor: "   " })).toEqual(["big", "floor"]);
  });

  it("converts the floor at the peg for USD and reports a zero-planned line's percent as null", () => {
    const r = varianceRows([line("a", "0", "100")], "USD");
    expect(r.ok && r.floorInReporting).toBe("1361.4704");
    expect(r.ok && r.rows[0].variancePercent).toBeNull();
  });

  it("needs a caller's rate for a floating currency and refuses one outside the band", () => {
    expect(varianceRows([], "EUR")).toMatchObject({ ok: false, rate: { reason: "missing" } });
    expect(varianceRows([], "EUR", "0.5")).toMatchObject({ ok: false, rate: { reason: "out-of-band" } });
    const r = varianceRows([line("a", "1000", "1000")], "EUR", "4");
    expect(r.ok && r.floorInReporting).toBe("1250.0000");
    expect(r.ok && r.rate.source).toBe("caller");
  });

  it("knows which currencies are pegged", () => {
    expect(["AED", "USD", "SAR"].map(isPeggedToAed)).toEqual([true, true, true]);
    expect(["EUR", "GBP"].map(isPeggedToAed)).toEqual([false, false]);
  });
});
