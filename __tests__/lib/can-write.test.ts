import { describe, it, expect } from "vitest";
import { canWrite } from "@/lib/can-write";

describe("canWrite", () => {
  it("allows the general-write roles", () => {
    for (const role of ["SUPER_ADMIN", "ADMIN", "ORGANIZER"]) {
      expect(canWrite(role)).toBe(true);
    }
  });

  it("blocks read-only / restricted roles (incl. MEMBER + ONSITE)", () => {
    // MEMBER + ONSITE may do narrow registration-desk writes via their own
    // role checks, but NOT general management writes — so canWrite is false.
    for (const role of ["MEMBER", "ONSITE", "REVIEWER", "SUBMITTER", "REGISTRANT"]) {
      expect(canWrite(role)).toBe(false);
    }
  });

  it("fails closed on null / undefined / unknown", () => {
    expect(canWrite(null)).toBe(false);
    expect(canWrite(undefined)).toBe(false);
    expect(canWrite("WHATEVER")).toBe(false);
  });
});
