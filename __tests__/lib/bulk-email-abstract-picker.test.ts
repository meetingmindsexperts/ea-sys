/**
 * The abstract picker inside the bulk-email dialog (Sep 9, 2026).
 *
 * What matters here is that the number the organiser reads is the number the
 * server mails: the count applies the SAME per-type scope rule the resolver
 * does (bulk-email-audience.ts), dedupes by author for per-author types, and
 * only ever OFFERS a status the server would accept.
 *
 * MUTATIONS TO VERIFY AGAINST: make abstractInSendScope ignore the type's
 * default scope (return true when no explicit status) and the reminder count
 * test fails; make countAbstractRecipients skip the email dedup and the
 * per-author test fails.
 */
import { describe, it, expect } from "vitest";
import {
  abstractScopeLabel,
  abstractStatusOptionsFor,
  countAbstractRecipients,
  filterAbstractOptions,
  matchPastedAbstractIdentifiers,
  resolveAbstractStatusFilter,
  type AbstractPickerOption,
} from "@/lib/bulk-email-abstract-picker";
import { abstractInSendScope, abstractStatusAllowedForType } from "@/lib/bulk-email-audience";

const row = (o: Partial<AbstractPickerOption> & { id: string }): AbstractPickerOption => ({
  serialId: null,
  title: "Untitled",
  status: "SUBMITTED",
  email: "a@x.com",
  authorName: "Ana Silva",
  ...o,
});

const ROWS: AbstractPickerOption[] = [
  row({ id: "d1", serialId: 1, title: "Draft one", status: "DRAFT", email: "d@x.com", authorName: "Dan Draft" }),
  row({ id: "s7", serialId: 7, title: "Iron in HF", status: "SUBMITTED", email: "jane@x.com", authorName: "Jane Doe" }),
  row({ id: "s9", serialId: 9, title: "Anaemia audit", status: "SUBMITTED", email: "JANE@x.com", authorName: "Jane Doe" }),
  row({ id: "acc", serialId: 12, title: "Accepted work", status: "ACCEPTED", email: "acc@x.com", authorName: "Al Accepted" }),
  row({ id: "wd", serialId: 3, title: "Withdrawn", status: "WITHDRAWN", email: "w@x.com", authorName: "Wil Drawn" }),
];

describe("status options mirror what the server accepts", () => {
  it("a confirmation may not target DRAFT or WITHDRAWN", () => {
    expect(abstractStatusOptionsFor("abstract-confirmation")).not.toContain("DRAFT");
    expect(abstractStatusOptionsFor("abstract-confirmation")).not.toContain("WITHDRAWN");
    expect(abstractStatusOptionsFor("abstract-confirmation")).toContain("ACCEPTED");
  });
  it("a decision may target decided statuses only", () => {
    expect(abstractStatusOptionsFor("abstract-decision")).toEqual([
      "UNDER_REVIEW",
      "ACCEPTED",
      "REJECTED",
      "REVISION_REQUESTED",
    ]);
  });
  it("a reminder may target only authors with something left to submit (review M3), a custom email anything", () => {
    expect(abstractStatusOptionsFor("abstract-reminder")).toEqual(["DRAFT", "REVISION_REQUESTED"]);
    expect(abstractStatusOptionsFor("custom")).toHaveLength(7);
  });
  it("every offered option passes the shared allow predicate", () => {
    for (const t of ["abstract-confirmation", "abstract-decision", "abstract-reminder", "custom"]) {
      for (const s of abstractStatusOptionsFor(t)) expect(abstractStatusAllowedForType(t, s)).toBe(true);
    }
  });
  it("switching type drops a status the new type cannot send, so the server never sees INVALID_FILTER", () => {
    expect(resolveAbstractStatusFilter("abstract-decision", "SUBMITTED")).toBe("all");
    expect(resolveAbstractStatusFilter("abstract-confirmation", "SUBMITTED")).toBe("SUBMITTED");
    expect(resolveAbstractStatusFilter("custom", "all")).toBe("all");
  });
  it("names the default scope per type", () => {
    expect(abstractScopeLabel("abstract-confirmation")).toMatch(/except draft and withdrawn/i);
    expect(abstractScopeLabel("abstract-decision")).toMatch(/^Decided/);
    expect(abstractScopeLabel("abstract-reminder")).toMatch(/Drafts only/);
    expect(abstractScopeLabel("custom")).toBe("All statuses");
  });
});

