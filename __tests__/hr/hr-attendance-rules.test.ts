/**
 * The standing-rule resolver and its place in the precedence chain.
 *
 * The cases that matter here are the ones where two things could both be true
 * about a day. Precedence is the whole contract: the grid and the balance
 * engine both read it, so a wrong answer is a wrong payroll figure, not a
 * cosmetic bug.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect } from "vitest";
import {
  type AttendanceRuleLike,
  candidateDates,
  ruleApplies,
  ruleFor,
} from "@/hr/lib/attendance-rules";
import { effectiveStatusFor, ruleDerivedDays } from "@/hr/lib/hr-effective-status";
import { computeLeaveBalance } from "@/hr/lib/leave-balance";
import type { CalendarDate } from "@/hr/lib/hr-date";
import type { LeaveCategory } from "@prisma/client";

const d = (s: string) => s as CalendarDate;

/** The real shape from production: everyone remote 2-6 March 2026. */
const companyWeek: AttendanceRuleLike = {
  id: "r-company", scope: "ORG", code: "WFH",
  startDate: d("2026-03-02"), endDate: d("2026-03-06"),
};
/** Jinan, permanently remote. Open-ended by design. */
const standing: AttendanceRuleLike = {
  id: "r-standing", scope: "EMPLOYEE", employeeId: "e-jinan", code: "WFH",
  startDate: d("2023-05-01"), endDate: null,
};

const employment = { joiningDate: d("2020-01-01"), exitDate: null };
const noHolidays = new Set<CalendarDate>();
const noEntries = new Map<CalendarDate, { code: string }>();

describe("ruleApplies", () => {
  it("an ORG rule speaks for anybody inside its window", () => {
    expect(ruleApplies(companyWeek, "e-anyone", d("2026-03-04"))).toBe(true);
  });

  it("an EMPLOYEE rule speaks only for its own person", () => {
    expect(ruleApplies(standing, "e-jinan", d("2026-03-04"))).toBe(true);
    expect(ruleApplies(standing, "e-someone-else", d("2026-03-04"))).toBe(false);
  });

  it("an open-ended rule has no end", () => {
    expect(ruleApplies(standing, "e-jinan", d("2099-01-01"))).toBe(true);
  });

  it("the window is inclusive at both ends", () => {
    expect(ruleApplies(companyWeek, "e-a", d("2026-03-02"))).toBe(true);
    expect(ruleApplies(companyWeek, "e-a", d("2026-03-06"))).toBe(true);
    expect(ruleApplies(companyWeek, "e-a", d("2026-03-01"))).toBe(false);
    expect(ruleApplies(companyWeek, "e-a", d("2026-03-07"))).toBe(false);
  });
});

describe("ruleFor precedence", () => {
  it("the narrower statement wins: EMPLOYEE beats ORG", () => {
    const shutdown: AttendanceRuleLike = {
      id: "r-shut", scope: "ORG", code: "AL",
      startDate: d("2026-03-02"), endDate: d("2026-03-06"),
    };
    const picked = ruleFor("e-jinan", d("2026-03-04"), [shutdown, standing]);
    expect(picked?.id).toBe("r-standing");
    // ...and the person the narrow rule does NOT name still gets the org one.
    expect(ruleFor("e-other", d("2026-03-04"), [shutdown, standing])?.id).toBe("r-shut");
  });

  it("does not depend on the order it was handed the rules", () => {
    const a = ruleFor("e-jinan", d("2026-03-04"), [companyWeek, standing]);
    const b = ruleFor("e-jinan", d("2026-03-04"), [standing, companyWeek]);
    expect(a?.id).toBe(b?.id);
  });

  it("within one scope the later start date wins", () => {
    const older: AttendanceRuleLike = {
      id: "r-1", scope: "ORG", code: "WFH", startDate: d("2026-03-01"), endDate: d("2026-03-31"),
    };
    const newer: AttendanceRuleLike = {
      id: "r-2", scope: "ORG", code: "AL", startDate: d("2026-03-10"), endDate: d("2026-03-12"),
    };
    expect(ruleFor("e-a", d("2026-03-11"), [older, newer])?.code).toBe("AL");
    expect(ruleFor("e-a", d("2026-03-05"), [older, newer])?.code).toBe("WFH");
  });

  it("returns null when nothing applies", () => {
    expect(ruleFor("e-a", d("2026-06-01"), [companyWeek])).toBeNull();
  });
});

