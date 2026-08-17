import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import authConfig, { SESSION_CONFIG } from "@/lib/auth.config";

/**
 * Two NextAuth instances share one cookie.
 *
 * `auth.ts` builds the Node instance (the app, /api/auth/session). `proxy.ts`
 * builds an Edge one from `auth.config.ts` for middleware RBAC. Both read and
 * RE-ISSUE the same session cookie, so whichever writes last decides the
 * session's lifetime.
 *
 * Until Aug 17 2026 only `auth.ts` declared `maxAge`. `auth.config.ts` was
 * silent, and a silent config does not inherit its sibling. It takes
 * NextAuth's default of 30 days. Middleware runs on every dashboard route, so
 * the 24h idle timeout the docs promised was never in force: an account whose
 * last sign-in was Aug 7 was still authenticated on Aug 17.
 *
 * The fix is structural: ONE exported constant, consumed by both, so the two
 * cannot hold different numbers. What is left to guard is someone re-inlining a
 * `maxAge` later and quietly recreating the split, which the source assertions
 * below catch. That is the whole point of this file; the value assertions are
 * the cheap part.
 */
describe("session config is shared by both NextAuth instances", () => {
  /**
   * Read a source file with comments stripped. The guard is about CODE. A
   * comment explaining why `maxAge` lives in one place must not fail the build
   * for mentioning it. Same reasoning as scripts/check-tenant-als.sh.
   */
  const read = (rel: string) =>
    readFileSync(join(process.cwd(), rel), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/(^|[^:])\/\/.*$/gm, "$1");

  it("declares a 48h rolling JWT session", () => {
    expect(SESSION_CONFIG.strategy).toBe("jwt");
    expect(SESSION_CONFIG.maxAge).toBe(48 * 60 * 60);
  });

  it("is the session the Edge instance actually uses", () => {
    // proxy.ts does NextAuth(authConfig); if this key is dropped from the
    // default export, the Edge instance silently reverts to 30 days.
    expect(authConfig.session).toBe(SESSION_CONFIG);
  });

  it("is not re-inlined in auth.ts", () => {
    // auth.ts must consume the shared constant, never write its own number.
    const src = read("src/lib/auth.ts");
    expect(src).toContain("session: SESSION_CONFIG");
    expect(src).not.toMatch(/maxAge\s*:/);
  });

  it("is declared exactly once in auth.config.ts", () => {
    // A second maxAge here would mean the constant has a competitor again.
    const src = read("src/lib/auth.config.ts");
    expect(src.match(/maxAge\s*:/g) ?? []).toHaveLength(1);
  });

  it("is not declared independently in the middleware", () => {
    // proxy.ts must inherit from authConfig rather than pass its own session.
    const src = read("src/proxy.ts");
    expect(src).toContain("NextAuth(authConfig)");
    expect(src).not.toMatch(/maxAge\s*:/);
  });
});