describe("scope = the resolver's where", () => {
  it("default scope per type", () => {
    expect(abstractInSendScope("DRAFT", "abstract-confirmation", undefined)).toBe(false);
    expect(abstractInSendScope("WITHDRAWN", "abstract-confirmation", "all")).toBe(false);
    expect(abstractInSendScope("SUBMITTED", "abstract-confirmation", undefined)).toBe(true);
    expect(abstractInSendScope("SUBMITTED", "abstract-decision", undefined)).toBe(false);
    expect(abstractInSendScope("REJECTED", "abstract-decision", undefined)).toBe(true);
    expect(abstractInSendScope("SUBMITTED", "abstract-reminder", undefined)).toBe(false);
    expect(abstractInSendScope("DRAFT", "abstract-reminder", undefined)).toBe(true);
    expect(abstractInSendScope("WITHDRAWN", "custom", undefined)).toBe(true);
  });
  it("an explicit status replaces the default scope", () => {
    expect(abstractInSendScope("ACCEPTED", "abstract-confirmation", "ACCEPTED")).toBe(true);
    expect(abstractInSendScope("SUBMITTED", "abstract-confirmation", "ACCEPTED")).toBe(false);
  });
});

describe("filterAbstractOptions", () => {
  it("shows only rows in scope, sorted by number", () => {
    const ids = filterAbstractOptions(ROWS, { emailType: "abstract-confirmation", status: "all", search: "" }).map((o) => o.id);
    expect(ids).toEqual(["s7", "s9", "acc"]);
  });
  it("searches by number in any of its spellings, by title, by email and by author, case-insensitively", () => {
    const f = (search: string) =>
      filterAbstractOptions(ROWS, { emailType: "custom", status: "all", search }).map((o) => o.id);
    expect(f("A-007")).toEqual(["s7"]);
    expect(f("a-7")).toEqual(["s7"]);
    expect(f("007")).toEqual(["s7"]);
    expect(f("7")).toEqual(["s7"]);
    expect(f("anaemia")).toEqual(["s9"]);
    expect(f("JANE@")).toEqual(["s7", "s9"]);
    expect(f("dan draft")).toEqual(["d1"]);
    expect(f("nothing here")).toEqual([]);
  });
  it("an explicit status narrows the list", () => {
    expect(filterAbstractOptions(ROWS, { emailType: "custom", status: "ACCEPTED", search: "" }).map((o) => o.id)).toEqual(["acc"]);
  });
});

describe("countAbstractRecipients = emails the send produces", () => {
  it("a confirmation counts one per abstract in scope (two abstracts by one author = 2)", () => {
    expect(countAbstractRecipients(ROWS, { emailType: "abstract-confirmation", status: "all" })).toBe(3);
  });
  it("a reminder counts authors, not abstracts, and only drafts", () => {
    const rows = [...ROWS, row({ id: "d2", serialId: 2, status: "DRAFT", email: "D@x.com" })];
    expect(countAbstractRecipients(rows, { emailType: "abstract-reminder", status: "all" })).toBe(1);
  });
  it("a custom email dedupes by author across every status", () => {
    // jane has two abstracts under two spellings of one address.
    expect(countAbstractRecipients(ROWS, { emailType: "custom", status: "all" })).toBe(4);
  });
  it("ticked rows restrict the count, still inside the type's scope", () => {
    const selected = new Set(["s7", "wd", "d1"]);
    expect(countAbstractRecipients(ROWS, { emailType: "abstract-confirmation", status: "all", selectedIds: selected })).toBe(1);
    expect(countAbstractRecipients(ROWS, { emailType: "custom", status: "all", selectedIds: selected })).toBe(3);
  });
  it("an empty selection means everyone in scope", () => {
    expect(countAbstractRecipients(ROWS, { emailType: "abstract-decision", status: "all", selectedIds: new Set() })).toBe(1);
  });
});

describe("matchPastedAbstractIdentifiers (Select abstracts, Sep 9, 2026)", () => {
  const options = [
    row({ id: "abs-7", serialId: 7, email: "ana@x.com" }),
    row({ id: "abs-12", serialId: 12, email: "ana@x.com" }),
    row({ id: "abs-30", serialId: 30, email: "bo@y.org" }),
    row({ id: "abs-none", serialId: null, email: "cy@z.net" }),
  ];

  it("matches a number in any spelling, the full id, and an email (every abstract of that author)", () => {
    const r = matchPastedAbstractIdentifiers("A-007, a-12\n030\nabs-none\nBO@Y.ORG", options);
    expect(r.matched.sort()).toEqual(["abs-12", "abs-30", "abs-7", "abs-none"].sort());
    expect(r.unmatched).toEqual([]);
  });

  it("one email selects all of that author's abstracts, once each", () => {
    const r = matchPastedAbstractIdentifiers("ana@x.com, ana@x.com, 7", options);
    expect(r.matched.sort()).toEqual(["abs-12", "abs-7"]);
  });

  it("reports what it could not place rather than guessing", () => {
    const r = matchPastedAbstractIdentifiers("A-999, nobody@x.com, 7x", options);
    expect(r.matched).toEqual([]);
    expect(r.unmatched).toEqual(["A-999", "nobody@x.com", "7x"]);
  });

  it("an empty paste matches nothing and reports nothing", () => {
    expect(matchPastedAbstractIdentifiers("  \n , ", options)).toEqual({ matched: [], unmatched: [] });
  });
});
