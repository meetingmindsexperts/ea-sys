/**
 * The Blueprint's AI prompts live on the server (plan §4.6). Pins: the option
 * lists are the vendor's own (regenerated, never hand-copied), each task's
 * input is capped, the tier follows the vendor's rule, and the page's data
 * lands in the prompt only as data.
 */
import { describe, it, expect } from "vitest";
import vm from "node:vm";
import { readFileSync } from "node:fs";
import path from "node:path";
import { BLUEPRINT_CATALOGS } from "@/lib/blueprint/catalogs.generated";
import { TASK_INPUT, buildPrompt, tierFor } from "@/lib/blueprint/ai-tasks";

describe("catalogs.generated.ts", () => {
  it("equals the lists in the vendor's data.js and bench.js (npm run blueprint:build was run)", () => {
    const src = ["data.js", "bench.js"].map((f) => readFileSync(path.join(process.cwd(), "vendor/event-blueprint/src", f), "utf8")).join("\n");
    const fresh = vm.runInNewContext(
      `${src}\n;({ TYPES: TYPES.map((t) => ({ id: t.id, n: t.n })), FORMATS, GOALS, MOODS, LANGS, LOOKS, SETTINGS, FEATURES, ACCESS, REGULATED, LAYOUT_NAMES })`,
      {},
    );
    expect(JSON.parse(JSON.stringify(fresh))).toEqual(BLUEPRINT_CATALOGS);
  });
});

describe("TASK_INPUT", () => {
  it("caps the organiser's words and the document text", () => {
    expect(TASK_INPUT.quickfill.safeParse({ words: "x".repeat(20001) }).success).toBe(false);
    expect(TASK_INPUT.quickfill.safeParse({ docText: "x".repeat(60001) }).success).toBe(false);
    expect(TASK_INPUT.quickfill.safeParse({ words: "a gala" }).success).toBe(true);
  });

  it("caps a brief at 32 KB and the space list at 60 names", () => {
    expect(TASK_INPUT.spaces.safeParse({ brief: { notes: "x".repeat(33 * 1024) } }).success).toBe(false);
    expect(TASK_INPUT.programme.safeParse({ brief: {}, spaceNames: Array(61).fill("Hall") }).success).toBe(false);
  });

  it("refuses a missing brief", () => {
    expect(TASK_INPUT.concepts.safeParse({}).success).toBe(false);
  });
});

describe("tierFor", () => {
  it.each([
    ["concepts", {}, 0, "default"],
    ["spaces", {}, 0, "quick"],
    ["quickfill", { words: "short" }, 0, "quick"],
    ["quickfill", { words: "x".repeat(4001) }, 0, "default"],
    ["quickfill", { words: "plan" }, 1, "default"],
  ] as const)("%s %j with %i images -> %s", (task, input, images, tier) => {
    expect(tierFor(task, input, images)).toBe(tier);
  });
});

describe("buildPrompt", () => {
  it("names the vendor's option lists in the quick-fill prompt", () => {
    const p = buildPrompt("quickfill", { words: "A gala for 400", docText: "", fileName: "" }, 0);
    expect(p).toContain("type: summit (Corporate conference or summit);");
    expect(p).toContain(BLUEPRINT_CATALOGS.LAYOUT_NAMES.join(" | "));
    expect(p).toContain('The organiser\'s own words:\n"""A gala for 400"""');
    expect(p).not.toContain("The attached picture");
  });

  it("mentions the picture only when one is attached", () => {
    expect(buildPrompt("quickfill", { words: "", docText: "", fileName: "plan.png" }, 1)).toContain('The attached picture "plan.png"');
  });

  it("embeds the brief as JSON and the space names for the run of show", () => {
    const p = buildPrompt("programme", { brief: { basics: { title: "Summit" } }, spaceNames: ["Hall A"] }, 0);
    expect(p).toContain('using only these spaces: ["Hall A"]');
    expect(p).toContain('Brief (JSON): {"basics":{"title":"Summit"}}');
  });
});
