/**
 * The Abstracts page's search (Nov 17, 2026, owner: "add search abstracts
 * option"). A filter over the list the page already holds.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { abstractMatchesSearch, type AbstractSearchOptions, type SearchableAbstract } from "@/lib/abstract-search";
import { abstractSerialFromToken } from "@/lib/abstract-reviewer-sheet";

const ABSTRACT: SearchableAbstract = {
  serialId: 12,
  title: "Outcomes of SGLT2 inhibitors in heart failure",
  speaker: { firstName: "José", lastName: "Núñez", email: "jose.nunez@example.org" },
  theme: { name: "Clinical trials" },
  subTheme: { name: "Pharmacology" },
  track: { name: "Hall B" },
  coAuthors: [{ firstName: "Amira", lastName: "Haddad" }],
};

const matches = (q: string, a: SearchableAbstract = ABSTRACT, options?: AbstractSearchOptions) =>
  abstractMatchesSearch(a, q, options);
const titled = (title: string, serialId: number | null = 5): SearchableAbstract => ({
  serialId,
  title,
  speaker: { firstName: "A", lastName: "B" },
});
const by = (firstName: string, lastName: string): SearchableAbstract => ({
  serialId: 5,
  title: "Untitled",
  speaker: { firstName, lastName },
});

describe("abstractMatchesSearch", () => {
  it("matches everything when nothing is typed", () => {
    expect(matches("")).toBe(true);
    expect(matches("   ")).toBe(true);
    // Punctuation alone is nothing typed.
    expect(matches(" - , ")).toBe(true);
  });

  it("finds an abstract by its number, however it is typed", () => {
    for (const q of ["12", "012", "A-12", "a-012", "A012", "#12"]) expect(matches(q), q).toBe(true);
    expect(matches("13")).toBe(false);
    expect(matches("A-120")).toBe(false);
  });

  // Review of 0418aac8: the box read numbers by a narrower rule than "Select
  // by IDs" beside it, so "A-012." selected the abstract there and found
  // nothing here. One rule now.
  it("reads a number exactly as Select by IDs does", () => {
    for (const q of ["A-012.", "12.", "abs12", "abs-12", "abstract-12", "A_12", "A.12"]) {
      expect(abstractSerialFromToken(q), q).toBe(12);
      expect(matches(q), q).toBe(true);
    }
  });

  it("finds a number pasted with the punctuation around it", () => {
    for (const q of ["A-012:", "#12,", "(A-012)", "[12]", "A-012;"]) expect(matches(q), q).toBe(true);
  });

  // "12" used to be looked for inside every number as text, so on a 169-abstract
  // event it gave 12 cards (12, 112, 120 to 129) with the wanted one last.
  it("does not find a number inside another abstract's number", () => {
    expect(matches("12", titled("Untitled", 112))).toBe(false);
    expect(matches("12", titled("Untitled", 120))).toBe(false);
    expect(matches("a-1", titled("Untitled", 10))).toBe(false);
  });

  it("still finds a number that is part of a title or a name", () => {
    expect(matches("sglt2")).toBe(true);
    expect(matches("12", titled("Vitamin B12 deficiency in the elderly", 40))).toBe(true);
    expect(matches("2026", titled("Registry report 2026", 40))).toBe(true);
    // "#12" is only ever a number.
    expect(matches("#12", titled("Vitamin B12 deficiency", 40))).toBe(false);
  });

  it("finds by title, author, co-author, theme, sub-theme and track", () => {
    for (const q of ["heart failure", "núñez", "haddad", "clinical", "pharmacology", "hall b"]) {
      expect(matches(q), q).toBe(true);
    }
  });

  it("finds by the labels the page adds, such as status and presentation type", () => {
    const options = { extra: ["Accepted", "Poster", null, undefined] };
    expect(matches("accepted", ABSTRACT, options)).toBe(true);
    expect(matches("jose poster", ABSTRACT, options)).toBe(true);
    expect(matches("poster")).toBe(false);
  });

  // Review of a3662d36: REJECTED reads "NOT ACCEPTED", and as plain text a search for "accepted" found every
  // rejected abstract, which Select all then Set status would reach.
  describe("the status is searched as a status", () => {
    const withStatus = (status: string) => ({ status, extra: ["Poster"] });
    const found = (q: string, status: string) => matches(q, ABSTRACT, withStatus(status));

    it("'accepted' finds the accepted and never the not accepted", () => {
      expect(found("accepted", "ACCEPTED")).toBe(true);
      expect(found("accepted", "REJECTED")).toBe(false);
      expect(found("jose accepted", "ACCEPTED")).toBe(true);
      expect(found("jose accepted", "REJECTED")).toBe(false);
    });

    it("'not accepted' and the older word 'rejected' both find the rejected, and only them", () => {
      for (const q of ["not accepted", "NOT ACCEPTED", "rejected", "jose not accepted", "not accepted poster"]) {
        expect(found(q, "REJECTED"), q).toBe(true);
        expect(found(q, "ACCEPTED"), q).toBe(false);
      }
    });

    it("a word still being typed matches by the start of the status, never by a word inside it", () => {
      expect(found("acc", "ACCEPTED")).toBe(true);
      expect(found("acc", "REJECTED")).toBe(false);
      expect(found("rej", "REJECTED")).toBe(true);
      expect(found("not", "REJECTED")).toBe(true);
      expect(found("under", "UNDER_REVIEW")).toBe(true);
      expect(found("under review", "UNDER_REVIEW")).toBe(true);
      expect(found("under review", "SUBMITTED")).toBe(false);
      expect(found("revision requested", "REVISION_REQUESTED")).toBe(true);
    });

    it("a status word that is really in the title still finds the abstract by its title", () => {
      const titled = { ...ABSTRACT, title: "Accepted standards of care" };
      expect(matches("accepted standards", titled, withStatus("REJECTED"))).toBe(false);
      expect(matches("standards", titled, withStatus("REJECTED"))).toBe(true);
    });

    it("without a status passed, nothing changes", () => {
      expect(matches("accepted", ABSTRACT, { extra: ["Accepted"] })).toBe(true);
    });
  });

  // A reviewer is sent the author's email and never shown it. Searching it
  // would let them confirm a guessed address.
  it("searches the author's email only when told the viewer is shown it", () => {
    expect(matches("jose.nunez@example.org")).toBe(false);
    expect(matches("example.org")).toBe(false);
    expect(matches("jose.nunez@example.org", ABSTRACT, { email: true })).toBe(true);
    expect(matches("example.org", ABSTRACT, { email: true })).toBe(true);
  });

  it("does not look for a number inside an email", () => {
    const numbered: SearchableAbstract = { serialId: 40, title: "Untitled", speaker: { firstName: "A", lastName: "B", email: "ahmed12@example.org" } };
    expect(matches("12", numbered, { email: true })).toBe(false);
    expect(matches("ahmed12", numbered, { email: true })).toBe(true);
  });

  it("ignores case and accents", () => {
    expect(matches("JOSE NUNEZ")).toBe(true);
    expect(matches("josé")).toBe(true);
  });

  it("reads letters that carry no separate accent", () => {
    expect(matches("soren", by("Søren", "Kierkegaard"))).toBe(true);
    expect(matches("lukasz", by("Łukasz", "Nowak"))).toBe(true);
    expect(matches("yildiz", by("Ayşe", "Yıldız"))).toBe(true);
    expect(matches("strasse", titled("Clinic on Hauptstraße"))).toBe(true);
    expect(matches("istanbul", titled("A cohort from İstanbul"))).toBe(true);
    // A ligature pasted from a PDF, and a soft hyphen from a typeset title.
    expect(matches("inflammation", titled("Chronic inﬂammation"))).toBe(true);
    expect(matches("cardiomyopathy", titled("Cardio­myopathy outcomes"))).toBe(true);
  });

  it("treats typed and typeset punctuation as the same", () => {
    expect(matches("crohn's", titled("Crohn’s disease in adults"))).toBe(true);
    expect(matches("crohn’s", titled("Crohn's disease in adults"))).toBe(true);
    expect(matches("long-term", titled("Long–term outcomes"))).toBe(true);
    expect(matches('"heart failure"')).toBe(true);
    expect(matches("failure,")).toBe(true);
  });

  it("finds a hyphenated or apostrophed name typed plain, or the other way round", () => {
    const ahmed = by("Ahmed", "Al-Mansoori");
    expect(matches("almansoori", ahmed)).toBe(true);
    expect(matches("al-mansoori", ahmed)).toBe(true);
    expect(matches("mansoori, ahmed", ahmed)).toBe(true);
    expect(matches("obrien", by("Siobhan", "O’Brien"))).toBe(true);
    expect(matches("o'brien", by("Siobhan", "O’Brien"))).toBe(true);
  });

  it("needs every word typed, in any order", () => {
    expect(matches("failure jose")).toBe(true);
    expect(matches("jose oncology")).toBe(false);
  });

  it("does not match one word across two fields", () => {
    // The title ends "failure" and the author begins "José".
    expect(matches("failurejose")).toBe(false);
    // The theme ends "trials" and the sub-theme begins "Pharmacology": with the
    // hyphen-free copy in play too, a separator must still stand between them.
    expect(matches("trialspharmacology")).toBe(false);
  });

  it("copes with an abstract that has no number, theme or co-authors", () => {
    const bare = titled("Untitled", null);
    expect(matches("untitled", bare)).toBe(true);
    expect(matches("12", bare)).toBe(false);
    expect(matches("—", bare)).toBe(true); // a dash alone is nothing typed
  });

  it("copes with a co-author row that is empty or missing a name", () => {
    const odd: SearchableAbstract = { ...ABSTRACT, coAuthors: [null, { firstName: null, lastName: "Haddad" }] };
    expect(matches("haddad", odd)).toBe(true);
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
    expect(src).toContain("abstractMatchesSearch(a, searchQuery, searchOptionsFor(a))");
    expect(src).toContain('aria-label="Search abstracts"');
  });

  it("narrows what the reviewer filters leave, and the list and Select all both read the result", () => {
    expect(src).toContain("const shownAbstracts = searching");
    expect(src).toContain("? filteredAbstracts.filter(");
    expect(src).toContain("const shownIds = shownAbstracts.map((a) => a.id);");
    expect(src).toContain("{shownAbstracts.map((abstract) => (");
  });

  it("searches the author's email for staff only", () => {
    expect(src).toContain("email: !isSubmitter && !isReviewer,");
  });

  it("caps what can be typed", () => {
    expect(src).toMatch(/aria-label="Search abstracts"[\s\S]{0,400}maxLength=\{200\}/);
  });
});
