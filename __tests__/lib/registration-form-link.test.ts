import { describe, it, expect } from "vitest";
import {
  parseRegistrationFormIdentifier,
  registrationFormIdentifier,
  registrationFormIdentifierPrefixes,
} from "@/lib/registration-form-link";
import { parseLinkExpiryInput } from "@/lib/link-expiry";

describe("registration form link identifier", () => {
  it("round-trips a rate and complimentary", () => {
    const id = registrationFormIdentifier("reg_1", { kind: "rate", slug: "Early Bird" });
    expect(id).toBe("regform:reg_1:early-bird");
    expect(parseRegistrationFormIdentifier(id)).toEqual({ registrationId: "reg_1", rate: { kind: "rate", slug: "early-bird" } });
    expect(parseRegistrationFormIdentifier(registrationFormIdentifier("reg_1", { kind: "complimentary" }))).toEqual({
      registrationId: "reg_1",
      rate: { kind: "complimentary" },
    });
  });

  it("a rate actually named Complimentary stays an ordinary rate (review L6)", () => {
    const id = registrationFormIdentifier("reg_1", { kind: "rate", slug: "Complimentary" });
    expect(parseRegistrationFormIdentifier(id)).toEqual({ registrationId: "reg_1", rate: { kind: "rate", slug: "complimentary" } });
  });

  it("still reads the older reg:<id> links, with no rate", () => {
    expect(parseRegistrationFormIdentifier("reg:reg_1")).toEqual({ registrationId: "reg_1", rate: null });
  });

  it("refuses other token types and malformed values", () => {
    for (const bad of ["survey:reg_1", "regform:reg_1", "regform::early-bird", "regform:reg_1:", "reg:", ""]) {
      expect(parseRegistrationFormIdentifier(bad)).toBeNull();
    }
  });

  it("names both forms for revoking a person's earlier links", () => {
    expect(registrationFormIdentifierPrefixes("reg_1")).toEqual({ exact: "reg:reg_1", startsWith: "regform:reg_1:" });
  });
});

describe("link lifetime input", () => {
  it("accepts whole days from 1 to 365 and nothing else", () => {
    expect(parseLinkExpiryInput("30")).toBe(30);
    expect(parseLinkExpiryInput(" 10 ")).toBe(10);
    for (const bad of ["0", "366", "3.5", "-2", "1e2", "", "abc"]) expect(parseLinkExpiryInput(bad)).toBeNull();
  });
});
