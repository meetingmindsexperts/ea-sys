/**
 * No runtime import cycles in src/ or worker/ (dependency audit, Nov 3, 2026).
 *
 * The audit found one: registration-service imported group-registration-service
 * for a single helper, and group-registration-service imported
 * registration-service back. It worked only because every use sat inside a
 * function; one top-level use (a `const X = { ...CONFIRMATION_EVENT_SELECT }`)
 * would have thrown at load, in whichever file happened to load second. The
 * helper moved to src/lib/group-invoice-drift.ts and the tree had no other
 * cycle, so any new one fails here.
 *
 * Fix a failure by moving what both files need into a leaf module that imports
 * neither, never by an exemption.
 *
 * What counts: `import … from`, `export … from` and side-effect `import "…"`
 * of a `@/` or relative path, read with the TypeScript parser (a regex lost
 * value imports after an `export type { … };`, review of 0a833c46). What does
 * not: `import type`, an import whose every name is `type`-marked (both erased
 * at compile), and `await import()` (resolved at call time, after both modules
 * have loaded). An unmarked import used only as a type still counts: it fails
 * safe, as a cycle the test reports and the bundler would have erased. Each
 * rule has a probe below.
 */
import { describe, it, expect } from "vitest";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import ts from "typescript";

const ROOT = path.resolve(__dirname, "../..");
const SRC = path.join(ROOT, "src");

/** Every named binding is `type`-marked, and nothing else is imported. */
function allTypeOnly(elements: ts.NodeArray<ts.ImportSpecifier | ts.ExportSpecifier>): boolean {
  return elements.length > 0 && elements.every((e) => e.isTypeOnly);
}

/** The specifiers a module needs at runtime. */
function runtimeSpecifiers(source: string, fileName = "probe.ts"): string[] {
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, false, fileName.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const out: string[] = [];
  for (const stmt of sf.statements) {
    if (ts.isImportDeclaration(stmt) && ts.isStringLiteral(stmt.moduleSpecifier)) {
      const clause = stmt.importClause;
      if (clause?.isTypeOnly) continue;
      const named = clause?.namedBindings;
      if (clause && !clause.name && named && ts.isNamedImports(named) && allTypeOnly(named.elements)) continue;
      out.push(stmt.moduleSpecifier.text);
    } else if (ts.isExportDeclaration(stmt) && stmt.moduleSpecifier && ts.isStringLiteral(stmt.moduleSpecifier)) {
      if (stmt.isTypeOnly) continue;
      const clause = stmt.exportClause;
      if (clause && ts.isNamedExports(clause) && allTypeOnly(clause.elements)) continue;
      out.push(stmt.moduleSpecifier.text);
    }
  }
  return out;
}

function resolveSpecifier(spec: string, fromFile: string): string | null {
  let base: string;
  if (spec.startsWith("@/")) base = path.join(SRC, spec.slice(2));
  else if (spec.startsWith(".")) base = path.resolve(path.dirname(fromFile), spec);
  else return null;
  for (const candidate of [`${base}.ts`, `${base}.tsx`, path.join(base, "index.ts"), path.join(base, "index.tsx"), base]) {
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  return null;
}

/** Strongly connected components of two or more modules (Tarjan). */
function findCycles(graph: Map<string, string[]>): string[][] {
  let next = 0;
  const index = new Map<string, number>();
  const low = new Map<string, number>();
  const stack: string[] = [];
  const onStack = new Set<string>();
  const cycles: string[][] = [];
  const visit = (v: string) => {
    index.set(v, next);
    low.set(v, next);
    next += 1;
    stack.push(v);
    onStack.add(v);
    for (const w of graph.get(v) ?? []) {
      if (!graph.has(w)) continue;
      if (!index.has(w)) {
        visit(w);
        low.set(v, Math.min(low.get(v)!, low.get(w)!));
      } else if (onStack.has(w)) {
        low.set(v, Math.min(low.get(v)!, index.get(w)!));
      }
    }
    if (low.get(v) !== index.get(v)) return;
    const component: string[] = [];
    let w: string;
    do {
      w = stack.pop()!;
      onStack.delete(w);
      component.push(w);
    } while (w !== v);
    if (component.length > 1) cycles.push(component.sort());
  };
  for (const v of graph.keys()) if (!index.has(v)) visit(v);
  return cycles;
}

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sourceFiles(p));
    else if (/\.tsx?$/.test(entry.name) && !entry.name.endsWith(".d.ts")) out.push(p);
  }
  return out;
}

describe("the scanner", () => {
  it("reads value imports, re-exports and side-effect imports", () => {
    const src = [
      `import { a } from "@/lib/a";`,
      `import b, { type B } from "./b";`,
      `export { c } from "../c";`,
      `export * from "@/lib/d";`,
      `import "@/lib/e";`,
      `import {\n  f,\n  g,\n} from "@/lib/f";`,
      // The regex lost this one: a lazy match from the `export type` ran on to it.
      `export type { G };\nimport { h } from "./h";`,
    ].join("\n");
    expect(runtimeSpecifiers(src)).toEqual(["@/lib/a", "./b", "../c", "@/lib/d", "@/lib/e", "@/lib/f", "./h"]);
  });

  it("skips what compiles away and what loads late", () => {
    const src = [
      `import type { A } from "@/lib/a";`,
      `import { type B, type C } from "@/lib/b";`,
      `export type { D } from "@/lib/d";`,
      `const e = await import("@/lib/e");`,
      `// import { f } from "@/lib/f";`,
      `/* import { g } from "@/lib/g"; */`,
    ].join("\n");
    expect(runtimeSpecifiers(src)).toEqual([]);
  });

  it("finds a two-module and a longer cycle, and nothing in a chain", () => {
    const graph = new Map([
      ["a", ["b"]],
      ["b", ["a"]],
      ["c", ["d"]],
      ["d", ["e"]],
      ["e", ["c"]],
      ["x", ["y"]],
      ["y", []],
    ]);
    expect(findCycles(graph)).toEqual([["a", "b"], ["c", "d", "e"]]);
  });
});

describe("src/ and worker/", () => {
  it("have no runtime import cycle", () => {
    const files = [...sourceFiles(SRC), ...sourceFiles(path.join(ROOT, "worker"))];
    const graph = new Map<string, string[]>();
    for (const file of files) {
      const deps = runtimeSpecifiers(readFileSync(file, "utf8"), file)
        .map((spec) => resolveSpecifier(spec, file))
        .filter((p): p is string => p !== null);
      graph.set(file, [...new Set(deps)]);
    }
    expect(files.length).toBeGreaterThan(500);
    const cycles = findCycles(graph).map((c) => c.map((f) => path.relative(ROOT, f)).join(" <-> "));
    expect(cycles).toEqual([]);
  });
});
