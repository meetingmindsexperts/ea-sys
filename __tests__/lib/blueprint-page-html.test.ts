/**
 * The Event Blueprint page exists three times: the vendor source
 * (vendor/event-blueprint/src), its build (dist/index.html) and the module the
 * server serves (page-html.generated.json). These pin all three together, so an
 * edit to src/ that skipped `node scripts/blueprint-build.mjs` fails CI rather
 * than shipping the old page. The join is build.py's, restated, which is
 * also what the Node builder (`npm run blueprint:build -- --node`) runs, so
 * this proves the two builders agree.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import blueprintPage from "@/lib/blueprint/page-html.generated.json";

const BLUEPRINT_PAGE_HTML = blueprintPage.html;

const VENDOR = path.join(process.cwd(), "vendor/event-blueprint");
const src = (f: string) => readFileSync(path.join(VENDOR, "src", f), "utf8");

describe("Event Blueprint page build", () => {
  it("dist/index.html is the join of src/ (python3 build.py was run)", () => {
    const js = ["data.js", "bench.js", "platform.js", "app.js"].map(src).join("\n");
    const page = src("part1.html") + "\n<script>\n" + js + "\n</script>\n";
    expect(readFileSync(path.join(VENDOR, "dist/index.html"), "utf8")).toBe(page);
  });

  it("the served module is dist/index.html (scripts/blueprint-build.mjs was run)", () => {
    expect(BLUEPRINT_PAGE_HTML).toBe(readFileSync(path.join(VENDOR, "dist/index.html"), "utf8"));
  });

  it("the page still reads the backend switch the server injects", () => {
    expect(BLUEPRINT_PAGE_HTML).toContain("window.EVENT_BLUEPRINT_BACKEND");
  });

  it("loads its fonts from our own server, never from Google", () => {
    expect(BLUEPRINT_PAGE_HTML).not.toMatch(/fonts\.(googleapis|gstatic)\.com/);
    expect(BLUEPRINT_PAGE_HTML).toContain('href="/blueprint-fonts/fonts.css"');
    for (const f of ["geist-latin", "geist-mono-latin"]) {
      expect(readFileSync(path.join(process.cwd(), "public/blueprint-fonts", `${f}.woff2`)).subarray(0, 4).toString()).toBe("wOF2");
    }
  });
});
