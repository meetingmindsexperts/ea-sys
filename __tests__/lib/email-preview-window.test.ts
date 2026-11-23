/**
 * The email preview opens in its own window (owner, Nov 23, 2026;
 * src/lib/email-preview-window.ts). The unit suite has no browser document,
 * so the drawing is checked in a real browser; what is pinned here is what
 * would go wrong quietly:
 *   - a screen that still opens only the stacked dialog;
 *   - a screen that opens the window AFTER an await. Chrome still allows it
 *     for a few seconds, so it would pass every local check, and Safari and
 *     Firefox users would get the fallback dialog every time;
 *   - a preview lost because the window was gone when the answer arrived;
 *   - the email's HTML reaching the window as HTML, or running scripts.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openEmailPreviewWindow } from "@/lib/email-preview-window";

const ROOT = join(__dirname, "..", "..");
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");

function sourceFiles(dir: string): string[] {
  return readdirSync(join(ROOT, dir)).flatMap((name) => {
    const rel = join(dir, name);
    if (statSync(join(ROOT, rel)).isDirectory()) return sourceFiles(rel);
    return /\.tsx?$/.test(name) ? [rel] : [];
  });
}

const SCREENS = sourceFiles("src").filter(
  (f) => !f.endsWith("email-preview-dialog.tsx") && read(f).includes("<EmailPreviewDialog"),
);

// ── "No await can run before the window opens", read from the syntax tree ────

function hasAwait(node: ts.Node): boolean {
  if (ts.isAwaitExpression(node)) return true;
  // A nested function's awaits are its own.
  if (ts.isFunctionLike(node)) return false;
  return ts.forEachChild(node, (child) => hasAwait(child) || undefined) === true;
}

/** A branch that always leaves the function: nothing in it runs before later code. */
function alwaysExits(node: ts.Statement | undefined): boolean {
  if (!node) return false;
  if (ts.isReturnStatement(node) || ts.isThrowStatement(node)) return true;
  if (ts.isBlock(node)) return alwaysExits(node.statements[node.statements.length - 1]);
  return false;
}

/** Whether an await in this EARLIER statement can have run by the time later statements do. */
function awaitsBeforeFallingThrough(stmt: ts.Statement): boolean {
  if (!hasAwait(stmt)) return false;
  if (!ts.isIfStatement(stmt)) return true;
  if (hasAwait(stmt.expression)) return true;
  const thenRuns = hasAwait(stmt.thenStatement) && !alwaysExits(stmt.thenStatement);
  const elseRuns = !!stmt.elseStatement && hasAwait(stmt.elseStatement) && !alwaysExits(stmt.elseStatement);
  return thenRuns || elseRuns;
}

/**
 * For each `openEmailPreviewWindow()` call: the text of the first earlier
 * statement in its own function that can have awaited, or null when none can.
 */
export function awaitsBeforeEachOpen(source: string, fileName = "screen.tsx"): Array<string | null> {
  const file = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const found: Array<string | null> = [];
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node) && node.expression.getText(file) === "openEmailPreviewWindow") {
      let offender: string | null = null;
      let child: ts.Node = node;
      for (let parent = node.parent; parent && !offender; child = parent, parent = parent.parent) {
        const statements = ts.isBlock(parent) || ts.isSourceFile(parent) || ts.isCaseClause(parent) || ts.isDefaultClause(parent) ? parent.statements : undefined;
        if (statements) {
          for (const stmt of statements) {
            if (stmt === child) break;
            if (awaitsBeforeFallingThrough(stmt)) {
              offender = stmt.getText(file).slice(0, 80);
              break;
            }
          }
        }
        if (ts.isFunctionLike(parent)) break;
      }
      found.push(offender);
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return found;
}

describe("the await check itself", () => {
  const wrap = (body: string) => `const h = async () => {\n${body}\n};`;

  it("passes a window opened first, and after a guard that returns", () => {
    expect(awaitsBeforeEachOpen(wrap(`if (!x) { toast("pick one"); return; }\nconst w = openEmailPreviewWindow();\nawait go();`))).toEqual([null]);
  });

  it("passes a second branch after a first that awaits and always returns", () => {
    expect(awaitsBeforeEachOpen(wrap(`if (a) { const w = openEmailPreviewWindow(); await go(); return; }\nconst w = openEmailPreviewWindow();`))).toEqual([null, null]);
  });

  it.each([
    ["an await in an earlier statement", `const r = await go();\nconst w = openEmailPreviewWindow();`],
    ["an awaited guard that returns (review of 1b8fcf79, M2)", `const ok = await validate();\nif (!ok) { toast("no"); return; }\nconst w = openEmailPreviewWindow();`],
    ["an await in a guard's condition", `if (!(await validate())) return;\nconst w = openEmailPreviewWindow();`],
    ["an await in a branch that falls through", `if (dirty) { await save(); }\nconst w = openEmailPreviewWindow();`],
    ["an await earlier in the same try", `try {\n  await save();\n  const w = openEmailPreviewWindow();\n} catch {}`],
    ["the word async in a comment between them", `await go();\n// async work is done\nconst w = openEmailPreviewWindow();`],
  ])("catches %s", (_what, body) => {
    expect(awaitsBeforeEachOpen(wrap(body)).every((o) => o === null)).toBe(false);
  });
});

