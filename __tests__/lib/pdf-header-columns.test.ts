/**
 * The PDF header's three columns must not overlap.
 *
 * They used to, by construction: the left company column was declared 180pt
 * wide from x=50 (ending at 230) while the centre column began at 187.6 — a
 * 42pt overlap sitting in the layout the whole time. It stayed invisible only
 * because every company address line anyone had entered happened to be short
 * enough not to reach into it. Meeting Minds' real address renders 145.2pt,
 * ending 8pt inside the centre column, and printed "Dubai Studio City" on top
 * of the event name.
 *
 * Two things are pinned here, and the second is the subtle one:
 *
 *  1. The left column cannot reach the centre column, whatever is in it.
 *  2. A line that WRAPS advances by its real height. Narrowing the column is
 *     what makes a long address wrap instead of colliding sideways — but the
 *     loop used to advance a constant 11pt per entry, which assumes one
 *     rendered line per entry. Fixing only the width would have traded a
 *     collision with the centre column for a collision with the line below,
 *     which is the harder one to notice because both lines are the same colour
 *     and size.
 *
 * drawHeader is shared by the quote, invoice, credit note and CRM quote, so
 * this covers all four.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import PDFDocument from "pdfkit";
import { drawHeader, PAGE_MARGIN, COLUMN_GAP } from "@/lib/pdf/document-layout";

const CENTER_WIDTH = 220;

type TextProto = { text: (...args: unknown[]) => unknown };

/** Left-column draws: the ones positioned at the page margin. */
function leftColumnCalls(calls: unknown[][]) {
  return calls.filter((a) => a[1] === PAGE_MARGIN);
}

function render(companyBlock: Parameters<typeof drawHeader>[1]["companyBlock"]) {
  const doc = new PDFDocument({ size: "A4", margin: PAGE_MARGIN });
  const proto = PDFDocument.prototype as unknown as TextProto;
  const spy = vi.spyOn(proto, "text");
  const bottom = drawHeader(doc, {
    companyBlock,
    centerTitle: "Middle East Haematology Forum 2026",
    documentTitle: "TAX INVOICE",
    logoBuffer: null,
  });
  const centerX = (doc.page.width - CENTER_WIDTH) / 2;
  return { calls: [...spy.mock.calls] as unknown[][], centerX, bottom };
}

describe("PDF header column geometry", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("keeps the company column clear of the centre column", () => {
    const { calls, centerX } = render({
      // The real Meeting Minds record, which is what exposed the overlap.
      companyName: "Meeting Minds FZ LLC",
      addressLines: ["508 & 509, DSC tower, Dubai Studio City", "Dubai 502464", "United Arab Emirates"],
      taxId: "100352048100003",
    });

    const left = leftColumnCalls(calls);
    expect(left.length).toBeGreaterThan(3);

    for (const call of left) {
      const opts = call[3] as { width?: number } | undefined;
      expect(opts?.width, `no width cap on "${String(call[0])}"`).toBeTypeOf("number");
      // The invariant, stated the way the bug violated it.
      expect(
        PAGE_MARGIN + opts!.width!,
        `"${String(call[0])}" may extend to x=${PAGE_MARGIN + opts!.width!}, past the centre column at ${centerX.toFixed(1)}`,
      ).toBeLessThanOrEqual(centerX - COLUMN_GAP + 0.01);
    }
  });

  it("advances a WRAPPED line by its real height, not a constant", () => {
    const { calls } = render({
      companyName: "Meeting Minds FZ LLC",
      addressLines: ["508 & 509, DSC tower, Dubai Studio City", "Dubai 502464"],
      taxId: null,
    });

    const ys = leftColumnCalls(calls).map((a) => a[2] as number);
    // [companyName, wrapping address line, short address line]
    expect(ys.length).toBe(3);

    const afterWrapping = ys[2] - ys[1];
    // A single 8pt line advances 11. The long line wraps to two, so anything
    // near 11 here means the second rendered line is being drawn over.
    expect(
      afterWrapping,
      `wrapped line advanced only ${afterWrapping.toFixed(1)}pt — the second rendered line will be overdrawn`,
    ).toBeGreaterThan(16);
  });

  it("leaves a NON-wrapping block spaced exactly as before", () => {
    // This change must be a no-op on every document whose address already fit.
    const { calls } = render({
      companyName: "Acme Ltd",
      addressLines: ["1 Short St", "Dubai"],
      taxId: "123",
    });

    const ys = leftColumnCalls(calls).map((a) => a[2] as number);
    expect(ys[1] - ys[0]).toBe(12); // company name -> first address line
    expect(ys[2] - ys[1]).toBe(11); // address line -> address line
    expect(ys[3] - ys[2]).toBe(11); // address line -> TRN
  });

  it("trims a company tax id so trailing spaces do not print", () => {
    // The live MM Group record stores "100352048100003  ".
    const { calls } = render({
      companyName: "Acme Ltd",
      addressLines: ["1 Short St"],
      taxId: "100352048100003  ",
    });

    const trn = leftColumnCalls(calls).map((a) => String(a[0])).find((t) => t.startsWith("TRN:"));
    expect(trn).toBe("TRN: 100352048100003");
  });
});
