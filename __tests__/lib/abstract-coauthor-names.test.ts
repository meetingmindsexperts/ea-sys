/**
 * `{{coAuthorNames}}` prints "None" for a sole author (Sep 9, 2026, owner).
 *
 * The renderer has no conditionals, so an organiser's "Co-Author:" row used
 * to sit beside an empty cell on every abstract without co-authors (three
 * live events, about a third of their abstracts). ONE helper now backs the
 * confirmation builder, the decision sender and, through the builder, the
 * bulk resend and the preview.
 *
 * MUTATION TO VERIFY AGAINST: return "" from formatCoAuthorNames for an empty
 * list and every "None" case below fails.
 */
import { describe, it, expect, vi } from "vitest";
vi.mock("@/lib/db", () => ({ db: {} }));
vi.mock("@/lib/logger", () => ({ apiLogger: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock("@/lib/notifications", () => ({ notifyEventAdmins: vi.fn() }));
vi.mock("@/lib/travel-grant/server", () => ({ resolveTravelGrantBlock: vi.fn() }));
import { NO_CO_AUTHORS_LABEL, formatCoAuthorNames } from "@/lib/abstract-coauthors";
import { buildAbstractConfirmationVars } from "@/lib/abstract-notifications";

describe("formatCoAuthorNames", () => {
  it("joins first and last names with a comma, in stored order", () => {
    expect(
      formatCoAuthorNames([
        { firstName: "Bo", lastName: "Li", organization: "Tawam" },
        { firstName: " Ana ", lastName: "Silva" },
      ]),
    ).toBe("Bo Li, Ana Silva");
  });

  it.each([
    ["null", null],
    ["undefined", undefined],
    ["an empty array", []],
    ["a non-array", "Bo Li"],
    ["rows with no usable name", [{ firstName: "Bo", lastName: "" }, { lastName: "Li" }]],
  ])("prints None for %s", (_label, input) => {
    expect(formatCoAuthorNames(input)).toBe("None");
    expect(NO_CO_AUTHORS_LABEL).toBe("None");
  });
});

describe("buildAbstractConfirmationVars.coAuthorNames", () => {
  const base = {
    abstractTitle: "Iron in HF",
    serialId: 7,
    presentationType: "ORAL",
    themeName: null,
    speaker: { title: "DR", firstName: "Ana", lastName: "Silva" },
  };

  it("a sole author gets None, not an empty cell", () => {
    expect(buildAbstractConfirmationVars({ ...base, coAuthors: null }).coAuthorNames).toBe("None");
    expect(buildAbstractConfirmationVars({ ...base, coAuthors: [] }).coAuthorNames).toBe("None");
  });

  it("co-authors still render as names", () => {
    expect(
      buildAbstractConfirmationVars({ ...base, coAuthors: [{ firstName: "Bo", lastName: "Li" }] }).coAuthorNames,
    ).toBe("Bo Li");
  });
});