describe("every email preview opens in its own window", () => {
  it("finds the ten files with a preview box (a new one must open the window too)", () => {
    expect(SCREENS.length).toBe(10);
  });

  it.each(SCREENS)("%s opens the window before anything is awaited, and falls back to the dialog", (file) => {
    const src = read(file);
    expect(src).toContain('import { openEmailPreviewWindow } from "@/lib/email-preview-window";');
    const opens = awaitsBeforeEachOpen(src, file);
    expect(opens.length).toBeGreaterThan(0);
    expect(opens).toEqual(opens.map(() => null));
    // The dialog is reached only when there is no window, or the window was
    // gone when the preview arrived (`show` answers false).
    const dialogOpens = src.match(/setPreviewOpen\(true\)/g) ?? [];
    const guarded = src.match(/if \(!previewWindow\?\.show\(/g) ?? [];
    expect(guarded.length).toBe(dialogOpens.length);
    expect(guarded.length).toBe(opens.length);
    // A failure is said in the window, not only in a toast behind it.
    expect((src.match(/previewWindow\?\.fail\(/g) ?? []).length).toBeGreaterThanOrEqual(opens.length);
  });
});

describe("the window never runs or injects the email", () => {
  const src = read("src/lib/email-preview-window.ts");

  it("puts the email in a frame with scripts off", () => {
    expect(src).toContain('iframe.setAttribute("sandbox", "allow-same-origin")');
    expect(src).not.toMatch(/sandbox[^\n]*allow-scripts/);
    expect(src).toContain("iframe.srcdoc = content.htmlContent");
  });

  it("writes only text nodes: no innerHTML, and document.write only of the fixed skeleton", () => {
    expect(src).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML/);
    const writes = [...src.matchAll(/doc\.write\(([^)]*)\)/g)].map((m) => m[1]);
    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatch(/^'<!doctype html>[^']*<\/html>'$/);
  });
});

// ── The helper against a stand-in window ─────────────────────────────────────

/** Just enough of a browser window for the helper to draw into. */
function fakeWindow() {
  const node = (): Record<string, unknown> => {
    const self: Record<string, unknown> = {
      style: {},
      classList: { toggle: vi.fn() },
      append: vi.fn(),
      appendChild: vi.fn(),
      setAttribute: vi.fn(),
      addEventListener: vi.fn(),
      textContent: "",
    };
    return self;
  };
  const doc = {
    open: vi.fn(),
    write: vi.fn(),
    close: vi.fn(),
    title: "",
    head: node(),
    body: node(),
    createElement: vi.fn(() => node()),
    createTextNode: vi.fn(() => node()),
    addEventListener: vi.fn(),
  };
  const win = { document: doc, closed: false, focus: vi.fn(), close: vi.fn(), setTimeout: vi.fn() } as Record<string, unknown>;
  return { win, doc };
}

function stubBrowser(open: () => unknown, coarse = false) {
  vi.stubGlobal("window", {
    open: vi.fn(open),
    matchMedia: vi.fn(() => ({ matches: coarse })),
    addEventListener: vi.fn(),
  });
}

const EMAIL = { subject: "Hello", htmlContent: "<p>Hi</p>" };

describe("when the preview cannot be shown in the window, the dialog shows it", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("answers null when the browser blocks the window", () => {
    stubBrowser(() => null);
    expect(openEmailPreviewWindow()).toBeNull();
  });

  it("answers null when the reused window cannot be reached", () => {
    stubBrowser(() => ({
      get document(): Document {
        throw new Error("cross-origin");
      },
    }));
    expect(openEmailPreviewWindow()).toBeNull();
  });

  it("answers null on a phone or tablet, without opening anything", () => {
    const { win } = fakeWindow();
    stubBrowser(() => win, true);
    expect(openEmailPreviewWindow()).toBeNull();
    expect((window.open as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
  });

  it("answers null on the server", () => {
    expect(openEmailPreviewWindow()).toBeNull();
  });

  it("show answers true when it drew the email", () => {
    const { win, doc } = fakeWindow();
    stubBrowser(() => win);
    const preview = openEmailPreviewWindow();
    expect(preview?.show(EMAIL)).toBe(true);
    expect(doc.title).toBe("Preview: Hello");
  });

  // Review of 1b8fcf79, M1: a pop-up extension that closes the window a moment
  // after it opened left the person with nothing at all.
  it("show answers false when the window was closed before the preview arrived", () => {
    const { win } = fakeWindow();
    stubBrowser(() => win);
    const preview = openEmailPreviewWindow();
    win.closed = true;
    expect(preview?.show(EMAIL)).toBe(false);
  });

  it("show answers false, and says why in the console, when drawing fails", () => {
    const { win, doc } = fakeWindow();
    stubBrowser(() => win);
    const preview = openEmailPreviewWindow();
    doc.open.mockImplementation(() => {
      throw new Error("navigated away");
    });
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(preview?.show(EMAIL)).toBe(false);
    expect(logged).toHaveBeenCalled();
    logged.mockRestore();
  });

  it("an older request that answers late does not draw over the newer preview", () => {
    const { win, doc } = fakeWindow();
    stubBrowser(() => win);
    const older = openEmailPreviewWindow();
    const newer = openEmailPreviewWindow();
    expect(newer?.show({ subject: "Newer", htmlContent: "<p>n</p>" })).toBe(true);
    // True: the newer preview is on screen, so there is nothing to fall back from.
    expect(older?.show({ subject: "Older", htmlContent: "<p>o</p>" })).toBe(true);
    expect(doc.title).toBe("Preview: Newer");
    older?.fail("Older failed");
    expect(doc.title).toBe("Preview: Newer");
  });

  it("keeps the person's Mobile choice for the next preview", () => {
    const { win } = fakeWindow();
    stubBrowser(() => win);
    win.__eaPreviewMobile = true;
    openEmailPreviewWindow()?.show(EMAIL);
    expect(win.__eaPreviewMobile).toBe(true);
  });
});
