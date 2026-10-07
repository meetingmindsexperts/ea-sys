/**
 * Phase 6 review H3 (Oct 7, 2026). Both agent doors judge an event-bound tool
 * call on its `eventId` (the gate), then hand that same id to the executor as
 * `ctx.eventId`. An executor that then loads a record by
 * `{ id, event: { organizationId } }` acts on whichever event the record is
 * in, so a grant scoped to webinars (a custom role or a role-bound API key)
 * could cancel conference registrations or edit a conference speaker.
 *
 * The rule pinned here: wherever an executor scopes a row by its event's
 * organisation, it also binds the row to `ctx.eventId`.
 */
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

const DIR = path.join(process.cwd(), "src/lib/agent/tools");
const ORG_ONLY = "event: { organizationId: ctx.organizationId }";

describe("agent tool executors stay on the gated event", () => {
  const files = readdirSync(DIR).filter((f) => f.endsWith(".ts"));

  it("finds the tool files", () => {
    expect(files.length).toBeGreaterThan(10);
  });

  for (const file of files) {
    it(`${file}: every org-scoped row lookup is also bound to ctx.eventId`, () => {
      const lines = readFileSync(path.join(DIR, file), "utf8").split("\n");
      const unbound: string[] = [];
      lines.forEach((line, i) => {
        if (!line.includes(ORG_ONLY)) return;
        const window = [lines[i - 1] ?? "", line].join("\n");
        if (!window.includes("eventId: ctx.eventId")) unbound.push(`${file}:${i + 1}: ${line.trim()}`);
      });
      expect(unbound, "bind the lookup with eventId: ctx.eventId").toEqual([]);
    });
  }
});
