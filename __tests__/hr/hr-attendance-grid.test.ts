import { describe, expect, it } from "vitest";
import {
  ARROW_STEP,
  GRID_SHORTCUT_CODES,
  HALF_DAY,
  PRIMARY,
  collapseToHead,
  moveSelection,
  resolveKeyCode,
  seedHasCode,
  type Selection,
} from "@/hr/lib/attendance-grid";
import { HR_LEAVE_CODE_SEED } from "@/hr/lib/hr-seed-data";

/**
 * The grid's keyboard model. Two of these guards exist because the failure is
 * invisible: a wrong half-day mapping books a pay cut that looks identical on
 * screen, and a code the seed no longer defines renders a button that silently
 * does nothing.
 */
describe("half-day shortcuts", () => {
  /**
   * THE load-bearing case. SL-HD is half a DAY at full pay; SL-H is a FULL day
   * at half pay (Art. 31 tier 2). They differ by one character. If this ever
   * resolves to SL-H, someone recording a colleague's half-day off has cut
   * their pay for the day and nothing on the grid says so.
   */
  it("Shift+S writes half a day, never the half-pay tier", () => {
    expect(resolveKeyCode("s", true)).toBe("SL-HD");
    expect(resolveKeyCode("S", true)).toBe("SL-HD");
    expect(resolveKeyCode("s", true)).not.toBe("SL-H");
    expect(resolveKeyCode("s", true)).not.toBe("SL-F");
  });

  it("Shift+A writes half a day of annual, not a whole one", () => {
    expect(resolveKeyCode("a", true)).toBe("AL-HD");
    expect(resolveKeyCode("a", true)).not.toBe("AL");
  });

  it("leaves the unshifted shortcuts exactly as they were", () => {
    expect(resolveKeyCode("a", false)).toBe("AL");
    expect(resolveKeyCode("s", false)).toBe("SL-F");
    expect(resolveKeyCode("w", false)).toBe("WFH");
    expect(resolveKeyCode("o", false)).toBe("OD");
    expect(resolveKeyCode("c", false)).toBe("CO");
  });

  it("ignores a key with no meaning, shifted or not", () => {
    expect(resolveKeyCode("z", false)).toBeNull();
    expect(resolveKeyCode("z", true)).toBeNull();
    // Shift on a code that has no half-day variant must do nothing rather than
    // fall back to the full day: a silent full day is the surprise.
    expect(resolveKeyCode("w", true)).toBeNull();
    expect(resolveKeyCode("o", true)).toBeNull();
    expect(resolveKeyCode("c", true)).toBeNull();
  });

  it("offers only codes the seed actually defines", () => {
    for (const code of GRID_SHORTCUT_CODES) {
      expect(seedHasCode(code), `${code} is offered by the grid but absent from the seed`).toBe(true);
    }
  });

  it("only calls a code a half day when the seed weighs it as one", () => {
    for (const h of HALF_DAY) {
      const seeded = HR_LEAVE_CODE_SEED.find((c) => c.code === h.code);
      expect(seeded?.dayWeight, `${h.code} is labelled a half day`).toBe(0.5);
    }
    // ...and the full-day shortcuts must not have drifted to a fraction.
    for (const p of PRIMARY) {
      expect(HR_LEAVE_CODE_SEED.find((c) => c.code === p.code)?.dayWeight).toBe(1);
    }
  });
});

describe("keyboard navigation", () => {
  const at = (r: number, d: number): Selection => ({ r0: r, d0: d, r1: r, d1: d });

  it("moves and collapses without Shift", () => {
    expect(moveSelection({ r0: 0, d0: 0, r1: 2, d1: 5 }, ARROW_STEP.ArrowRight, false, 10, 31))
      .toEqual({ r0: 2, d0: 6, r1: 2, d1: 6 });
    expect(moveSelection(at(3, 4), ARROW_STEP.ArrowUp, false, 10, 31)).toEqual(at(2, 4));
  });

  it("extends from the anchor with Shift, leaving it put", () => {
    const s = moveSelection(at(2, 5), ARROW_STEP.ArrowRight, true, 10, 31);
    expect(s).toEqual({ r0: 2, d0: 5, r1: 2, d1: 6 });
    const s2 = moveSelection(s, ARROW_STEP.ArrowDown, true, 10, 31);
    expect(s2).toEqual({ r0: 2, d0: 5, r1: 3, d1: 6 });
  });

  /** Wrapping from the 31st to the 1st, or the last person to the first, would
   *  read as a bug in a grid you are dragging a range across. */
  it("stops at every edge rather than wrapping", () => {
    expect(moveSelection(at(0, 0), ARROW_STEP.ArrowUp, false, 10, 31)).toEqual(at(0, 0));
    expect(moveSelection(at(0, 0), ARROW_STEP.ArrowLeft, false, 10, 31)).toEqual(at(0, 0));
    expect(moveSelection(at(9, 30), ARROW_STEP.ArrowDown, false, 10, 31)).toEqual(at(9, 30));
    expect(moveSelection(at(9, 30), ARROW_STEP.ArrowRight, false, 10, 31)).toEqual(at(9, 30));
  });

  it("survives a grid with a single cell", () => {
    expect(moveSelection(at(0, 0), ARROW_STEP.ArrowRight, false, 1, 1)).toEqual(at(0, 0));
  });

  it("leaves the cursor on the head after a write, not nowhere", () => {
    expect(collapseToHead({ r0: 1, d0: 2, r1: 4, d1: 9 })).toEqual(at(4, 9));
  });
});
