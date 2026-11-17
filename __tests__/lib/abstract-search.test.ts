/**
 * The Abstracts page's search (Nov 17, 2026, owner: "add search abstracts
 * option"). A filter over the list the page already holds.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { abstractMatchesSearch, type SearchableAbstract } from "@/lib/abstract-search";

const ABSTRACT: SearchableAbstract = {
  serialId: 12,
  title: "Outcomes of SGLT2 inhibitors in heart failure",
  speaker: { firstName: "José", lastName: "Núñez", email: "jose.nunez@example.org" },
  theme: { name: "Clinical trials" },
  subTheme: { name: "Pharmacology" },
  track: { name: "Poster hall" },
  coAuthors: [{ firstName: "Amira", lastName: "Haddad" }],
};

const matches = (q: string, a: SearchableAbstract = ABSTRACT) => abstractMatchesSearch(a, q);

describe("abstractMatchesSearch", () => {
  it("matches everything when nothing is typed", () => {
    expect(matches("")).toBe(true);
    expect(matches("   ")).toBe(true);
  });

  it("finds an abstract by its number, however it is typed", () => {
    for (const q of ["12", "012", "A-12", "a-012", "A012", "#12"]) expect(matches(q), q).toBe(true);
    expect(matches("13")).toBe(false);
    expect(matches("A-120")).toBe(false);
  });

  it("finds a number inside a title as text too", () => {
    expect(matches("sglt2")).toBe(true);
    // "2" is abstract number 2, and also text in "SGLT2" and "A-012".
    expect(matches("2")).toBe(true);
  });

  it("finds by title, author, email, co-author, theme, sub-theme and track", () => {
    for (const q of ["heart failure", "núñez", "jose.nunez@example.org", "haddad", "clinical", "pharmacology", "poster hall"]) {
      expect(matches(q), q).toBe(true);
    }
  });

  it("ignores case and accents", () => {
    expect(matches("JOSE NUNEZ")).toBe(true);
    expect(matches("josé")).toBe(true);
  });

  it("needs every word typed, in any order", () => {
    expect(matches("failure jose")).toBe(true);
    expect(matches("jose oncology")).toBe(false);
  });

  it("does not join one field's end to the next field's start", () => {
    // "failure" ends the title and "José" starts the author: "failurejose" is in neither.
    expect(matches("failurejose")).toBe(false);
  });

  it("copes with an abstract that has no number, theme or co-authors", () => {
    const bare: SearchableAbstract = { serialId: null, title: "Untitled", speaker: { firstName: "A", lastName: "B" } };
    expect(matches("untitled", bare)).toBe(true);
    expect(matches("12", bare)).toBe(false);
    // The dash shown for a missing number is not something to find.
    expect(matches("—", bare)).toBe(false);
  });
});

// The page is a 1,300-line client component with no render harness, so the
// wiring is pinned on the source (as agenda-session-form-speakers.test.ts does).
describe("the Abstracts page's search box", () => {
  const src = readFileSync(
    path.join(process.cwd(), "src/app/(dashboard)/events/[eventId]/abstracts/page.tsx"),
    "utf8",
  );

  it("filters the list through the one search rule", () => {
    expect(src).toContain("filteredAbstracts.filter((a) => abstractMatchesSearch(a, searchQuery))");
    expect(src).toContain('aria-label="Search abstracts"');
  });

  it("narrows what the reviewer filters leave, so Select all ticks only what is shown", () => {
    // shownIds, which Select all and the hidden-selection count read, comes from the searched list.
    expect(src).toContain("const shownIds = shownAbstracts.map((a) => a.id);");
    expect(src.indexOf("const shownAbstracts = searching")).toBeLessThan(src.indexOf("const shownIds = shownAbstracts.map"));
  });
});
