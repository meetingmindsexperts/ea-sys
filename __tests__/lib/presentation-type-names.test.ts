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
 * What it cannot see: a name built at run time (`${key} Presentation`) or read
 * from somewhere else; the module's own functions are the only sanctioned way.
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

/**
 * Files about a DIFFERENT list that shares words with this one: a session's
 * own type (`SessionType`: Workshop, Symposium...) is not an abstract's
 * presentation type. Each entry carries its reason.
 */
const OTHER_LISTS: Record<string, string> = {
  "src/lib/session-enums.ts": "the agenda's session types (SessionType), whose WORKSHOP is a kind of session",
};

const FILES = [...sourceFiles("src"), ...sourceFiles("worker")].filter((f) => f !== RULE);

/** A type's name written as a string: what a screen, email or export would show after a rename. */
const NAME_LITERAL = /["'`](Oral or [Pp]oster(?: [Pp]resentation)?|(?:Oral|Poster|Video|Workshop) [Pp]resentation)["'`]/;
/** The either-way key spelled out: only the rule names it; others import EITHER_WAY_TYPE_KEY. */
const EITHER_WAY_KEY = /["'`]ORAL_POSTER["'`]/;
/** A list of the type keys (two or more of them in one array). */
const KEY_LIST = /\[[^\]]*["'`](?:ORAL|POSTER|VIDEO|WORKSHOP)["'`][^\]]*["'`](?:ORAL|POSTER|VIDEO|WORKSHOP)["'`][^\]]*\]/;
/**
 * The other shapes a second list takes (review of 89d803698): the enum read
 * directly (how the import route kept its own list), a union of the keys, a
 * name keyed by type (`{ ORAL: "Oral" }`), and a name written as JSX text.
 */
const OTHER_SHAPES: Array<[string, RegExp]> = [
  ["the Prisma enum read directly", /(?:nativeEnum|Object\.(?:values|keys|entries))\(\s*PresentationType\s*\)/],
  ["a union of the keys", /["'`](?:ORAL|POSTER|VIDEO|WORKSHOP|ORAL_POSTER)["'`]\s*\|(?!\|)/],
  ["a name keyed by type", /\b(?:ORAL|POSTER|VIDEO|WORKSHOP|ORAL_POSTER)\s*:\s*["'`]/],
  ["a name written as JSX text", />\s*(?:Oral|Poster|Video|Workshop)(?: [Pp]resentation| or [Pp]oster)\s*</],
];

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

  it("no other source file keeps the list in another shape: the enum, a union, a record of names, JSX text", () => {
    const hits = FILES.filter((f) => !(f in OTHER_LISTS)).flatMap((f) => {
      const text = code(f);
      return OTHER_SHAPES.filter(([, re]) => re.test(text)).map(([what]) => `${f}: ${what}`);
    });
    expect(hits).toEqual([]);
  });

  it("every file excused as another list still exists and still needs it", () => {
    for (const [file, reason] of Object.entries(OTHER_LISTS)) {
      expect(reason.length, file).toBeGreaterThan(20);
      expect(fs.existsSync(path.join(ROOT, file)), file).toBe(true);
      expect(OTHER_SHAPES.some(([, re]) => re.test(code(file))), `${file} no longer needs its entry`).toBe(true);
    }
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
    const shape = (text: string) => OTHER_SHAPES.filter(([, re]) => re.test(text)).map(([what]) => what);
    expect(shape("z.nativeEnum(PresentationType)")).toEqual(["the Prisma enum read directly"]);
    expect(shape("Object.values(PresentationType)")).toEqual(["the Prisma enum read directly"]);
    expect(shape('type T = "ORAL" | "POSTER";')).toEqual(["a union of the keys"]);
    expect(shape('if (a === "ORAL" || b) {}')).toEqual([]);
    expect(shape('const L = { ORAL: "Oral", POSTER: "Poster" };')).toEqual(["a name keyed by type"]);
    expect(shape("<SelectItem>Oral Presentation</SelectItem>")).toEqual(["a name written as JSX text"]);
    expect(shape("presentationType: POSTER_TYPE_KEY")).toEqual([]);
  });

  // Step 2 (Nov 24, 2026): the type is text; the enum columns beside it are
  // kept in step by a trigger for the PREVIOUS image only. Read by nothing.
  it("no source file reads or writes the old enum columns; only the client's omit list names them", () => {
    const LEGACY = /\b(?:presentationTypeLegacy|requestedPresentationTypeLegacy|recommendedFormatLegacy)\b/;
    // scripts/ and prisma/ too (review of 2729e1de3): a tsx script or a seed reads the same client.
    const prismaTs = fs.readdirSync(path.join(ROOT, "prisma")).filter((f) => /\.ts$/.test(f)).map((f) => `prisma/${f}`);
    const all = [...sourceFiles("src"), ...sourceFiles("worker"), ...sourceFiles("scripts"), ...prismaTs];
    expect(all.filter((f) => f !== "src/lib/db.ts" && LEGACY.test(code(f)))).toEqual([]);
    // Raw SQL naming the OLD physical columns reads the enum, which a db push database leaves empty.
    const RAW_OLD = /\$(?:queryRaw|executeRaw)(?:Unsafe)?[^;]*"(?:presentationType|requestedPresentationType|recommendedFormat)"/;
    expect(all.filter((f) => RAW_OLD.test(code(f)))).toEqual([]);
    const db = code("src/lib/db.ts");
    expect(db).toContain("abstract: { presentationTypeLegacy: true, requestedPresentationTypeLegacy: true }");
    expect(db).toContain("abstractReviewSubmission: { recommendedFormatLegacy: true }");
  });
});

