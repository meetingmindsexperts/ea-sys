import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

/**
 * Source pin on next.config.ts. The config is wrapped in withSentryConfig and
 * read at build time, so this test reads the file rather than importing it:
 * what matters is that the declarations stay in the file, because the build
 * turns them into routes-manifest.json headers and the runtime emits them on
 * every response (verified with an unfiltered curl -D - on production,
 * Sep 18, 2026).
 */
const source = readFileSync(path.join(process.cwd(), "next.config.ts"), "utf8");

describe("next.config.ts security headers", () => {
  it("does not advertise the framework (poweredByHeader is off)", () => {
    expect(source).toMatch(/poweredByHeader:\s*false/);
  });

  it("declares the six response headers on every route", () => {
    const rule = source.slice(source.indexOf('source: "/(.*)"'), source.indexOf("/e/:slug/session/:path*"));
    for (const key of [
      "X-Frame-Options",
      "Content-Security-Policy",
      "X-Content-Type-Options",
      "Strict-Transport-Security",
      "Referrer-Policy",
      "Permissions-Policy",
    ]) {
      expect(rule, key).toContain(`key: "${key}"`);
    }
  });

  it("keeps HSTS long-lived with subdomains and preload", () => {
    expect(source).toMatch(/Strict-Transport-Security", value: "max-age=63072000; includeSubDomains; preload"/);
  });
});
