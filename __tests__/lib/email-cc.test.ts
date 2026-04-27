/**
 * Unit tests for `brandingCc` in src/lib/email.ts.
 *
 * The helper merges two independent CC sources (event-level
 * `emailCcAddresses` + per-recipient `additionalEmail` list) and
 * dedupes them against an exclude set (typically the primary `to`
 * recipient). Both sources are independently optional — the
 * "independence matrix" in the helper's JSDoc is the contract these
 * tests pin down.
 */

import { describe, it, expect } from "vitest";
import { brandingCc } from "@/lib/email";

describe("brandingCc", () => {
  it("returns undefined when both sources are empty", () => {
    expect(brandingCc({})).toBeUndefined();
    expect(brandingCc({ emailCcAddresses: [] }, [], [])).toBeUndefined();
  });

  it("returns just the event-level CC list when no additionals provided", () => {
    expect(brandingCc({ emailCcAddresses: ["ops@x.com"] })).toEqual([{ email: "ops@x.com" }]);
  });

  it("returns just the additional emails when no event-level CC is set", () => {
    expect(brandingCc({}, [], ["secretary@y.com"])).toEqual([{ email: "secretary@y.com" }]);
  });

  it("merges event-level + additional, event-level first", () => {
    const result = brandingCc(
      { emailCcAddresses: ["ops@x.com"] },
      [],
      ["secretary@y.com"],
    );
    expect(result).toEqual([{ email: "ops@x.com" }, { email: "secretary@y.com" }]);
  });

  it("excludes the primary recipient (case-insensitive + trim)", () => {
    const result = brandingCc(
      { emailCcAddresses: ["Me@Z.com"] },
      [{ email: "  ME@z.com  " }],
      ["me@z.com"],
    );
    expect(result).toBeUndefined();
  });

  it("dedupes the additional email against an event-level entry", () => {
    const result = brandingCc(
      { emailCcAddresses: ["ops@x.com"] },
      [{ email: "me@z.com" }],
      ["OPS@X.com"], // same as event-level after lowercasing
    );
    expect(result).toEqual([{ email: "ops@x.com" }]);
  });

  it("dedupes within the additional list", () => {
    const result = brandingCc(
      {},
      [{ email: "me@z.com" }],
      ["alt@y.com", "alt@y.com", "ALT@y.com"],
    );
    expect(result).toEqual([{ email: "alt@y.com" }]);
  });

  it("filters null / undefined / empty-string entries silently", () => {
    const result = brandingCc(
      { emailCcAddresses: ["ops@x.com"] },
      [{ email: "me@z.com" }],
      [null, undefined, "", "   ", "alt@y.com"],
    );
    expect(result).toEqual([{ email: "ops@x.com" }, { email: "alt@y.com" }]);
  });

  it("normalizes mixed-case entries to lowercase", () => {
    const result = brandingCc(
      { emailCcAddresses: ["MIXED@CASE.COM"] },
      [{ email: "primary@z.com" }],
      ["Other@Case.Com"],
    );
    expect(result).toEqual([
      { email: "mixed@case.com" },
      { email: "other@case.com" },
    ]);
  });

  it("returns undefined when the only address is the primary recipient", () => {
    // The per-event list and additional both equal the primary recipient,
    // so after dedup-by-exclude the merged list is empty.
    const result = brandingCc(
      { emailCcAddresses: ["me@z.com"] },
      [{ email: "me@z.com" }],
      ["me@z.com"],
    );
    expect(result).toBeUndefined();
  });
});
