/**
 * The Abstracts page's Status and Presentation type filters (owner, Nov 20, 2026).
 *
 * MUTATIONS: offer every status whatever the list holds and "only what the
 * list has" fails; drop effectiveListFilter and a vanished choice hides the
 * whole list ("a choice nothing has any more").
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect } from "vitest";
import { ALL, NO_TYPE, abstractFilterOptions, effectiveListFilter, matchesListFilters } from "@/lib/abstract-list-filters";

const a = (status: string, presentationType: string | null) => ({ status, presentationType });
const ROWS = [
  a("SUBMITTED", "ORAL_POSTER"), a("SUBMITTED", "POSTER"), a("ACCEPTED", "ORAL"), a("ACCEPTED", "POSTER"),
  a("REJECTED", "ORAL"), a("UNDER_REVIEW", null), a("ACCEPTED", ""),
];

describe("abstractFilterOptions", () => {
  it("offers only what the listed abstracts have, with counts, in the order an abstract moves through the statuses", () => {
    const { statuses, types } = abstractFilterOptions(ROWS);
    expect(statuses.map((o) => `${o.label} (${o.count})`)).toEqual(["Submitted (2)", "Under review (1)", "Accepted (3)", "Not accepted (1)"]);
    // Oral and Poster first; abstracts with no type are their own choice, last.
    expect(types.map((o) => `${o.label} (${o.count})`)).toEqual(["Oral (2)", "Poster (2)", "Oral or Poster (1)", "No type (2)"]);
    expect(types.at(-1)?.value).toBe(NO_TYPE);
  });

  it("offers nothing when there are no abstracts", () => {
    expect(abstractFilterOptions([])).toEqual({ statuses: [], types: [] });
  });

  it("keeps a value this build does not know, under its own name", () => {
    const { statuses, types } = abstractFilterOptions([a("PARKED", "LIGHTNING")]);
    expect(statuses).toEqual([{ value: "PARKED", label: "Parked", count: 1 }]);
    expect(types).toEqual([{ value: "LIGHTNING", label: "LIGHTNING", count: 1 }]);
  });
});

describe("matchesListFilters", () => {
  const shown = (status: string, type: string) => ROWS.filter((r) => matchesListFilters(r, { status, type })).length;

  it("narrows by status, by type, and by both together", () => {
    expect(shown(ALL, ALL)).toBe(ROWS.length);
    expect(shown("ACCEPTED", ALL)).toBe(3);
    expect(shown(ALL, "POSTER")).toBe(2);
    expect(shown("ACCEPTED", "POSTER")).toBe(1);
    expect(shown("REJECTED", "POSTER")).toBe(0);
  });

  it("the No type choice finds the abstracts with none, null or empty", () => {
    expect(shown(ALL, NO_TYPE)).toBe(2);
    expect(shown("ACCEPTED", NO_TYPE)).toBe(1);
  });
});

describe("effectiveListFilter", () => {
  it("a choice nothing has any more reads as all, so the list is never hidden by a filter that is not offered", () => {
    const { statuses } = abstractFilterOptions(ROWS);
    expect(effectiveListFilter("ACCEPTED", statuses)).toBe("ACCEPTED");
    expect(effectiveListFilter("WITHDRAWN", statuses)).toBe(ALL);
    expect(effectiveListFilter(ALL, statuses)).toBe(ALL);
  });
});

describe("the Abstracts page uses them as written (source pins; review of 022bbb70)", () => {
  // The hiding happens on the page, so the page's wiring is pinned here: each
  // line below is one a reviewer changed without any test failing.
  const page = readFileSync(join(process.cwd(), "src/app/(dashboard)/events/[eventId]/abstracts/page.tsx"), "utf8");

  it("filters by the EFFECTIVE values, never the stored choices", () => {
    expect(page).toContain(".filter((a) => matchesListFilters(a, { status: statusFilter, type: typeFilter }));");
  });

  it("forgets a choice that is no longer offered, so it cannot come back by itself", () => {
    expect(page).toContain("if (statusChoice !== statusFilter) setStatusChoice(statusFilter);");
    expect(page).toContain("if (typeChoice !== typeFilter) setTypeChoice(typeFilter);");
  });

  it("says a filter is on for everyone, and Clear the filters resets all four", () => {
    expect(page).toContain("const reviewerFiltersOn = filteredAbstracts.length !== abstracts.length;");
    const clear = page.slice(page.indexOf("const clearFilters = () => {"), page.indexOf("};", page.indexOf("const clearFilters = () => {")));
    for (const reset of ["setThemeFilter(ALL_THEMES)", "setUnassignedOnly(false)", "setStatusChoice(ALL_VALUES)", "setTypeChoice(ALL_VALUES)"]) {
      expect(clear).toContain(reset);
    }
  });
});