describe("effectiveStatusFor with rules", () => {
  const ctx = (over: Partial<Parameters<typeof effectiveStatusFor>[1]> = {}) => ({
    employment,
    entriesByDate: noEntries,
    holidays: noHolidays,
    rules: [companyWeek],
    employeeId: "e-a",
    ...over,
  });

  it("a rule fills an ordinary working day", () => {
    const s = effectiveStatusFor(d("2026-03-04"), ctx());
    expect(s.code).toBe("WFH");
    expect(s.derived).toBe(true);
    expect(s.ruleId).toBe("r-company");
  });

  it("an explicit entry beats a rule", () => {
    const s = effectiveStatusFor(d("2026-03-04"), ctx({
      entriesByDate: new Map([[d("2026-03-04"), { code: "AL" }]]),
    }));
    expect(s.code).toBe("AL");
    expect(s.derived).toBe(false);
    expect(s.ruleId).toBeUndefined();
  });

  it("a public holiday beats a rule", () => {
    // Eid al-Fitr 2026 falls inside no company week here, so place one that does.
    const s = effectiveStatusFor(d("2026-03-04"), ctx({
      holidays: new Set([d("2026-03-04")]),
    }));
    expect(s.code).toBe("PH");
  });

  it("a weekend beats a rule: a company day does not create a working Saturday", () => {
    const spanningWeekend: AttendanceRuleLike = {
      id: "r-span", scope: "ORG", code: "WFH",
      startDate: d("2026-03-02"), endDate: d("2026-03-13"),
    };
    // 7 March 2026 is a Saturday.
    const s = effectiveStatusFor(d("2026-03-07"), ctx({ rules: [spanningWeekend] }));
    expect(s.code).toBe("OFF");
    expect(s.ruleId).toBeUndefined();
  });

  it("outside employment beats everything, rules included", () => {
    const s = effectiveStatusFor(d("2019-03-04"), ctx());
    expect(s.code).toBe("NOT_EMPLOYED");
  });

  it("without a rule the day is still an assumed P, distinguishable by ruleId", () => {
    const s = effectiveStatusFor(d("2026-04-01"), ctx());
    expect(s.code).toBe("P");
    expect(s.ruleId).toBeUndefined();
  });

  it("an EMPLOYEE rule does not leak onto another person even when passed in", () => {
    const s = effectiveStatusFor(d("2026-03-04"), ctx({
      rules: [standing], employeeId: "e-not-jinan",
    }));
    expect(s.code).toBe("P");
  });
});

describe("candidateDates", () => {
  it("covers the rule window and nothing else", () => {
    const days = candidateDates([companyWeek], "e-a", d("2026-03-01"), d("2026-03-31"));
    expect(days).toEqual([
      "2026-03-02", "2026-03-03", "2026-03-04", "2026-03-05", "2026-03-06",
    ]);
  });

  it("clamps an open-ended rule to the query window", () => {
    const days = candidateDates([standing], "e-jinan", d("2026-03-01"), d("2026-03-05"));
    expect(days[0]).toBe("2026-03-01");
    expect(days.at(-1)).toBe("2026-03-05");
    expect(days).toHaveLength(5);
  });

  it("skips a rule belonging to somebody else", () => {
    expect(candidateDates([standing], "e-other", d("2026-03-01"), d("2026-03-31"))).toEqual([]);
  });

  it("de-duplicates overlapping windows", () => {
    const other: AttendanceRuleLike = {
      id: "r-x", scope: "ORG", code: "AL",
      startDate: d("2026-03-04"), endDate: d("2026-03-09"),
    };
    const days = candidateDates([companyWeek, other], "e-a", d("2026-03-01"), d("2026-03-31"));
    expect(days).toHaveLength(8);          // 2..9 inclusive
    expect(new Set(days).size).toBe(days.length);
  });

  it("returns nothing when the rule window falls outside the query window", () => {
    expect(candidateDates([companyWeek], "e-a", d("2026-05-01"), d("2026-05-31"))).toEqual([]);
  });
});

