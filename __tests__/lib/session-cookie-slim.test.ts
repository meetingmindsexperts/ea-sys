/**
 * The session cookie rides every request, and on Sep 30, 2026 its size broke the
 * sidebar for a user (INC-006: the Set-Cookie on /api/auth/session outgrew
 * nginx's header buffer). The organisation logo and colour were carried in it
 * and read by nothing, so they left the token. Source assertions, because the
 * point is that nobody quietly puts them back.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

const read = (p: string) => readFileSync(p, "utf8");

describe("session cookie carries no org branding", () => {
  it("auth.ts never writes the logo or colour into the token", () => {
    const src = read("src/lib/auth.ts");
    expect(src).not.toMatch(/token\.organization(Logo|PrimaryColor)\s*=/);
    expect(src).not.toMatch(/organization(Logo|PrimaryColor):\s*user\./);
  });

  it("auth.ts strips them from tokens issued before, so live sessions shrink", () => {
    const src = read("src/lib/auth.ts");
    expect(src).toContain("delete token.organizationLogo;");
    expect(src).toContain("delete token.organizationPrimaryColor;");
  });

  it("the session callback no longer maps them", () => {
    expect(read("src/lib/auth.config.ts")).not.toMatch(/organization(Logo|PrimaryColor)/);
  });
});
