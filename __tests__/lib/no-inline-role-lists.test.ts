/**
 * Role membership is decided in NAMED predicates, never spelled out inline
 * (docs/CUSTOM_ROLES_PLAN.md Phase 0 step 9, Sep 30, 2026).
 *
 * Before this, {SUPER_ADMIN, ADMIN} and {SUPER_ADMIN, ADMIN, ORGANIZER} were
 * hand-written in ~45 places: routes, components, services and recipient
 * queries. Custom roles (Phase 1) replace role lists with permissions, and an
 * inline copy is exactly the place that sweep misses. So a new one fails here.
 *
 * Fix a failure by calling the predicate that already answers the question
 * (`isOrgAdmin`, `canWrite`, `denyNonOrgAdmin`, a `*-visibility` module) or,
 * if it is genuinely a new permission, by DEFINING a named constant in one of
 * the files below. Do not widen the allow-list to silence it.
 *
 * What the scan sees (each form has a probe below): an array literal with two
 * or more role names, across line breaks; two comparisons against role names
 * joined by || or &&, any variable name, either operand order, across line
 * breaks; one such comparison joined to an `is…Admin` helper; two `case`
 * labels in a row. What it does not see: a role name held in a variable and
 * compared later, or a list built with push. Comments are stripped first,
 * string literals are left intact (the role names live in them), and a `/*`
 * inside a string is not a comment.
 */
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

/**
 * STAFF roles only. Custom roles cover org staff (plan §1); REVIEWER, SUBMITTER
 * and REGISTRANT are outside identities whose checks route portals
 * (`role === "REVIEWER" || role === "SUBMITTER"` in proxy.ts) and stay fixed.
 */
const ROLE = `"(SUPER_ADMIN|ADMIN|ORGANIZER|MEMBER|ONSITE|WEBINARS|CRM_USER|HR_USER)"`;
const IDENT = String.raw`[\w$.?!]+`;
const CMP = String.raw`(?:${IDENT}\s*[!=]==\s*${ROLE}|${ROLE}\s*[!=]==\s*${IDENT})`;
const JOIN = String.raw`\s*(?:\|\||&&)\s*!?`;

const PATTERNS: { name: string; re: RegExp }[] = [
  { name: "array of roles", re: new RegExp(String.raw`\[\s*${ROLE}\s*,\s*${ROLE}`, "g") },
  { name: "joined comparisons", re: new RegExp(`${CMP}${JOIN}${CMP}`, "g") },
  { name: "comparison joined to an is…Admin helper", re: new RegExp(String.raw`(?:${CMP}${JOIN}is\w*Admin\b|\bis\w*Admin\b${JOIN}${CMP})`, "g") },
  { name: "consecutive case labels", re: new RegExp(String.raw`case\s+${ROLE}\s*:\s*case\s+${ROLE}`, "g") },
];

/**
 * Where named role sets are DEFINED. In these files a hit passes only on a
 * `const` / `export const` definition line, never on an inline use, so the
 * exemption covers the named predicate and nothing else in the file.
 */
// Phase 6 (Oct 6, 2026) deleted the role-predicate files; access is a
// permission now, and these are the account-type lists that remain.
const DEFINITION_FILES = new Set([
  "src/lib/team-roles.ts",
  "src/lib/auth-guards.ts",
  "src/lib/procurement-visibility.ts",
  // Who the assignable deal owners are: a population, not a permission.
  "src/app/api/crm/reps/route.ts",
]);

const ROOTS = ["src", "worker"];

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(ts|tsx)$/.test(name)) out.push(full);
  }
  return out;
}

/**
 * Removes // and block comments, leaving strings (and their contents) intact,
 * and keeps every newline so match offsets still map to line numbers.
 */
