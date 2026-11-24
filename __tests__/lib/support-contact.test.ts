/**
 * The event team's phone and office hours (Nov 24, 2026; owner: "better we add
 * phone number and office timings"): the organisation's, which an event may
 * override field by field, as one cleaned line each.
 */
import { describe, it, expect } from "vitest";
import { effectiveSupportContact, readSupportContact, sameSupportContact, storedSupportContact, supportContactSchema } from "@/lib/support-contact";

const org = { supportContact: { phone: "+971 4 123 4567", hours: "Monday to Friday, 9:00 to 18:00" } };

describe("support contact", () => {
  it("nothing stored, or anything malformed, is nothing given", () => {
    for (const settings of [undefined, null, {}, { supportContact: "x" }, { supportContact: { phone: 42, hours: ["a"] } }]) {
      expect(readSupportContact(settings)).toEqual({ phone: null, hours: null });
    }
  });

  it("every event uses the organisation's until it gives its own, field by field", () => {
    expect(effectiveSupportContact(org, {})).toEqual({ phone: "+971 4 123 4567", hours: "Monday to Friday, 9:00 to 18:00" });
    expect(effectiveSupportContact(org, { supportContact: { phone: "+971 50 000 0000" } })).toEqual({
      phone: "+971 50 000 0000",
      hours: "Monday to Friday, 9:00 to 18:00",
    });
    expect(effectiveSupportContact({}, {})).toEqual({ phone: null, hours: null });
  });

  it("a value is one line: newlines and runs of spaces collapse, blanks are not stored", () => {
    expect(readSupportContact({ supportContact: { hours: "  Mon to Fri\n 9 to 6  " } }).hours).toBe("Mon to Fri 9 to 6");
    expect(storedSupportContact({ phone: "  ", hours: "Sunday to Thursday" })).toEqual({ hours: "Sunday to Thursday" });
    expect(storedSupportContact({ phone: "", hours: "" })).toEqual({});
  });

  it("a phone is digits and the usual separators; anything else is refused, so the public is never told it", () => {
    for (const phone of ["+971 4 123 4567", "(04) 123-4567", "04.123.4567", ""]) {
      expect(supportContactSchema.safeParse({ phone }).success, phone).toBe(true);
    }
    for (const phone of ["call us", "+971 4 123 4567 or email", "https://example.com", "++971"]) {
      expect(supportContactSchema.safeParse({ phone }).success, phone).toBe(false);
    }
    expect(supportContactSchema.safeParse({ hours: "x".repeat(201) }).success).toBe(false);
  });

  // Review of d3e669030.
  it("a phone has at least six digits: brackets or dots alone are not a phone", () => {
    for (const phone of ["(", "+(", "(-)", "( . )", "12345"]) {
      expect(supportContactSchema.safeParse({ phone }).success, phone).toBe(false);
    }
    expect(supportContactSchema.safeParse({ phone: "800 123" }).success).toBe(true);
  });

  it("null clears both, and control characters never reach the stored line", () => {
    expect(supportContactSchema.safeParse(null).success).toBe(true);
    expect(storedSupportContact(null)).toEqual({});
    expect(readSupportContact({ supportContact: { hours: "Mon\u0000 to\u0007 Fri" } }).hours).toBe("Mon to Fri");
  });

  it("an unchanged contact is the same however it is spaced, so a save does not send it again", () => {
    expect(sameSupportContact({ phone: "", hours: "" }, {})).toBe(true);
    expect(sameSupportContact({ phone: " +971 4 123 4567 ", hours: "" }, { phone: "+971 4 123 4567" })).toBe(true);
    expect(sameSupportContact({ phone: "+971 4 123 4567" }, { phone: "+971 4 123 4568" })).toBe(false);
  });
});
