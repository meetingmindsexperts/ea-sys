/**
 * Enter in the registration desk's search box (review of 23086dc0): which row
 * it acts on, and that a code-shaped query with no match is a scan.
 */
import { describe, it, expect } from "vitest";
import { deskEnterAction, deskQueryIsSearchable, matchesDeskSearch, nextPollBatch, type DeskEnterCandidate } from "@/lib/desk-enter";

const row = (status: string, paymentDue = false, id = "r1"): DeskEnterCandidate => ({ id, status, paymentDue });

describe("deskEnterAction", () => {
  it("one match: reprint when in, pay when owing, otherwise check in", () => {
    expect(deskEnterAction("smith", [row("CHECKED_IN", true)])).toEqual({ kind: "reprint", id: "r1" });
    expect(deskEnterAction("smith", [row("CONFIRMED", true)])).toEqual({ kind: "pay", id: "r1" });
    expect(deskEnterAction("smith", [row("PENDING")])).toEqual({ kind: "check-in", id: "r1" });
  });

  it("a single cancelled match does nothing to it, but says why", () => {
    expect(deskEnterAction("smith", [row("CANCELLED")])).toEqual({ kind: "cancelled" });
  });

  it("several matches ask the operator to choose, even when the text looks like a code", () => {
    expect(deskEnterAction("sm", [row("CONFIRMED", false, "a"), row("CONFIRMED", false, "b")])).toEqual({ kind: "choose", count: 2 });
  });

  it("no match on a code shape is a scan: an entry code, its serial-suffixed form, a DTCM UUID", () => {
    for (const code of ["1793253677531055189", "1793253677531055189-049", "0b1c2d3e-aaaa-bbbb-cccc-123456789abc"]) {
      expect(deskEnterAction(`  ${code} `, [])).toEqual({ kind: "scan", code });
    }
  });

  it("no match on a short, spaced or email query is not a scan", () => {
    expect(deskEnterAction("ab", [])).toEqual({ kind: "no-match" });
    expect(deskEnterAction("john smith", [])).toEqual({ kind: "no-match" });
    expect(deskEnterAction("   ", [])).toEqual({ kind: "none" });
    expect(deskEnterAction("someone@hospital.org", [])).toEqual({ kind: "no-match" });
  });
});

describe("matchesDeskSearch", () => {
  const person = { serialId: 7, attendee: { firstName: "Fatima", lastName: "Al Malallah", email: "f@x.org", organization: "Salmaniya" } };
  it("finds a full name in either order, and everything the shared search finds", () => {
    for (const q of ["Fatima Al Malallah", "al malallah fatima", "fatima  al", "salmaniya", "f@x.org", "007"]) {
      expect(matchesDeskSearch(person, q), q).toBe(true);
    }
    expect(matchesDeskSearch(person, "Fatima Smith")).toBe(false);
  });

  it("a registration number finds that registration in any padding, and nothing else", () => {
    for (const q of ["7", "07", "007", "#7", " 7 "]) expect(matchesDeskSearch(person, q), q).toBe(true);
    expect(matchesDeskSearch(person, "70")).toBe(false);
    // A number never falls through to the name match.
    const digits = { serialId: 3, attendee: { firstName: "Room 7", lastName: "Guest", email: "g@x.org" } };
    expect(matchesDeskSearch(digits, "7")).toBe(false);
  });
});

describe("deskQueryIsSearchable", () => {
  it("searches from two characters, or from one digit of a registration number (owner, Oct 29 2026)", () => {
    expect(deskQueryIsSearchable("2")).toBe(true);
    expect(deskQueryIsSearchable("#2")).toBe(true);
    expect(deskQueryIsSearchable("02")).toBe(true);
    expect(deskQueryIsSearchable("al")).toBe(true);
    expect(deskQueryIsSearchable("a")).toBe(false);
    expect(deskQueryIsSearchable(" ")).toBe(false);
  });
});

describe("nextPollBatch", () => {
  const ids = Array.from({ length: 120 }, (_, i) => `r${i}`);
  it("asks about everyone in turn, wrapping, so nobody past the first batch is starved", () => {
    const seen = new Set<string>();
    let offset = 0;
    for (let i = 0; i < 3; i++) {
      const next = nextPollBatch(ids, offset, 50);
      expect(next.batch).toHaveLength(50);
      expect(new Set(next.batch).size).toBe(50);
      next.batch.forEach((id) => seen.add(id));
      offset = next.offset;
    }
    expect(seen.size).toBe(120);
  });
  it("a short list is asked about whole, every time", () => {
    expect(nextPollBatch(["a", "b"], 7, 50)).toEqual({ batch: ["a", "b"], offset: 0 });
  });
});