/**
 * THE CASE THAT COSTS MONEY.
 *
 * A rule can carry any leave code. If the balance engine did not resolve rules,
 * one company-wide record would hand every employee free annual leave and no
 * screen would show it. These assert the composition end to end, purely: rule ->
 * derived days -> balance entries -> the number on the payroll sheet.
 */
describe("a rule reaches the balance", () => {
  const employee = {
    joiningDate: d("2020-01-01"),
    exitDate: null,
    carryoverDays: 0,
    openingSickUsed: 0,
    openingCompOff: 0,
  };

  /** 2 to 6 March 2026 is Monday to Friday: five working days. */
  const shutdown: AttendanceRuleLike = {
    id: "r-shutdown", scope: "ORG", code: "AL",
    startDate: d("2026-03-02"), endDate: d("2026-03-06"),
  };

  const days = (rules: AttendanceRuleLike[], explicit: CalendarDate[] = []) =>
    ruleDerivedDays({
      employeeId: "e-a",
      employment: { joiningDate: employee.joiningDate, exitDate: null },
      rules,
      explicitDates: new Set(explicit),
      holidays: new Set<CalendarDate>(),
      from: d("2026-01-01"),
      to: d("2026-12-31"),
    });

  const balanceWith = (entries: { date: CalendarDate; category: LeaveCategory; dayWeight: number }[]) =>
    computeLeaveBalance({ employee, leaveYear: 2026, asOf: d("2026-12-31"), entries });

  it("a company-wide AL shutdown is charged as annual leave", () => {
    const derived = days([shutdown]);
    expect(derived).toHaveLength(5);
    const balance = balanceWith(
      derived.map((x) => ({ date: x.date, category: "ANNUAL" as LeaveCategory, dayWeight: 1 })),
    );
    expect(balance.annual.taken).toBe(5);
    expect(balance.annual.balance).toBe(25);
  });

  it("a WFH rule costs nothing, because working from home is working", () => {
    const wfh: AttendanceRuleLike = { ...shutdown, id: "r-wfh", code: "WFH" };
    const derived = days([wfh]);
    expect(derived).toHaveLength(5);
    const balance = balanceWith(
      derived.map((x) => ({ date: x.date, category: "WORK" as LeaveCategory, dayWeight: 1 })),
    );
    expect(balance.annual.taken).toBe(0);
    expect(balance.annual.balance).toBe(30);
  });

  it("a day already recorded is not ALSO charged by the rule covering it", () => {
    // Somebody took sick leave on the Wednesday of the shutdown week. The rule
    // must not add a sixth day on top of the entry that already exists.
    const derived = days([shutdown], [d("2026-03-04")]);
    expect(derived).toHaveLength(4);
    expect(derived.map((x) => x.date)).not.toContain("2026-03-04");
  });

  it("a rule spanning a weekend charges only the working days inside it", () => {
    // 2 to 13 March is twelve calendar days but ten working ones.
    const long: AttendanceRuleLike = {
      ...shutdown, id: "r-long", endDate: d("2026-03-13"),
    };
    expect(days([long])).toHaveLength(10);
  });

  it("a rule cannot charge leave for somebody who had not joined yet", () => {
    const derived = ruleDerivedDays({
      employeeId: "e-new",
      employment: { joiningDate: d("2026-03-05"), exitDate: null },
      rules: [shutdown],
      explicitDates: new Set<CalendarDate>(),
      holidays: new Set<CalendarDate>(),
      from: d("2026-01-01"),
      to: d("2026-12-31"),
    });
    expect(derived.map((x) => x.date)).toEqual(["2026-03-05", "2026-03-06"]);
  });
});

