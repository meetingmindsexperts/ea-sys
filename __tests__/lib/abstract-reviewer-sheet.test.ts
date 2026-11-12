/**
 * The pasted reviewer sheet (bulk reviewer assignment, Nov 12, 2026): reading
 * abstract numbers loosely, reading rows whatever the column order, and
 * matching a written NAME to one person on the reviewer pool or to nobody.
 *
 * The rule these pin: a name is filled in only when exactly one person fits.
 * A guess would hand an abstract to the wrong reviewer.
 */
import { describe, it, expect } from "vitest";
import {
  abstractSerialFromToken,
  buildSheetPlan,
  initialChoices,
  matchReviewerName,
  parseReviewerSheet,
  resolvePastedAbstractIds,
  reviewerNameKey,
  sheetReviewerNames,
  type SheetReviewer,
} from "@/lib/abstract-reviewer-sheet";

const ABSTRACTS = [
  { id: "ab1", serialId: 1 },
  { id: "ab12", serialId: 12 },
  { id: "ab15", serialId: 15 },
  { id: "ab40", serialId: 40 },
  { id: "abOld", serialId: null },
];

const POOL: SheetReviewer[] = [
  { userId: "u-rahman", firstName: "Aisha", lastName: "Rahman", email: "aisha.rahman@example.test" },
  { userId: "u-haddad", firstName: "Omar", lastName: "Haddad", email: "omar@example.test" },
  { userId: "u-ali-1", firstName: "Ali", lastName: "Khan", email: "ali.khan@example.test" },
  { userId: "u-ali-2", firstName: "Sara", lastName: "Ali", email: "sara.ali@example.test" },
  { userId: "u-rashid", firstName: "Jörg", lastName: "Al-Rashid", email: "jorg@example.test" },
];

describe("abstractSerialFromToken", () => {
  it.each([
    ["012", 12],
    ["12", 12],
    ["A-012", 12],
    ["a-012", 12],
    ["a012", 12],
    ["A 12", 12],
    ["#12", 12],
    ["A-012.", 12],
    ["abstract 7", 7],
  ])("reads %s as %i", (token, serial) => {
    expect(abstractSerialFromToken(token)).toBe(serial);
  });

  it.each(["Dr Rahman", "A-", "0", "A-000", "12b", "", "omar@example.test"])("reads %j as no abstract number", (token) => {
    expect(abstractSerialFromToken(token)).toBeNull();
  });
});

describe("resolvePastedAbstractIds (Select by IDs)", () => {
  it("matches every spelling of a number, and a full id, once each, in first-seen order", () => {
    const r = resolvePastedAbstractIds("A-040, 012\n12; a-015 abOld", ABSTRACTS);
    expect(r.matched).toEqual(["ab40", "ab12", "ab15", "abOld"]);
    expect(r.unmatched).toEqual([]);
  });

  it("reports what named nothing", () => {
    const r = resolvePastedAbstractIds("012 999 hello", ABSTRACTS);
    expect(r.matched).toEqual(["ab12"]);
    expect(r.unmatched).toEqual(["999", "hello"]);
  });
});

describe("parseReviewerSheet", () => {
  it("reads a spreadsheet paste (tabs): number, reviewer, optional second reviewer", () => {
    const sheet = parseReviewerSheet("012\tDr Rahman\n015\tDr Rahman\tProf Haddad\n");
    expect(sheet.rows).toEqual([
      { line: 1, abstractTokens: ["012"], reviewerNames: ["Dr Rahman"] },
      { line: 2, abstractTokens: ["015"], reviewerNames: ["Dr Rahman", "Prof Haddad"] },
    ]);
    expect(sheet.ignoredLines).toEqual([]);
  });

  it("does not care which column the number is in", () => {
    expect(parseReviewerSheet("Dr Rahman\tA-012").rows[0]).toMatchObject({ abstractTokens: ["A-012"], reviewerNames: ["Dr Rahman"] });
  });

  it.each([
    ["012, Dr Rahman"],
    ["012: Dr Rahman"],
    ["012 -> Dr Rahman"],
    ["012 Dr Rahman"],
    ["Dr Rahman 012"],
    ["012 goes to Dr Rahman"],
  ])("reads the typed line %j", (line) => {
    expect(parseReviewerSheet(line).rows).toEqual([{ line: 1, abstractTokens: ["012"], reviewerNames: ["Dr Rahman"] }]);
  });

  it("several numbers on one row all go to that row's reviewer", () => {
    expect(parseReviewerSheet("012, 015, 040, Dr Rahman").rows[0]).toEqual({
      line: 1,
      abstractTokens: ["012", "015", "040"],
      reviewerNames: ["Dr Rahman"],
    });
    expect(parseReviewerSheet("012 015 Dr Rahman").rows[0]).toMatchObject({ abstractTokens: ["012", "015"], reviewerNames: ["Dr Rahman"] });
  });

  it("a header row or a note has no abstract number: left out and reported, with its line", () => {
    const sheet = parseReviewerSheet("Abstract\tReviewer\n\n012\tDr Rahman");
    expect(sheet.rows).toHaveLength(1);
    expect(sheet.rows[0].line).toBe(3);
    expect(sheet.ignoredLines).toEqual([{ line: 1, text: "Abstract\tReviewer" }]);
  });

  it("keeps a row that names an abstract and nobody, so the preview can say so", () => {
    expect(parseReviewerSheet("012\t").rows).toEqual([{ line: 1, abstractTokens: ["012"], reviewerNames: [] }]);
  });

  it("strips the quotes a spreadsheet puts round a cell", () => {
    expect(parseReviewerSheet('012\t"Rahman, Aisha"').rows[0].reviewerNames).toEqual(["Rahman, Aisha"]);
  });
});

