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

describe("session cookie carries no permission keys (custom roles Phase 1 slice 3)", () => {
  it("auth.ts never writes the key list into the token, only the held roles", () => {
    const src = read("src/lib/auth.ts");
    expect(src).not.toMatch(/token\.procurementPermissions\s*=/);
    expect(src).toMatch(/token\.heldRoles = /);
  });

  it("auth.ts strips the key list from tokens issued before, after every assignment", () => {
    const src = read("src/lib/auth.ts");
    const strip = src.indexOf("delete token.procurementPermissions;");
    expect(strip).toBeGreaterThan(-1);
    expect(strip).toBeGreaterThan(src.lastIndexOf("Object.assign(token, procurementGrantsFromRow"));
  });

  it("the shared mapper does not map the keys; the Node session callback resolves them", () => {
    expect(read("src/lib/auth.config.ts")).not.toMatch(/session\.user\.procurementPermissions\s*=/);
    expect(read("src/lib/auth.ts")).toMatch(/procurementPermissions = await permissionsForHeldSets\(/);
  });

  it("warns when the cookie grows past the threshold (ROADMAP option 4)", () => {
    expect(read("src/lib/auth.ts")).toContain('msg: "auth:session-cookie-large"');
  });
});
