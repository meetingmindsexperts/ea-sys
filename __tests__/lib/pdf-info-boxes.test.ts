/**
 * The details box on quotes, invoices, credit notes and purchase orders
 * (document-layout.ts, Nov 4, 2026): a long billing email printed over the
 * Billing Phone row below it, because every row was drawn 14pt below the last
 * whatever the value's height. Driven with a real PDFKit document.
 */
import { describe, it, expect } from "vitest";
import PDFDocument from "pdfkit";
import { drawInfoBoxes } from "@/lib/pdf/document-layout";

const BILL_TO = { nameLine: "Dr. Regtest Prefill", secondLine: "Consultant", organizationLine: "Prefill Clinic", addressLine: null, locationLine: "Dubai" };

/** Draws the box, recording where each label and value starts and how tall it prints. */
function draw(meta: { label: string; value: string }[]) {
  const doc = new PDFDocument({ size: "A4", margin: 50 });
  const rows: { text: string; y: number; height: number }[] = [];
  const text = doc.text.bind(doc);
  (doc as unknown as { text: typeof doc.text }).text = ((t: string, x?: number, y?: number, opts?: PDFKit.Mixins.TextOptions) => {
    if (typeof y === "number") rows.push({ text: t, y, height: doc.heightOfString(t, opts) });
    return text(t, x as number, y as number, opts);
  }) as typeof doc.text;
  const bottom = drawInfoBoxes(doc, 60, { billTo: BILL_TO, meta });
  doc.end();
  const at = (t: string) => rows.find((r) => r.text === t)!;
  return { bottom, at };
}

describe("drawInfoBoxes meta rows", () => {
  it("fits the reported email on one line: the phone row starts below it", () => {
    const { at } = draw([
      { label: "Billing Email", value: "krishna+regtest@meetingmindsdubai.com" },
      { label: "Billing Phone", value: "+971500000123" },
    ]);
    const email = at("krishna+regtest@meetingmindsdubai.com");
    expect(at("Billing Phone").y).toBeGreaterThanOrEqual(email.y + email.height);
  });

  it("gives a value that must wrap the height it needs, and grows the box", () => {
    const longEmail = "accounts.payable.department+mehfc2027@very-long-hospital-domain-name.ae";
    const short = draw([{ label: "Billing Email", value: "a@b.ae" }, { label: "Billing Phone", value: "+971" }]);
    const long = draw([{ label: "Billing Email", value: longEmail }, { label: "Billing Phone", value: "+971" }]);
    const email = long.at(longEmail);
    expect(long.at("Billing Phone").y).toBeGreaterThanOrEqual(email.y + email.height);
    expect(long.bottom).toBeGreaterThanOrEqual(short.bottom);
  });
});
