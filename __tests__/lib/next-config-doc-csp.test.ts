/**
 * Shared doc links carry a no-script CSP (Sep 25, 2026). The route sets one,
 * but next.config's global header REPLACES a route's header of the same name
 * (the last matching rule wins), so the route's policy never reached the
 * browser until a dedicated rule was added after the global one. Public doc
 * links made that matter: a committed <script> must not run on our origin.
 */
import { describe, it, expect } from "vitest";
import nextConfig from "../../next.config";

describe("next.config headers for shared doc links", () => {
  it("gives /admin/docs/<path> the no-script policy, after the global rule so it wins", async () => {
    const rules = await nextConfig.headers!();
    const globalIdx = rules.findIndex((r) => r.source === "/(.*)");
    const docIdx = rules.findIndex((r) => r.source === "/admin/docs/:path+");
    expect(globalIdx).toBeGreaterThanOrEqual(0);
    expect(docIdx).toBeGreaterThan(globalIdx);
    const csp = rules[docIdx].headers.find((h) => h.key === "Content-Security-Policy")?.value ?? "";
    expect(csp).toContain("default-src 'none'");
    expect(csp).not.toContain("script-src");
    expect(csp).toContain("frame-ancestors 'self'");
  });

  it("matches one or more segments only, so the viewer page /admin/docs keeps its scripts", async () => {
    const rules = await nextConfig.headers!();
    expect(rules.some((r) => r.source === "/admin/docs/:path*" || r.source === "/admin/docs")).toBe(false);
  });
});