export function stripComments(src: string): string {
  let out = "";
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    const next = src[i + 1];
    if (c === '"' || c === "'" || c === "`") {
      const quote = c;
      let j = i + 1;
      while (j < src.length && src[j] !== quote) {
        if (src[j] === "\\") j++;
        else if (quote !== "`" && src[j] === "\n") break;
        j++;
      }
      out += src.slice(i, j + 1);
      i = j + 1;
      continue;
    }
    if (c === "/" && next === "/") {
      const end = src.indexOf("\n", i);
      i = end === -1 ? src.length : end;
      continue;
    }
    if (c === "/" && next === "*") {
      const end = src.indexOf("*/", i + 2);
      const stop = end === -1 ? src.length : end + 2;
      out += src.slice(i, stop).replace(/[^\n]/g, "");
      i = stop;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

function lineOf(text: string, index: number): number {
  let n = 1;
  for (let i = 0; i < index; i++) if (text[i] === "\n") n++;
  return n;
}

function lineText(text: string, index: number): string {
  const start = text.lastIndexOf("\n", index - 1) + 1;
  const end = text.indexOf("\n", index);
  return text.slice(start, end === -1 ? text.length : end);
}

/**
 * Two comparisons count as a list only when they test the SAME variable.
 * `callerRole === "ORGANIZER" && target.role !== "ONSITE"` relates two
 * people's roles; it is a rule, not a membership list.
 */
function sameVariable(match: string): boolean {
  const idents = match
    .replace(/"[A-Z_]+"/g, "")
    .split(/\s*(?:[!=]==|\|\||&&)\s*/)
    .map((t) => t.replace(/^!/, "").trim())
    .filter(Boolean);
  return new Set(idents).size === 1;
}

function scan(text: string): { index: number; name: string }[] {
  const hits: { index: number; name: string }[] = [];
  for (const { name, re } of PATTERNS) {
    re.lastIndex = 0;
    for (let m = re.exec(text); m; m = re.exec(text)) {
      if (name === "joined comparisons" && !sameVariable(m[0])) continue;
      hits.push({ index: m.index, name });
    }
  }
  return hits.sort((a, b) => a.index - b.index);
}

function inlineHits(rel: string, text: string): string[] {
  const isDefinitionFile = DEFINITION_FILES.has(rel);
  const out: string[] = [];
  for (const { index, name } of scan(text)) {
    const line = lineText(text, index);
    if (isDefinitionFile && /^\s*(export\s+)?const\s+[A-Z_]+\b/.test(line)) continue;
    out.push(`${rel}:${lineOf(text, index)} (${name}): ${line.trim()}`);
  }
  return out;
}

describe("the scanner itself", () => {
  const probe = (src: string) => scan(stripComments(src)).map((h) => h.name);

  it.each([
    ['["SUPER_ADMIN", "ADMIN"]', "array of roles"],
    ['new Set<string>(["ADMIN",\n  "SUPER_ADMIN",\n])', "array of roles"],
    ['["ADMIN","ORGANIZER"].includes(role)', "array of roles"],
    ['role === "ADMIN" || role === "SUPER_ADMIN"', "joined comparisons"],
    ['callerRole !== "ADMIN" && callerRole !== "SUPER_ADMIN"', "joined comparisons"],
    ['session?.user?.role === "SUPER_ADMIN" ||\n      session?.user?.role === "ADMIN"', "joined comparisons"],
    ['"ADMIN" === r || "SUPER_ADMIN" === r', "joined comparisons"],
    ['session?.user?.role === "ADMIN" || isSuperAdmin', "comparison joined to an is…Admin helper"],
    ['isSuperAdmin || role === "ADMIN"', "comparison joined to an is…Admin helper"],
    ['case "ADMIN":\n  case "SUPER_ADMIN":\n    return true;', "consecutive case labels"],
  ])("catches %j", (src, name) => {
    expect(probe(src)).toContain(name);
  });

  it.each([
    'role === "REVIEWER" || role === "SUBMITTER"',
    'role === "ADMIN"',
    'callerRole === "ORGANIZER" && user.role !== "ONSITE"',
    'canWrite(role) || isOrgAdmin(role)',
    '// role === "ADMIN" || role === "SUPER_ADMIN"',
    '/* ["SUPER_ADMIN", "ADMIN"] */',
  ])("ignores %j", (src) => {
    expect(probe(src)).toEqual([]);
  });

  it("does not read a slash-star inside a string as a comment", () => {
    const src = 'const accept = "*/*;q=0.5";\nconst x = role === "ADMIN" || role === "SUPER_ADMIN";';
    expect(probe(src)).toEqual(["joined comparisons"]);
  });
});

describe("no inline role lists outside the named predicates", () => {
  const root = process.cwd();
  const files = ROOTS.flatMap((r) => walk(path.join(root, r))).map((f) => path.relative(root, f).split(path.sep).join("/"));

  it("finds the source tree", () => {
    expect(files.length).toBeGreaterThan(500);
    expect(files.some((f) => f.startsWith("worker/"))).toBe(true);
  });

  it("has no hand-written role list anywhere else", () => {
    const hits = files.flatMap((rel) => inlineHits(rel, stripComments(readFileSync(path.join(root, rel), "utf8"))));
    expect(hits, `inline role lists (use a named predicate):\n${hits.join("\n")}`).toEqual([]);
  });

  it("the definition files exist", () => {
    for (const rel of DEFINITION_FILES) expect(files, rel).toContain(rel);
  });
});