/**
 * ADOPTION, not just existence.
 *
 * `ruleDerivedDays` being correct is half the job; the balance service actually
 * calling it is the other half, and that half fails SILENTLY. A balance query
 * that skips rules returns a plausible number, so nothing on screen and no unit
 * test of the resolver would notice. This is the same lesson as the operator
 * predicate that was written correctly in August and adopted by eight files.
 *
 * Both call sites are asserted because there are two: one employee, and the org
 * summary. Wiring one and not the other would make a person's own page disagree
 * with the table they appear in.
 */
describe("the balance service adopts the resolver", () => {
  /** Comments stripped: the guard is about code, not about prose naming it. */
  const source = readFileSync(
    join(process.cwd(), "src/hr/services/leave-balance-service.ts"),
    "utf8",
  )
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");

  it("imports the resolver", () => {
    expect(source).toContain('from "../lib/hr-effective-status"');
    expect(source).toContain("ruleDerivedDays");
  });

  it("resolves rules on BOTH balance paths, not just one", () => {
    const calls = source.match(/ruleEntriesFor\(\{/g) ?? [];
    expect(calls).toHaveLength(2);
  });

  it("merges rule days into the entries the maths actually sees", () => {
    const merges = source.match(/entries: \[\.\.\.explicit, \.\.\.fromRules\]/g) ?? [];
    expect(merges).toHaveLength(2);
  });
});

/**
 * REGRESSION: the code popover must contain no portalling component.
 *
 * Found by a user, not by a test: picking a code from the "Another code…"
 * dropdown silently did nothing. Radix renders a Select's list in a PORTAL, so
 * an option is not a DOM descendant of the popover; the popover's click-away
 * handler read the click as "outside", unmounted itself and took the Select with
 * it before `onValueChange` could fire.
 *
 * It failed in the worst possible way. No error, no toast, no network request,
 * nothing in /logs — the dropdown opened, offered sixteen codes, and dropped
 * every one of them. Sixteen of the twenty-one leave codes were unreachable and
 * the only signal was a cell that did not change.
 *
 * The guard is structural rather than behavioural because the behavioural
 * version needs a DOM, a portal and a real pointer sequence to reproduce, and
 * would still only cover the components someone remembered to test. "Nothing in
 * this popover may render outside its own subtree" is the actual invariant.
 */
describe("the code popover keeps its own children", () => {
  const source = readFileSync(
    join(process.cwd(), "src/app/(dashboard)/hr/attendance/page.tsx"),
    "utf8",
  );
  const start = source.indexOf("function CodePopover(");
  const end = source.indexOf("\nfunction ", start + 1);
  const popover = source
    .slice(start, end === -1 ? undefined : end)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");

  it("is actually where we think it is", () => {
    expect(start).toBeGreaterThan(-1);
    expect(popover).toContain("onPick");
  });

  it("renders no Radix Select, whose list would portal out of the popover", () => {
    expect(popover).not.toMatch(/<Select[ >]/);
    expect(popover).not.toContain("SelectTrigger");
    expect(popover).not.toContain("SelectContent");
  });

  it("renders no other portalling primitive either", () => {
    for (const portalling of ["<Popover", "<Dialog", "<DropdownMenu", "<Tooltip", "createPortal"]) {
      expect(popover).not.toContain(portalling);
    }
  });

  it("still offers the secondary codes, inline", () => {
    expect(popover).toContain("Another code…");
    expect(popover).toContain("others.map");
  });
});
