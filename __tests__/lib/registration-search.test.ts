/**
 * The Registrations search box (owner, Oct 26, 2026): digits alone find one
 * registration number exactly; anything else matches name, email or
 * organisation as before. The CSV export's `q` uses the same parser.
 */
import { describe, it, expect } from "vitest";
import { matchesRegistrationSearch, parseSerialQuery } from "@/lib/registration-search";

const reg = (serialId: number | null, over: Partial<{ firstName: string; email: string; organization: string | null }> = {}) => ({
  serialId,
  attendee: { firstName: "Asha", lastName: "Rao", email: "asha@example.com", organization: "Clinic", ...over },
});

describe("parseSerialQuery", () => {
  it("reads 2, 002 and #002 as 2", () => {
    expect(parseSerialQuery("2")).toBe(2);
    expect(parseSerialQuery(" 002 ")).toBe(2);
    expect(parseSerialQuery("#002")).toBe(2);
  });

  it("is null for anything that is not just a number", () => {
    for (const q of ["", "asha", "2a", "0 2", "-2", "2.0", "##2"]) expect(parseSerialQuery(q)).toBeNull();
  });
});

describe("matchesRegistrationSearch", () => {
  it("a number matches that registration only, never one that merely contains the digits", () => {
    expect(matchesRegistrationSearch(reg(2), "002")).toBe(true);
    expect(matchesRegistrationSearch(reg(12), "2")).toBe(false);
    expect(matchesRegistrationSearch(reg(20), "2")).toBe(false);
    expect(matchesRegistrationSearch(reg(null), "2")).toBe(false);
  });

  it("text still matches name, email and organisation, ignoring case", () => {
    expect(matchesRegistrationSearch(reg(1), "ASHA")).toBe(true);
    expect(matchesRegistrationSearch(reg(1), "example.com")).toBe(true);
    expect(matchesRegistrationSearch(reg(1), "clin")).toBe(true);
    expect(matchesRegistrationSearch(reg(1, { organization: null }), "clin")).toBe(false);
    expect(matchesRegistrationSearch(reg(1), "bob")).toBe(false);
  });

  it("an empty box matches everything", () => {
    expect(matchesRegistrationSearch(reg(1), "  ")).toBe(true);
  });
});
