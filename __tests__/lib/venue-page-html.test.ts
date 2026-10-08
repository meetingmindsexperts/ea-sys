/**
 * The EHC online venue exists three times: the vendor source
 * (vendor/ehc-venue/src), its build (dist/index.html) and the copy the server
 * serves (page-html.generated.json). These pin all three together, so an edit
 * to src/ that skipped `npm run venue:build` fails CI instead of shipping the
 * old page. The join is build.py's (and the Node builder's), restated.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import venuePage from "@/lib/venue/page-html.generated.json";

const VENDOR = path.join(process.cwd(), "vendor/ehc-venue");
const src = (f: string) => readFileSync(path.join(VENDOR, "src", f), "utf8");
const ORDER = ["engine", "textures", "world", "chars", "physics", "audio", "filter", "social", "abilities", "team", "game"];

describe("EHC venue page build", () => {
  it("dist/index.html is the join of src/ in build.py's order", () => {
    const page = src("shell.html") + "\n<script>\n" + ORDER.map((n) => src(`${n}.js`)).join("\n") + "\n</script>\n";
    expect(readFileSync(path.join(VENDOR, "dist/index.html"), "utf8")).toBe(page);
  });

  it("the served copy is dist/index.html (npm run venue:build was run)", () => {
    expect(venuePage.html).toBe(readFileSync(path.join(VENDOR, "dist/index.html"), "utf8"));
  });

  it("takes the event's name, dates and venue from EA-SYS, and its fonts from our server", () => {
    expect(venuePage.html).toContain("window.EHC_EVENT");
    expect(venuePage.html).not.toMatch(/fonts\.(googleapis|gstatic)\.com/);
    expect(venuePage.html).toContain('href="/venue-fonts/fonts.css"');
    // The only hard-coded copies left are the defaults in world.js's EVENT object.
    expect(venuePage.html.split("4 September 2026").length - 1).toBe(1);
  });
});
