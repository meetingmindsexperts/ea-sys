import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  ARROW_STEP,
  GRID_SHORTCUT_CODES,
  HALF_DAY,
  PRIMARY,
  collapseToHead,
  employedInMonth,
  moveSelection,
  placePopover,
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

describe("who has a row for a month (review M1)", () => {
  const march = ["2026-03-01", "2026-03-31"] as const;

  it("a leaver keeps their rows for the months they were employed in", () => {
    const leaver = { joiningDate: "2020-01-01", exitDate: "2026-03-15" };
    expect(employedInMonth(leaver, ...march)).toBe(true);
    expect(employedInMonth(leaver, "2026-04-01", "2026-04-30")).toBe(false);
  });

  it("somebody who has not joined yet has no row", () => {
    expect(employedInMonth({ joiningDate: "2026-04-01", exitDate: null }, ...march)).toBe(false);
    expect(employedInMonth({ joiningDate: "2026-03-31", exitDate: null }, ...march)).toBe(true);
  });

  it("is decided by the dates, never by status", () => {
    // A resigned-with-future-date person is serving notice and still needs
    // their leave recorded; status is not consulted at all.
    expect(employedInMonth({ joiningDate: "2019-06-01", exitDate: "2026-09-30", status: "RESIGNED" } as never, ...march)).toBe(true);
  });
});

describe("where the code popover goes (review M13)", () => {
  const viewport = { width: 1200, height: 800 };
  const size = { width: 256, height: 300 };

  it("opens below the cell when it fits", () => {
    const at = placePopover({ left: 100, top: 200, bottom: 224 }, size, viewport);
    expect(at).toEqual({ left: 108, top: 232, above: false });
  });

  it("flips above a bottom-row cell instead of running off the viewport", () => {
    const at = placePopover({ left: 100, top: 700, bottom: 724 }, size, viewport);
    expect(at.above).toBe(true);
    expect(at.top).toBe(700 - 8 - 300);
    expect(at.top + size.height).toBeLessThanOrEqual(viewport.height);
  });

  it("clamps at the right edge, which is the one clamp the old code had", () => {
    const at = placePopover({ left: 1150, top: 200, bottom: 224 }, size, viewport);
    expect(at.left).toBe(1200 - 256 - 8);
  });

  it("never goes above the top even when it fits nowhere", () => {
    const at = placePopover({ left: 10, top: 100, bottom: 124 }, { width: 256, height: 700 }, { width: 400, height: 500 });
    expect(at.top).toBe(8);
    expect(at.left).toBe(18);
  });
});

describe("the grid page keeps the review M10 and M13 fixes", () => {
  const page = readFileSync(
    join(process.cwd(), "src/app/(dashboard)/hr/attendance/page.tsx"),
    "utf8",
  );

  it("refetches once per apply, not once per person", () => {
    // Both write hooks are told not to invalidate, and each write LOOP does it
    // itself, once, after the loop. Dropping either half is silent: with the
    // hook default restored a 23-row drag is 23 refetches again; with the
    // page's own call dropped the grid simply stops refreshing after a write.
    expect(page).toContain("useSetHrAttendance({ invalidate: false })");
    expect(page).toContain("useClearHrAttendance({ invalidate: false })");
    expect(page).toContain('qc.invalidateQueries({ queryKey: ["hr"] })');
  });

  /**
   * The invariant, stated directly rather than by counting occurrences.
   *
   * It used to assert there was exactly ONE `invalidateQueries` in the file,
   * which held only while there was one write loop; a second, equally correct
   * one (the sick-tier answer) broke it while doing nothing wrong. What
   * actually matters is that no refetch happens INSIDE a per-person loop —
   * that is the 23-refetch regression M10 fixed.
   */
  it("never refetches inside a per-person write loop", () => {
    const loops = [
      ["for (const { employee, dates } of byEmployee.values())", "// ONE refetch"],
      ["for (const ask of asks)", "await qc.invalidateQueries"],
    ] as const;
    for (const [start, end] of loops) {
      const i = page.indexOf(start);
      const j = page.indexOf(end, i);
      expect(i, `loop start not found: ${start}`).toBeGreaterThan(-1);
      expect(j, `loop end not found: ${end}`).toBeGreaterThan(i);
      expect(page.slice(i, j), `refetch inside ${start}`).not.toContain("invalidateQueries");
    }
  });

  it("keeps the selection when part of a write fails, and names who", () => {
    expect(page).toContain("toast.warning(`Written for ${people - failures.length} of ${people} people.");
  });

  it("anchors the popover to the head cell, fixed, with no scrollY arithmetic", () => {
    expect(page).not.toContain("scrollY");
    expect(page).toContain('className="fixed z-50 w-64');
    expect(page).toContain("placePopover(");
  });
});
