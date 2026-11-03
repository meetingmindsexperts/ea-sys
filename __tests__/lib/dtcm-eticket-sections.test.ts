import { describe, it, expect } from "vitest";
import { mappingProblem, readDtcmEventSettings, sectionHeadroom, sectionOptions } from "@/lib/dtcm-eticket/sections";
import type { DetPerformanceSummary } from "@/lib/dtcm-eticket/types";

/** The UAT performance's shape (Nov 3, 2026), trimmed. */
const perf: DetPerformanceSummary = {
  performanceCode: "PDUB01DEC2023B",
  name: "Batch 3 API upgrade",
  startDate: null,
  endDate: null,
  venueCode: null,
  sections: [
    { code: "SVIP2", name: "VIP2", categoryId: 78, capacity: 160000, holds: 0 },
    { code: "SGOLDA", name: "GOLDA", categoryId: 79, capacity: 14000, holds: 500 },
  ],
  priceTypes: [
    { code: "A", name: "Adult", categoryId: 78, price: 50000 },
    { code: "C", name: "Comps", categoryId: 78, price: 0 },
    { code: "D", name: "Gold", categoryId: 79, price: 35000 },
  ],
};

describe("mappingProblem: what DET would refuse", () => {
  it("accepts a section with a price type of its own category", () => {
    expect(mappingProblem({ area: "SVIP2", priceTypeCode: "C" }, perf)).toBeNull();
  });
  it("refuses a section the performance does not have", () => {
    expect(mappingProblem({ area: "SVIP1", priceTypeCode: "C" }, perf)).toMatch(/SVIP1 is not on performance/);
  });
  it("refuses a price type from another section's category", () => {
    expect(mappingProblem({ area: "SGOLDA", priceTypeCode: "C" }, perf)).toMatch(/not sold in section SGOLDA/);
  });
});

describe("sectionOptions", () => {
  it("offers each section only the price types DET sells in it", () => {
    const opts = sectionOptions(perf);
    expect(opts.find((s) => s.code === "SVIP2")?.priceTypes.map((p) => p.code)).toEqual(["A", "C"]);
    expect(opts.find((s) => s.code === "SGOLDA")?.priceTypes.map((p) => p.code)).toEqual(["D"]);
  });
});

describe("readDtcmEventSettings", () => {
  it("tolerates a missing or malformed block", () => {
    expect(readDtcmEventSettings(null)).toEqual({});
    expect(readDtcmEventSettings({ dtcm: [] })).toEqual({});
  });
  it("drops malformed entries and keeps the rest", () => {
    const read = readDtcmEventSettings({
      dtcm: { environment: "staging", sections: { t1: { area: "SVIP2", priceTypeCode: "C" }, t2: { area: 5 }, t3: null } },
    });
    expect(read.sections).toEqual({ t1: { area: "SVIP2", priceTypeCode: "C" } });
    expect(read.environment).toBe("staging");
  });
});

describe("sectionHeadroom", () => {
  it("is capacity less holds, never negative, unknown without a capacity", () => {
    expect(sectionHeadroom({ capacity: 14000, holds: 500 })).toBe(13500);
    expect(sectionHeadroom({ capacity: 10, holds: 50 })).toBe(0);
    expect(sectionHeadroom({ capacity: null, holds: 0 })).toBeNull();
  });
});
