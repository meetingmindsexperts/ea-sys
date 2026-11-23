/**
 * The home page says only what is true (owner, Nov 23, 2026: "we never edited
 * the index page"). It was the January 2026 starter template: a free trial, a
 * free account and a "Get Started" button on a platform whose staff accounts
 * are made by invitation. Pinned on the source: the page is a server component
 * that reads the session and the host.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const page = readFileSync(join(process.cwd(), "src/app/page.tsx"), "utf8");
/** The page without its header comment, which quotes the old words. */
const body = page.slice(page.indexOf("const FEATURES"));

describe("the home page", () => {
  it("makes none of the template's claims, in any letter case", () => {
    const words = body.toLowerCase();
    for (const claim of ["free trial", "free account", "get started", "made simple", "sell tickets", "accommodation", "why choose"]) {
      expect(words).not.toContain(claim);
    }
  });

  // The owner asked for these two. Sign-up exists (/signup, reached from the
  // sign-in page and the catalogue); it is only not offered from here.
  it("links to the catalogue and to sign-in, and to no sign-up", () => {
    // Every href, however it is written: href="...", href={"..."} or href={`...`}.
    const links = [...body.matchAll(/href=\{?["'`]([^"'`]+)["'`]/g)].map((m) => m[1]);
    expect(links).toContain("/catalogue");
    expect(links).toContain("/login");
    expect(links.filter((l) => /register|signup/i.test(l))).toEqual([]);
    // And none written in a way this reader cannot see.
    expect((body.match(/href=/g) ?? []).length).toBe(links.length);
  });

  it("names the attendee-facing brand it was given, never one written here", () => {
    expect(page).toContain("loadPublicBrandForHost");
    expect(body).not.toMatch(/Meeting Minds|MM Group|EventsHub/);
    expect(body).toContain("alt={brand.name}");
  });

  it("sends a signed-in person to their own home before anything is drawn", () => {
    const home = body.slice(body.indexOf("export default async function Home"));
    expect(home).toMatch(/if \(session\?\.user\) \{\s*redirect\("\/dashboard"\);\s*\}/);
    expect(home.indexOf('redirect("/dashboard")')).toBeLessThan(home.indexOf("return ("));
  });
});