describe("matchReviewerName", () => {
  it.each([
    ["Dr Rahman"],
    ["Aisha Rahman"],
    ["Rahman, Aisha"],
    ["Prof. A. Rahman"],
    ["DR AISHA RAHMAN, MD"],
    ["aisha.rahman@example.test"],
    ["Aisha.Rahman@Example.test"],
  ])("%j is Aisha Rahman", (written) => {
    expect(matchReviewerName(written, POOL)).toEqual({ kind: "matched", userId: "u-rahman" });
  });

  it("ignores accents and hyphens", () => {
    expect(matchReviewerName("Dr Jorg Al Rashid", POOL)).toEqual({ kind: "matched", userId: "u-rashid" });
    expect(matchReviewerName("Dr Rashid", POOL)).toEqual({ kind: "matched", userId: "u-rashid" });
  });

  it("several people fit: nobody is chosen, the candidates are named", () => {
    expect(matchReviewerName("Dr Ali", POOL)).toEqual({ kind: "ambiguous", candidates: ["u-ali-1", "u-ali-2"] });
  });

  it("a fuller name settles what a surname could not", () => {
    expect(matchReviewerName("Dr Sara Ali", POOL)).toEqual({ kind: "matched", userId: "u-ali-2" });
    expect(matchReviewerName("S. Ali", POOL)).toEqual({ kind: "matched", userId: "u-ali-2" });
  });

  it("an initial cannot stand for the word a whole word needs", () => {
    // "A Ali": the whole word takes "Ali" first, then "A" needs another word starting with A.
    expect(matchReviewerName("A Ali", POOL)).toEqual({ kind: "none" });
  });

  it.each(["Dr Nobody", "Dr", "A", "", "someone@elsewhere.test", "Aisha Haddad"])("%j matches nobody", (written) => {
    expect(matchReviewerName(written, POOL)).toEqual({ kind: "none" });
  });

  it("a title or a different spelling of the same name is one name in the preview", () => {
    expect(reviewerNameKey("Dr. Rahman")).toBe(reviewerNameKey("rahman"));
    expect(reviewerNameKey("Dr Rahman")).not.toBe(reviewerNameKey("Dr Haddad"));
  });
});

describe("buildSheetPlan", () => {
  const sheet = parseReviewerSheet(
    ["Abstract\tReviewer 1\tReviewer 2", "012\tDr Rahman\tProf Haddad", "015\tdr. rahman", "040\tDr Ali", "999\tDr Rahman", "001\tDr Nobody", "012\tDr Rahman"].join("\n"),
  );

  it("lists each distinct name once, with how it matched and how many abstracts name it", () => {
    const names = sheetReviewerNames(sheet, POOL);
    expect(names.map((n) => [n.written, n.match.kind, n.pairCount])).toEqual([
      ["Dr Rahman", "matched", 4],
      ["Prof Haddad", "matched", 1],
      ["Dr Ali", "ambiguous", 1],
      ["Dr Nobody", "none", 1],
    ]);
  });

  it("assigns only the names that matched one person; the rest wait for the organiser", () => {
    const plan = buildSheetPlan(sheet, ABSTRACTS, POOL);
    expect(plan.groups).toEqual([
      // A-012 is named twice for Rahman: one pair. 999 is not an abstract here.
      { reviewerUserId: "u-rahman", abstractIds: ["ab12", "ab15"] },
      { reviewerUserId: "u-haddad", abstractIds: ["ab12"] },
    ]);
    expect(plan.pairCount).toBe(3);
    expect(plan.unresolvedNames).toBe(2);
    expect(plan.unknownAbstracts).toEqual(["999"]);
  });

  it("the organiser's pick for an unsettled name is used, and a matched name can be left out", () => {
    const names = sheetReviewerNames(sheet, POOL);
    const choices = { ...initialChoices(names), [reviewerNameKey("Dr Ali")]: "u-ali-2", [reviewerNameKey("Prof Haddad")]: null };
    const plan = buildSheetPlan(sheet, ABSTRACTS, POOL, choices);
    expect(plan.groups).toEqual([
      { reviewerUserId: "u-rahman", abstractIds: ["ab12", "ab15"] },
      { reviewerUserId: "u-ali-2", abstractIds: ["ab40"] },
    ]);
    expect(plan.unresolvedNames).toBe(2); // Haddad left out, Nobody unmatched
  });

  it("reports rows that name an abstract and no reviewer", () => {
    const plan = buildSheetPlan(parseReviewerSheet("012\t\n015\tDr Rahman"), ABSTRACTS, POOL);
    expect(plan.rowsWithoutReviewer).toEqual([1]);
    expect(plan.pairCount).toBe(1);
  });
});
