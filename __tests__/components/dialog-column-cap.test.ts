/**
 * One long line can no longer push a dialog past its own edge (Nov 23, 2026).
 *
 * `DialogContent` and `AlertDialogContent` are one-column grids. A grid column
 * grows to its widest unbreakable content, so one long title, name or address
 * widened the whole dialog: the heading, the fields and the footer's buttons
 * were cut off at the right (organiser's screenshot, MEHF2027, Nov 20, 2026).
 * Six dialogs were capped by hand then; the cap now lives in the two shared
 * components, for all of them.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { cn } from "@/lib/utils";

const ROOT = join(__dirname, "..", "..");
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");
const CAP = "grid-cols-[minmax(0,1fr)]";

function sourceFiles(dir: string): string[] {
  return readdirSync(join(ROOT, dir)).flatMap((name) => {
    const rel = join(dir, name);
    if (statSync(join(ROOT, rel)).isDirectory()) return sourceFiles(rel);
    return name.endsWith(".tsx") ? [rel] : [];
  });
}

/** The base class string each shared component hands to `cn(...)` before the caller's own. */
function baseClasses(file: string): string {
  const match = read(file).match(/"([^"]*\bz-50 grid [^"]*)"/);
  if (!match) throw new Error(`${file}: the content's base classes were not found`);
  return match[1];
}

describe.each(["src/components/ui/dialog.tsx", "src/components/ui/alert-dialog.tsx"])("%s", (file) => {
  const base = baseClasses(file);

  // MUTATION: drop the class from the base and this fails.
  it("is a grid whose one column never grows past the dialog", () => {
    expect(base.split(" ")).toContain("grid");
    expect(base.split(" ")).toContain(CAP);
  });

  it("a dialog that sets its own columns still gets them", () => {
    const merged = cn(base, "grid-cols-2").split(" ");
    expect(merged).toContain("grid-cols-2");
    expect(merged).not.toContain(CAP);
  });

  it("a dialog laid out as a flex box is still a flex box", () => {
    const merged = cn(base, "flex max-h-[90vh] flex-col").split(" ");
    expect(merged).toContain("flex");
    expect(merged).not.toContain("grid");
  });

  it("a dialog's own width and height limits are untouched", () => {
    const merged = cn(base, "max-h-[90vh] overflow-y-auto sm:max-w-4xl").split(" ");
    expect(merged).toContain(CAP);
    expect(merged).toContain("sm:max-w-4xl");
    expect(merged).toContain("overflow-y-auto");
  });
});

describe("no dialog carries its own copy of the cap", () => {
  // The six hand-made caps of Nov 20 are gone: one rule, in one place. A
  // dialog that needs different columns says so; it never restates the default.
  it("only the two shared components name it on a dialog", () => {
    const offenders = sourceFiles("src")
      .filter((f) => !f.endsWith("ui/dialog.tsx") && !f.endsWith("ui/alert-dialog.tsx"))
      .filter((f) => /<(Alert)?DialogContent[^>]*grid-cols-\[minmax\(0,1fr\)\]/.test(read(f)));
    expect(offenders).toEqual([]);
  });
});
