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
  it("makes none of the template's claims", () => {
    for (const claim of ["Free Trial", "Free Account", "Get Started", "Made Simple", "sell tickets", "Accommodation", "Why choose"]) {
      expect(body).not.toContain(claim);
    }
  });

  it("offers the two doors that exist, the catalogue and sign-in, and no sign-up button", () => {
    const links = [...body.matchAll(/href="([^"]+)"/g)].map((m) => m[1]);
    expect(new Set(links)).toEqual(new Set(["/login", "/catalogue"]));
    expect(links.filter((l) => l === "/catalogue").length).toBe(3);
  });

  it("names the attendee-facing brand it was given, never one written here", () => {
    expect(page).toContain("loadPublicBrandForHost");
    expect(body).not.toMatch(/Meeting Minds|MM Group|EventsHub/);
  });

  it("still sends a signed-in person to their own home", () => {
    expect(body).toContain('redirect("/dashboard")');
  });
});
