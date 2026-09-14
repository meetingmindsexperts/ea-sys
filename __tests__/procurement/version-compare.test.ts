import { describe, it, expect } from "vitest";
import { compareSummary, compareVersions } from "@/procurement/lib/version-compare";

const l = (lineKey: string, planned: string, over: Partial<{ description: string; isContingency: boolean; sortOrder: number; categoryCode: string }> = {}) => ({
  lineKey, planned, categoryCode: "VENUE", description: `Line ${lineKey}`, isContingency: false, sortOrder: 0, ...over,
});

describe("compareVersions (by lineKey, the key a clone preserves)", () => {
  it("pairs by key, reports the planned delta, and orders target lines then removed ones with contingency last", () => {
    const base = [l("a", "1000"), l("b", "500", { sortOrder: 1 }), l("gone", "200", { sortOrder: 2 }), l("cont", "170", { isContingency: true })];
    const target = [l("cont", "180", { isContingency: true }), l("b", "500", { sortOrder: 1, description: "Line b, renamed" }), l("a", "1250"), l("new", "300", { sortOrder: 5 })];
    const rows = compareVersions(base, target);
    expect(rows.map((r) => [r.lineKey, r.change, r.delta])).toEqual([
      ["a", "changed", "250.0000"],
      ["b", "unchanged", "0.0000"],
      ["new", "added", "300.0000"],
      ["cont", "changed", "10.0000"],
      ["gone", "removed", "-200.0000"],
    ]);
    expect(rows.find((r) => r.lineKey === "b")).toMatchObject({ descriptionChanged: true, basePlanned: "500.0000", targetPlanned: "500.0000" });
    expect(rows.find((r) => r.lineKey === "new")).toMatchObject({ basePlanned: null, targetPlanned: "300.0000" });
    expect(rows.find((r) => r.lineKey === "gone")).toMatchObject({ basePlanned: "200.0000", targetPlanned: null });
  });

  it("compares exactly, not on the displayed 2 dp", () => {
    const rows = compareVersions([l("a", "1000.0040")], [l("a", "1000.0010")]);
    expect(rows[0]).toMatchObject({ change: "changed", delta: "-0.0030" });
  });

  it("summarises counts and the net planned movement over non-contingency lines", () => {
    const rows = compareVersions(
      [l("a", "1000"), l("gone", "200"), l("cont", "100", { isContingency: true })],
      [l("a", "1250"), l("new", "300"), l("cont", "155", { isContingency: true })],
    );
    expect(compareSummary(rows)).toEqual({ added: 1, removed: 1, changed: 2, unchanged: 0, netDelta: "350.0000" });
  });
});
