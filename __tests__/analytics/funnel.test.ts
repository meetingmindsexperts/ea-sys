/**
 * Funnel arithmetic.
 *
 * The interesting cases are the degenerate ones: an empty funnel must render as
 * zeros rather than leaking NaN or Infinity into a chart, and a step whose rate
 * exceeds 100% must be reported honestly rather than clamped, because it is
 * telling you people are entering in the middle.
 */
import { describe, it, expect } from "vitest";
import { buildFunnel, worstDropOff } from "@/analytics/core/funnel";

const STEPS = [
  { name: "register_viewed", label: "Viewed", count: 500 },
  { name: "register_step2", label: "Details", count: 200 },
  { name: "register_submitted", label: "Submitted", count: 80 },
];

describe("buildFunnel", () => {
  it("computes conversion against the first step", () => {
    const f = buildFunnel(STEPS);
    expect(f[0].conversionRate).toBe(1);
    expect(f[1].conversionRate).toBeCloseTo(0.4);
    expect(f[2].conversionRate).toBeCloseTo(0.16);
  });

  it("computes step-to-step rate against the previous step", () => {
    const f = buildFunnel(STEPS);
    expect(f[1].stepRate).toBeCloseTo(0.4);
    expect(f[2].stepRate).toBeCloseTo(0.4); // 80 of 200, not 80 of 500
  });

  it("reports how many were lost at each step", () => {
    const f = buildFunnel(STEPS);
    expect(f[0].dropOff).toBe(0); // the first step cannot have lost anyone
    expect(f[1].dropOff).toBe(300);
    expect(f[2].dropOff).toBe(120);
    expect(f[1].dropOffRate).toBeCloseTo(0.6);
  });

  it("returns zeros, not NaN, for an all-zero funnel", () => {
    // A brand new event has no traffic. Dividing by zero here would put NaN
    // straight into a chart and a CSV.
    const f = buildFunnel([
      { name: "a", label: "A", count: 0 },
      { name: "b", label: "B", count: 0 },
    ]);
    for (const s of f) {
      expect(Number.isFinite(s.conversionRate)).toBe(true);
      expect(Number.isFinite(s.stepRate)).toBe(true);
      expect(Number.isFinite(s.dropOffRate)).toBe(true);
      expect(s.conversionRate).toBe(0);
    }
  });

  it("handles an empty funnel", () => {
    expect(buildFunnel([])).toEqual([]);
  });

  it("does NOT clamp a rate above 100%", () => {
    // Steps are counted independently, so someone can arrive directly at step
    // two from an emailed link. Clamping would hide that, and "people are
    // entering mid-funnel" is worth knowing.
    const f = buildFunnel([
      { name: "a", label: "A", count: 10 },
      { name: "b", label: "B", count: 25 },
    ]);
    expect(f[1].conversionRate).toBeCloseTo(2.5);
    expect(f[1].stepRate).toBeCloseTo(2.5);
  });

  it("floors drop-off at zero, since a negative loss is not a number to show", () => {
    const f = buildFunnel([
      { name: "a", label: "A", count: 10 },
      { name: "b", label: "B", count: 25 },
    ]);
    expect(f[1].dropOff).toBe(0);
    expect(f[1].dropOffRate).toBe(0);
  });

  it("treats a negative count as zero rather than propagating it", () => {
    const f = buildFunnel([{ name: "a", label: "A", count: -5 }]);
    expect(f[0].count).toBe(0);
  });

  it("preserves the caller's names and labels", () => {
    const f = buildFunnel(STEPS);
    expect(f.map((s) => s.name)).toEqual(STEPS.map((s) => s.name));
    expect(f.map((s) => s.label)).toEqual(STEPS.map((s) => s.label));
  });
});

describe("worstDropOff", () => {
  it("finds the step that loses the most people", () => {
    expect(worstDropOff(buildFunnel(STEPS))?.name).toBe("register_step2");
  });

  it("never blames the first step, which has no predecessor", () => {
    const f = buildFunnel([{ name: "only", label: "Only", count: 100 }]);
    expect(worstDropOff(f)).toBeNull();
  });

  it("returns null when nobody is lost", () => {
    const f = buildFunnel([
      { name: "a", label: "A", count: 10 },
      { name: "b", label: "B", count: 10 },
    ]);
    expect(worstDropOff(f)).toBeNull();
  });
});
