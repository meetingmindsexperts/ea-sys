import fs from "node:fs";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { RLS_SERVER_LOG } from "./rls-env";

/**
 * What the test server said while the suite and the crawl ran against it.
 *
 * Under row security the failures that matter do not fail a request:
 *   - a WRITE the policy refuses is often fire-and-forget (a notice, a seed of
 *     templates): the route answers 200 and only the log says the row was not
 *     written. That is how an unstamped template seed was found on Nov 17, 2026.
 *   - a READ outside a lane returns nothing, and the detector names it.
 * So this runs last and reads the log. It is the assertion of the whole run.
 */

const REFUSED_WRITE = "violates row-level security";
const READ_OUTSIDE_A_LANE = "tenant:event-query-no-lane";
const PERMISSION_DENIED = /permission denied for (?:table|relation|schema|sequence) "?(\w+)"?/;

test("the server log holds no refused write and no Event read outside a lane", async () => {
  const file = path.resolve(process.cwd(), RLS_SERVER_LOG);
  expect(fs.existsSync(file), `${RLS_SERVER_LOG} exists`).toBe(true);
  const lines = fs.readFileSync(file, "utf8").split("\n");
  expect(lines.length, "the server logged something (an empty log would pass every check below)").toBeGreaterThan(50);

  const sample = (needle: string) => lines.filter((l) => l.includes(needle)).slice(0, 5).map((l) => l.slice(0, 400));
  const refused = lines.filter((l) => l.includes(REFUSED_WRITE)).length;
  const noLane = lines.filter((l) => l.includes(READ_OUTSIDE_A_LANE)).length;

  // The restricted role refused outright on an object (Postgres 42501): a
  // missing grant, or code that needs the owner. Counted per object.
  const denied: Record<string, number> = {};
  for (const line of lines) {
    const match = PERMISSION_DENIED.exec(line);
    if (match) denied[match[1]] = (denied[match[1]] ?? 0) + 1;
  }

  console.log(`[e2e:rls] server log: ${lines.length} lines, ${refused} refused writes, ${noLane} Event reads outside a lane, permission denied: ${JSON.stringify(denied)}`);
  expect(sample(REFUSED_WRITE), "writes refused by a row policy").toEqual([]);
  expect(sample(READ_OUTSIDE_A_LANE), "Event reads made outside a tenant lane").toEqual([]);
  expect(denied, "objects the restricted role was refused on").toEqual({});
});
