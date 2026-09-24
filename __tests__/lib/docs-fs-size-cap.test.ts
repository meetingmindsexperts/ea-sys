/**
 * The docs viewer's size caps.
 *
 * A file over the cap is not refused loudly: it is left out of the tree and
 * reads as "Not found", which looks exactly like a file that was never
 * written. The spend-request walkthrough (97 embedded screenshots, ~5.5 MB)
 * was invisible in /admin/docs for a day under the old single 1 MB cap before
 * anyone asked why (24 Sep 2026).
 */
import { describe, it, expect, vi } from "vitest";

vi.mock("@/lib/logger", () => ({ apiLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

import { buildDocsTree, maxDocBytes, readDocFile } from "@/lib/docs-fs";

type Node = { type: string; path?: string; children?: Node[] };
const flatten = (nodes: Node[]): string[] => nodes.flatMap((n) => (n.type === "file" ? [n.path ?? ""] : flatten(n.children ?? [])));

describe("docs-fs size caps", () => {
  it("gives self-contained HTML room for embedded screenshots, and keeps Markdown at 1 MB", () => {
    expect(maxDocBytes("md")).toBe(1_000_000);
    expect(maxDocBytes("html")).toBe(8_000_000);
  });

  it("lists and reads the spend-request walkthrough, which is over 1 MB", async () => {
    const file = await readDocFile("docs/SPEND_REQUEST_E2E_VERIFICATION.html");
    expect(file).not.toBeNull();
    expect(file!.type).toBe("html");
    expect(file!.content.length).toBeGreaterThan(1_000_000);
    expect(flatten((await buildDocsTree()) as Node[])).toContain("docs/SPEND_REQUEST_E2E_VERIFICATION.html");
  });
});
