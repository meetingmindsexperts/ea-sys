/**
 * The email preview opens in its own window (owner, Nov 23, 2026;
 * src/lib/email-preview-window.ts). The unit suite has no browser document,
 * so the drawing is checked in a real browser; what is pinned here is what
 * would go wrong quietly:
 *   - a screen that still opens only the stacked dialog;
 *   - a screen that opens the window AFTER an await (a browser then blocks it
 *     and the person sees the fallback dialog every time, so it "works");
 *   - the email's HTML reaching the window as HTML, or running scripts.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
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

describe("every email preview opens in its own window", () => {
  it("finds the ten preview screens (a new one must be added to the window too)", () => {
    expect(SCREENS.length).toBe(10);
  });

  it.each(SCREENS)("%s opens the window, before the request, and shows the dialog only as the fallback", (file) => {
    const src = read(file);
    expect(src).toContain('import { openEmailPreviewWindow } from "@/lib/email-preview-window";');
    // Every handler that opens the window: no await between its start and the
    // window. Read per call: from the start of the enclosing handler (the last
    // `async` before the call), or from the last early `return;` of a branch
    // above it in the same handler, to the call itself.
    const calls = [...src.matchAll(/const previewWindow = openEmailPreviewWindow\(\);/g)];
    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) {
      const before = src.slice(0, call.index);
      const handlerStart = before.lastIndexOf("async");
      expect(handlerStart).toBeGreaterThan(-1);
      const from = Math.max(handlerStart + "async".length, before.lastIndexOf("return;"));
      expect(before.slice(from)).not.toMatch(/\bawait\b/);
    }
    // The dialog is reached only when there is no window.
    const dialogOpens = src.match(/setPreviewOpen\(true\)/g) ?? [];
    const guarded = src.match(/if \(previewWindow\) previewWindow\.show\(/g) ?? [];
    expect(guarded.length).toBe(dialogOpens.length);
    // A failure is said in the window, not only in a toast behind it.
    expect((src.match(/previewWindow\?\.fail\(/g) ?? []).length).toBeGreaterThanOrEqual(calls.length);
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

describe("a blocked window falls back to the dialog", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("answers null when the browser blocks the window", () => {
    vi.stubGlobal("window", { open: vi.fn(() => null) });
    expect(openEmailPreviewWindow()).toBeNull();
  });

  it("answers null when the reused window cannot be reached", () => {
    vi.stubGlobal("window", {
      open: vi.fn(() => ({
        get document(): Document {
          throw new Error("cross-origin");
        },
      })),
    });
    expect(openEmailPreviewWindow()).toBeNull();
  });

  it("answers null on the server", () => {
    expect(openEmailPreviewWindow()).toBeNull();
  });
});
