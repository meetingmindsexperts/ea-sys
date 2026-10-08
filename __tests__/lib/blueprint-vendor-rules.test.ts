/**
 * The server runs the vendor's own rules (sanitise, score, parseWhen) from
 * vendor-rules.generated.json. Pins that the file is current with the vendor
 * source, and the behaviour approval depends on.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import rules from "@/lib/blueprint/vendor-rules.generated.json";
import { readWhen, scoreBlueprint } from "@/lib/blueprint/vendor-rules";

describe("vendor-rules.generated.json", () => {
  it("is the current slice of the vendor's data.js, bench.js and app.js (npm run blueprint:build was run)", () => {
    const src = (f: string) => readFileSync(path.join(process.cwd(), "vendor/event-blueprint/src", f), "utf8");
    const app = src("app.js");
    const open = "(function () {\n";
    const slice = app.slice(app.indexOf(open) + open.length, app.indexOf("  // ---------- changes since the last submission ----------"));
    expect(rules.source).toBe(`${src("data.js")}\n${src("bench.js")}\n${slice}\n;({ sanitise, score, parseWhen })`);
  });
});

describe("scoreBlueprint", () => {
  it("lists what is still needed, in the page's words", () => {
    const s = scoreBlueprint({ basics: { title: "Summit" } });
    expect(s.blocking.map((b) => b.label)).toContain("Choose a format");
    expect(s.blocking.map((b) => b.label)).not.toContain("Working title");
  });

  it("repairs a stored object of the wrong shape instead of failing", () => {
    const s = scoreBlueprint({ spaces: "not a list", basics: 42 });
    expect(Array.isArray(s.data.spaces)).toBe(true);
    expect(typeof (s.data.basics as Record<string, unknown>).title).toBe("string");
  });
});

describe("readWhen", () => {
  it.each([
    ["4 March 2027", { y: 2027, m: 3, d: 4, approx: false }],
    ["2027-03-04", { y: 2027, m: 3, d: 4, approx: false }],
    ["March 2027", { approx: true }],
    ["spring 2027", { approx: true }],
  ])("%s", (text, expected) => {
    expect(readWhen(text)).toMatchObject(expected);
  });

  it("cannot read 'next year'", () => {
    expect(readWhen("next year")).toEqual({ invalid: true });
  });
});
