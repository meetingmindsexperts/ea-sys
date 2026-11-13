import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

/**
 * Step 0b of docs/ORG_FIELDS_PLAN.md, finished (Nov 13, 2026): no caller of
 * the contact sync types its payload by hand.
 *
 * Until then each of 19 calls listed the fields itself and one sent them all:
 * the registrations CSV import never sent Role (2,665 contacts on production
 * had none although their registration did), a staff edit sent "Faculty" as
 * the contact's category, a self-edit re-sent an old photo. A call now builds
 * its payload with a `contactSyncFrom...` builder, which reads the field list
 * from one place, or it is named below with the reason it does not.
 *
 * A new caller fails here until it uses a builder or is added with a reason.
 */

const ROOTS = ["src", "worker"];

/** Calls that deliberately send a hand-written payload: how many per file, and why. */
const BY_HAND: Record<string, { calls: number; why: string }> = {
  "src/app/api/public/events/[slug]/verify-details/route.ts": {
    calls: 1,
    why: "sends only the evidence values the form submitted; the row write is fill-if-empty, so the row can differ from them",
  },
  "src/app/api/events/[eventId]/reviewers/route.ts": {
    calls: 1,
    why: "a reviewer invited by email has no row behind them: name, email and the event",
  },
};

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name.startsWith(".")) continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) sourceFiles(full, out);
    else if (/\.tsx?$/.test(name)) out.push(full);
  }
  return out;
}

/** The text between a call's parentheses, by counting brackets. */
function argumentOf(source: string, openParenAt: number): string {
  let depth = 1;
  let i = openParenAt + 1;
  for (; i < source.length && depth > 0; i++) {
    const ch = source[i];
    if (ch === "(" || ch === "{" || ch === "[") depth++;
    else if (ch === ")" || ch === "}" || ch === "]") depth--;
  }
  return source.slice(openParenAt + 1, i - 1);
}

interface Call { file: string; line: number; usesBuilder: boolean }

function contactSyncCalls(): Call[] {
  const calls: Call[] = [];
  for (const root of ROOTS) {
    for (const full of sourceFiles(join(process.cwd(), root))) {
      const file = relative(process.cwd(), full);
      if (file === "src/lib/contact-sync.ts") continue; // the sync itself
      const source = readFileSync(full, "utf8");
      for (const m of source.matchAll(/\b(?:syncToContact|syncManyToContacts)\(/g)) {
        const lineStart = source.lastIndexOf("\n", m.index) + 1;
        const before = source.slice(lineStart, m.index);
        if (/^\s*(\/\/|\*|\/\*)/.test(before)) continue; // a mention in a comment
        const argument = argumentOf(source, m.index + m[0].length - 1);
        if (!argument.trim()) continue; // `syncToContact()` named in prose
        // A builder somewhere inside is not enough: `{ ...builder(row), role: x }`
        // is a hand-written payload again. The argument itself must be the
        // builder call, or (for the batch) a map whose result is one.
        const bare = argument.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, "").trim();
        const usesBuilder = /^contactSyncFrom\w+\(/.test(bare) || /^\w+\.map\(\(\w+\) => contactSyncFrom\w+\(/.test(bare);
        calls.push({ file, line: source.slice(0, m.index).split("\n").length, usesBuilder });
      }
    }
  }
  return calls;
}

describe("callers of the contact sync", () => {
  const calls = contactSyncCalls();

  it("finds the calls (the scan is not silently empty)", () => {
    expect(calls.length).toBeGreaterThanOrEqual(15);
  });

  it("every call builds its payload with a builder, or is named with its reason", () => {
    const perFile = new Map<string, Call[]>();
    for (const c of calls.filter((x) => !x.usesBuilder)) perFile.set(c.file, [...(perFile.get(c.file) ?? []), c]);
    // A file named below may hold exactly the number of hand-written calls it
    // is named for: one more in the same file fails too.
    const byHand = [...perFile.entries()]
      .filter(([file, found]) => found.length !== (BY_HAND[file]?.calls ?? 0))
      .flatMap(([, found]) => found.map((c) => `${c.file}:${c.line}`));
    // If this fails you added a contact sync that lists its fields by hand.
    // Build the payload with contactSyncFromAttendee / contactSyncFromSpeaker
    // (src/lib/contact-sync-payload.ts): a hand list is how a field gets left
    // out without anyone noticing.
    expect(byHand).toEqual([]);
  });

  it("no exception names a file that no longer syncs by hand", () => {
    const stillByHand = new Set(calls.filter((c) => !c.usesBuilder).map((c) => c.file));
    expect(Object.keys(BY_HAND).filter((file) => !stillByHand.has(file))).toEqual([]);
  });
});
