/**
 * The venue's browser suite (vendor/ehc-venue/tests/test_layout.py) walks the
 * layouts in tests/fixtures/layouts/. They must be what the generator makes
 * today, or the suite would be checking an old building: run
 * `npm run venue:fixtures` after changing src/lib/venue/layout.ts or plan-layout.ts.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { LAYOUT_FIXTURES, PLAN_FIXTURES } from "@/lib/venue/layout-fixtures";
import { planIssues } from "@/lib/venue/plan";
import { layoutFromPlan } from "@/lib/venue/plan-layout";
import { generateLayout } from "@/lib/venue/layout";
import { checkLayout } from "@/lib/venue/layout-check";
import { roomsSchema } from "@/lib/venue/rooms";

const DIR = path.join(process.cwd(), "vendor/ehc-venue/tests/fixtures/layouts");

describe("venue layout fixtures", () => {
  it("there is one file per fixture and no strays", () => {
    expect(readdirSync(DIR).filter((f) => f.endsWith(".json")).sort()).toEqual([...Object.keys(LAYOUT_FIXTURES), ...Object.keys(PLAN_FIXTURES)].map((n) => `${n}.json`).sort());
  });

  it.each(Object.entries(LAYOUT_FIXTURES))("%s is a valid room list, walkable, and its file is current (npm run venue:fixtures)", (name, rooms) => {
    expect(roomsSchema.safeParse(rooms).success).toBe(true);
    const layout = generateLayout(rooms, { eventName: "Test Congress 2027" });
    expect(checkLayout(layout).issues).toEqual([]);
    expect(JSON.parse(readFileSync(path.join(DIR, `${name}.json`), "utf8"))).toEqual(layout);
  });

  it.each(Object.entries(PLAN_FIXTURES))("drawn plan %s is a plan the save would accept, and its file is current (npm run venue:fixtures)", (name, { rooms, plan }) => {
    expect(planIssues(rooms, plan)).toEqual([]);
    const built = layoutFromPlan(rooms, plan, { eventName: "Test Congress 2027" });
    expect(built.issues).toEqual([]);
    expect(checkLayout(built.layout).issues).toEqual([]);
    expect(JSON.parse(readFileSync(path.join(DIR, `${name}.json`), "utf8"))).toEqual(built.layout);
  });
});
