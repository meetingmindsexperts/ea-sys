/**
 * The dashboard scrolls inside <main>, never the document. Radix renders a hidden
 * absolute input beside each checkbox and switch, and without a positioned ancestor
 * one below the fold made the document taller than the window: the whole shell
 * scrolled up over a blank strip (My details, Nov 9, 2026).
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

describe("dashboard shell", () => {
  it("makes the scrolling <main> the positioned ancestor", () => {
    const layout = readFileSync(path.resolve(__dirname, "../../src/app/(dashboard)/layout.tsx"), "utf8");
    const main = layout.match(/<main className="([^"]*)"/)?.[1] ?? "";
    expect(main.split(" ")).toEqual(expect.arrayContaining(["relative", "overflow-auto"]));
  });
});
