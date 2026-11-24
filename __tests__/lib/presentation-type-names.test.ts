/**
 * One list of presentation types, one name for each (Nov 24, 2026;
 * docs/ABSTRACT_PRESENTATION_TYPES_PLAN.md, step 1).
 *
 * Until this day the names lived in four files and had drifted ("Oral
 * Presentation", "Oral", "Oral presentation", "Oral or poster"), and three
 * routes each carried their own list of the five. With the list becoming the
 * organisation's, a second copy anywhere is a screen, email or export that
 * shows the old name after a rename, or a door that refuses the organisation's
 * own type. So: outside `src/lib/abstract-presentation-types.ts`, no source
 * file may spell a type's name as a string or list the type keys.
 *
 * Comments are not code: the check reads each file with its comments removed.
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(__dirname, "../..");
const RULE = "src/lib/abstract-presentation-types.ts";

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
    const rel = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sourceFiles(rel));
    else if (/\.(ts|tsx)$/.test(entry.name)) out.push(rel);
  }
  return out;
}

/** The file's text without its comments, so a comment may still explain the history. */
function code(file: string): string {
  return fs
    .readFileSync(path.join(ROOT, file), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:"'`])\/\/.*$/gm, "$1")
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "");
}

const FILES = [...sourceFiles("src"), ...sourceFiles("worker")].filter((f) => f !== RULE);

/** A type's name written as a string: what a screen, email or export would show after a rename. */
const NAME_LITERAL = /["'`](Oral or [Pp]oster(?: [Pp]resentation)?|(?:Oral|Poster|Video|Workshop) [Pp]resentation)["'`]/;
/** The either-way key spelled out: only the rule names it; others import EITHER_WAY_TYPE_KEY. */
const EITHER_WAY_KEY = /["'`]ORAL_POSTER["'`]/;
/** A list of the type keys (two or more of them in one array). */
const KEY_LIST = /\[[^\]]*["'`](?:ORAL|POSTER|VIDEO|WORKSHOP)["'`][^\]]*["'`](?:ORAL|POSTER|VIDEO|WORKSHOP)["'`][^\]]*\]/;

describe("presentation types: one list, one name each", () => {
  it("the rule module exists and holds the list", () => {
    const rule = fs.readFileSync(path.join(ROOT, RULE), "utf8");
    expect(rule).toContain("export const BUILT_IN_PRESENTATION_TYPE_KEYS");
    expect(rule).toContain("export function readPresentationTypes");
    expect(FILES.length).toBeGreaterThan(500);
  });

  it("no other source file writes a type's name as a string", () => {
    const hits = FILES.filter((f) => NAME_LITERAL.test(code(f)));
    expect(hits).toEqual([]);
  });

  it("no other source file spells the either-way key or lists the type keys", () => {
    const hits = FILES.filter((f) => {
      const text = code(f);
      return EITHER_WAY_KEY.test(text) || KEY_LIST.test(text);
    });
    expect(hits).toEqual([]);
  });

  it("the checks really catch what they are for", () => {
    expect(NAME_LITERAL.test('label: "Oral Presentation"')).toBe(true);
    expect(NAME_LITERAL.test('ORAL_POSTER: "Oral or poster",')).toBe(true);
    expect(EITHER_WAY_KEY.test('{ value: "ORAL_POSTER" }')).toBe(true);
    expect(KEY_LIST.test('z.enum(["ORAL", "POSTER", "VIDEO"])')).toBe(true);
    expect(KEY_LIST.test('presentationType: "POSTER"')).toBe(false);
  });
});
