/**
 * The password-reset return target (Sep 29, 2026). It ends in a redirect, so
 * only the two signup pages are ever accepted; everything else is the event
 * login, as before.
 */
import { describe, it, expect } from "vitest";
import { parseSubmitterReturn, signInPathAfterReset } from "@/lib/submitter-return";

describe("parseSubmitterReturn", () => {
  it("accepts exactly abstract and proposal", () => {
    expect(parseSubmitterReturn("abstract")).toBe("abstract");
    expect(parseSubmitterReturn("proposal")).toBe("proposal");
  });

  it("rejects everything else, including paths and URLs", () => {
    for (const v of [null, undefined, "", "Abstract", "login", "/admin", "https://evil.example", "abstract/../x"]) {
      expect(parseSubmitterReturn(v)).toBeNull();
    }
  });
});

describe("signInPathAfterReset", () => {
  it("returns to the signup page the reset started on", () => {
    expect(signInPathAfterReset("MEHF2027", "abstract")).toBe("/e/MEHF2027/abstract/register");
    expect(signInPathAfterReset("MEHF2027", "proposal")).toBe("/e/MEHF2027/proposal/register");
  });

  it("falls back to the event login", () => {
    expect(signInPathAfterReset("MEHF2027", null)).toBe("/e/MEHF2027/login");
  });
});
