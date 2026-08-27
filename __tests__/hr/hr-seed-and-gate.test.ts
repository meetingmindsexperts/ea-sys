import { describe, it, expect, afterEach } from "vitest";
import { isHrModuleEnabled } from "@/hr/lib/hr-enabled";
import {
  HR_LEAVE_CODE_SEED,
  HR_PUBLIC_HOLIDAYS_2026,
} from "@/hr/lib/hr-seed-data";
import {
  HR_ANNUAL_ENTITLEMENT_DAYS,
  HR_CARRYOVER_CAP_DAYS,
  HR_SICK_TIER_DAYS,
} from "@/hr/lib/hr-constants";

describe("isHrModuleEnabled", () => {
  const original = process.env.HR_MODULE_ENABLED;
  afterEach(() => {
    if (original === undefined) delete process.env.HR_MODULE_ENABLED;
    else process.env.HR_MODULE_ENABLED = original;
  });

  /**
   * The load-bearing case. The HR module is master-silo only, so an unset flag
   * on the platform, a DR box or a fresh dev machine must mean OFF. If this ever
   * defaults to on, every tenant acquires an HR system nobody decided to give
   * them, and nothing would fail loudly to say so.
   */
  it("is OFF when the flag is unset", () => {
    delete process.env.HR_MODULE_ENABLED;
    expect(isHrModuleEnabled()).toBe(false);
  });

  it("is ON only for the exact string 'true'", () => {
    process.env.HR_MODULE_ENABLED = "true";
    expect(isHrModuleEnabled()).toBe(true);
    for (const v of ["", "false", "1", "yes", "TRUE", "on"]) {
      process.env.HR_MODULE_ENABLED = v;
      expect(isHrModuleEnabled()).toBe(false);
    }
  });
});

describe("leave code seed", () => {
  it("has no duplicate codes, case-insensitively", () => {
    const keys = HR_LEAVE_CODE_SEED.map((c) => c.code.toLowerCase());
    expect(new Set(keys).size).toBe(keys.length);
  });

  /**
   * Half days are the only fraction the module admits. A third weight would
   * silently become a rounding question in every balance, so the seed is pinned
   * rather than merely reviewed.
   */
  it("weights every code 1.0 except the two explicit half-day codes", () => {
    const halves = HR_LEAVE_CODE_SEED.filter((c) => c.dayWeight === 0.5).map((c) => c.code);
    expect(halves.sort()).toEqual(["AL-HD", "SL-HD"]);
    for (const c of HR_LEAVE_CODE_SEED) {
      expect([0.5, 1]).toContain(c.dayWeight);
    }
  });

  /**
   * The naming trap, pinned so a future tidy-up cannot collapse the two.
   * "-HD" is half DAY; "SL-H" is half PAY (Art. 31 tier 2). SL-HD therefore
   * counts HALF a day against the FULL-pay tier, and SL-H counts a WHOLE day
   * against the half-pay tier. Getting these the wrong way round is invisible in
   * the totals and wrong in the payslip.
   */
  it("keeps half-day and half-pay sick leave distinct", () => {
    const halfDay = HR_LEAVE_CODE_SEED.find((c) => c.code === "SL-HD");
    const halfPay = HR_LEAVE_CODE_SEED.find((c) => c.code === "SL-H");
    expect(halfDay).toMatchObject({ dayWeight: 0.5, countsAs: "SICK_FULL" });
    expect(halfPay).toMatchObject({ dayWeight: 1, countsAs: "SICK_HALF" });
  });

  it("covers every code the workbook uses in its attendance data", () => {
    // The 12 codes that actually appear in the v5.1 Daily Attendance sheet.
    // An import cannot resolve a code the seed does not carry.
    const used = ["P", "OFF", "PH", "AL", "AL-HD", "SL-F", "SL-HD", "WFH", "OD", "CO", "ABS"];
    const seeded = new Set(HR_LEAVE_CODE_SEED.map((c) => c.code));
    for (const code of used) expect(seeded.has(code)).toBe(true);
  });
});

describe("2026 public holiday seed", () => {
  /**
   * Read from the workbook's own PH rows, not from a published list. The
   * published list in the first draft of the plan had ELEVEN dates and was
   * missing Jan 2 and May 25. Seeding it would have marked two real holidays as
   * ordinary working days, and because an unrecorded day derives to Present,
   * nobody would ever have seen an error. Hence the exact-count pin.
   */
  it("carries the thirteen dates the workbook actually holds", () => {
    expect(HR_PUBLIC_HOLIDAYS_2026).toHaveLength(13);
    expect(HR_PUBLIC_HOLIDAYS_2026.map((h) => h.date)).toContain("2026-01-02");
    expect(HR_PUBLIC_HOLIDAYS_2026.map((h) => h.date)).toContain("2026-05-25");
  });

  it("has unique, well-formed, in-year dates", () => {
    const dates = HR_PUBLIC_HOLIDAYS_2026.map((h) => h.date);
    expect(new Set(dates).size).toBe(dates.length);
    for (const d of dates) {
      expect(d).toMatch(/^2026-\d{2}-\d{2}$/);
      expect(new Date(`${d}T00:00:00Z`).toISOString().slice(0, 10)).toBe(d);
    }
  });

  it("is sorted, so the settings list needs no re-sort to read sensibly", () => {
    const dates = HR_PUBLIC_HOLIDAYS_2026.map((h) => h.date);
    expect([...dates].sort()).toEqual(dates);
  });
});

describe("hr constants", () => {
  it("pins the entitlement, the carryover cap and the Art. 31 tiers", () => {
    expect(HR_ANNUAL_ENTITLEMENT_DAYS).toBe(30);
    expect(HR_CARRYOVER_CAP_DAYS).toBe(30);
    expect(HR_SICK_TIER_DAYS).toEqual({ full: 15, half: 30, unpaid: 45 });
  });
});
