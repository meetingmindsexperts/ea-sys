import { describe, it, expect } from "vitest";
import { z } from "zod";
import { parseEmailList } from "@/lib/email-address-list";

describe("parseEmailList", () => {
  it("splits on commas, semicolons and spaces, lowercases and dedupes", () => {
    expect(parseEmailList(" A@x.com, b@y.com;c@z.com  a@X.com ")).toEqual({
      valid: ["a@x.com", "b@y.com", "c@z.com"],
      invalid: [],
    });
  });

  it("reports what is not an address", () => {
    expect(parseEmailList("a@x.com, nope, b@")).toEqual({ valid: ["a@x.com"], invalid: ["nope", "b@"] });
  });

  it("is empty for an empty field", () => {
    expect(parseEmailList("   ")).toEqual({ valid: [], invalid: [] });
  });

  it("agrees with the server's rule on every borderline address", () => {
    for (const candidate of ["a@b.c", "x@y.co", "first.last+tag@sub.example.org", "a@@b.com", "a@b"]) {
      const server = z.string().email().safeParse(candidate).success;
      expect(parseEmailList(candidate).valid.length === 1).toBe(server);
    }
  });
});
