/**
 * The receipt masthead: org logo, falling back to the org name.
 *
 * Two things worth pinning, both silent failures if they regress:
 *
 *  1. **A logo-less org must still get a masthead.** The logo replaced a
 *     20pt company name that was itself a duplicate of the FROM block below,
 *     so the fallback is not cosmetic — without it the top-left of the receipt
 *     is simply empty for every org that has not uploaded a logo.
 *
 *  2. **A logo that fails to decode must not fail the receipt.** This document
 *     is proof of a payment that already happened; refusing to render it
 *     because an image is corrupt would withhold the artifact over the one
 *     detail on it that carries no financial information.
 *
 * `loadLocalLogo` is mocked rather than exercised against the filesystem
 * because `public/uploads/` is gitignored — a test depending on a real image
 * there would pass locally and fail in CI.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import PDFDocument from "pdfkit";

vi.mock("@/lib/pdf/document-layout", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/pdf/document-layout")>();
  return { ...actual, loadLocalLogo: vi.fn() };
});

vi.mock("@/lib/logger", () => ({
  apiLogger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

import { generateReceiptPDF, type ReceiptPDFData } from "@/lib/receipt-pdf";
import { loadLocalLogo } from "@/lib/pdf/document-layout";
import { apiLogger } from "@/lib/logger";

/**
 * Real PNGs with KNOWN aspect ratios, because the whole point of the masthead
 * box is which dimension binds. A single square fixture could not tell the two
 * cases apart, and the shipped bug was precisely that the wrong one bound.
 *
 *   4:3  -> width binds  -> 100 x 75  (an ordinary logo; MM Group's is 1.45:1)
 *   1:4  -> height binds ->  20 x 80  (a vertical lockup; the ceiling's reason to exist)
 */
const WIDE_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAQAAAADCAIAAAA7ljmRAAAADklEQVR4nGNoQAIMODkAXzYSAY5zHKsAAAAASUVORK5CYII=",
  "base64",
);
const TALL_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAAECAIAAADAusJtAAAADklEQVR4nGNoaGhgQMIAMBAGAU0JnIUAAAAASUVORK5CYII=",
  "base64",
);

/** The y the "PAYMENT RECEIPT" label was drawn at — it must follow the logo. */
function labelY(calls: unknown[][]): number | undefined {
  const call = calls.find((a) => a[0] === "PAYMENT RECEIPT");
  return call?.[2] as number | undefined;
}

function receiptData(overrides: Partial<ReceiptPDFData> = {}): ReceiptPDFData {
  return {
    receiptNumber: "TST-REC-0001",
    paymentDate: new Date("2026-04-09T08:00:00Z"),
    paymentMethod: "stripe",
    paymentReference: "pi_test",
    logoPath: "/uploads/media/2026/06/logo.png",
    orgName: "MM Group",
    companyName: "Meeting Minds FZ LLC",
    companyAddress: "DSC Tower",
    companyCity: "Dubai",
    companyState: null,
    companyZipCode: "502464",
    companyCountry: "United Arab Emirates",
    taxId: "100352048100003",
    primaryColor: "#00aade",
    firstName: "Ahmed",
    lastName: "Osman",
    email: "ahmed@example.com",
    organization: "Cleveland Clinic",
    title: "Dr.",
    taxNumber: null,
    payerName: null,
    eventName: "Test Forum 2026",
    eventDate: new Date("2026-09-14T06:00:00Z"),
    eventVenue: "Madinat Jumeirah",
    eventCity: "Dubai",
    registrationType: "Physician",
    pricingTier: "Early Bird",
    price: 1200,
    taxAmount: 60,
    total: 1260,
    currency: "AED",
    taxRate: 5,
    taxLabel: "VAT",
    discountCode: null,
    discountAmount: 0,
    ...overrides,
  };
}

/**
 * pdfkit stays REAL here — these tests must prove a receipt actually renders,
 * not just that a branch was chosen. Observation is via prototype spies that
 * call through, so `image()` and `text()` still do their work.
 *
 * Reading the text back out of the finished PDF was tried first and abandoned:
 * pdfkit Flate-compresses its content streams AND subsets the font, so the
 * words on the page are glyph indices, not characters. A `pdf.includes("…")`
 * check returns false for text that IS on the page — an assertion that can
 * only ever fail, or worse, pass in the negative direction.
 */
type DrawProto = {
  image: (...args: unknown[]) => unknown;
  text: (...args: unknown[]) => unknown;
};
const drawProto = PDFDocument.prototype as unknown as DrawProto;

function drewTextStartingWith(calls: unknown[][], needle: string): boolean {
  return calls.some((args) => typeof args[0] === "string" && args[0].startsWith(needle));
}

/** How many times a given exact string was drawn. */
function countTextDraws(calls: unknown[][], text: string): number {
  return calls.filter((args) => args[0] === text).length;
}

describe("receipt masthead", () => {
  // Inferred rather than annotated: vitest's spyOn overloads resolve explicit
  // type arguments to `never`, so a hand-written annotation does not compile.
  const installSpies = () => ({
    image: vi.spyOn(drawProto, "image"),
    text: vi.spyOn(drawProto, "text"),
  });
  let spies: ReturnType<typeof installSpies>;

  beforeEach(() => {
    vi.clearAllMocks();
    spies = installSpies();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("embeds the logo at 100pt wide, in place of the duplicated company name", async () => {
    vi.mocked(loadLocalLogo).mockResolvedValue(WIDE_PNG);

    const pdf = await generateReceiptPDF(receiptData());

    expect(loadLocalLogo).toHaveBeenCalledWith("/uploads/media/2026/06/logo.png");
    expect(pdf.subarray(0, 4).toString()).toBe("%PDF");

    // Width is the specified 100pt; the height is a ceiling, and `fit` keeps
    // aspect ratio, so a tall logo shrinks rather than growing into the
    // "PAYMENT RECEIPT" line below it.
    expect(spies.image).toHaveBeenCalledWith(
      WIDE_PNG,
      50,
      26,
      expect.objectContaining({ fit: [100, 80] }),
    );

    // The 20pt masthead copy is gone. The name still appears exactly once,
    // in the FROM block — that is what makes replacing this one lossless.
    expect(countTextDraws(spies.text.mock.calls, "Meeting Minds FZ LLC")).toBe(1);
    expect(drewTextStartingWith(spies.text.mock.calls, "PAYMENT RECEIPT")).toBe(true);
  });

  it("lets the WIDTH bind for an ordinary logo, and everything below follows it", async () => {
    // The regression this exists for: the box first shipped as a 36pt height
    // ceiling, which bound before 100pt of width on any logo squarer than
    // 2.8:1 — MM Group's 245x169 rendered 52pt wide, half what was asked for.
    // A 4:3 fixture discriminates; a square one could not.
    vi.mocked(loadLocalLogo).mockResolvedValue(WIDE_PNG);

    await generateReceiptPDF(receiptData());

    // 4:3 into a 100x80 box -> 100 wide, 75 tall. Drawn from y=26, so the label
    // sits just under 101 — asserted as a range, since the point is that it
    // TRACKS the logo, not that it equals a magic number.
    const y = labelY(spies.text.mock.calls);
    expect(y).toBeGreaterThan(95);
    expect(y).toBeLessThan(115);
  });

  it("lets the HEIGHT bind for a vertical logo, so it cannot run into the info block", async () => {
    // 1:4 into a 100x80 box -> 20 wide, 80 tall. Without the ceiling this would
    // be 100 x 400 and would print straight through the FROM block.
    vi.mocked(loadLocalLogo).mockResolvedValue(TALL_PNG);

    await generateReceiptPDF(receiptData());

    const y = labelY(spies.text.mock.calls);
    expect(y).toBeGreaterThan(100);
    expect(y).toBeLessThan(120);
  });

  it("keeps the original masthead geometry when there is no logo", async () => {
    // The fallback path must not drift as the logo path grows: a logo-less org
    // should get byte-identical placement to what shipped before any of this.
    vi.mocked(loadLocalLogo).mockResolvedValue(null);

    await generateReceiptPDF(receiptData({ logoPath: null }));

    expect(labelY(spies.text.mock.calls)).toBe(55);
  });

  it("falls back to the org-name masthead when there is no logo", async () => {
    vi.mocked(loadLocalLogo).mockResolvedValue(null);

    await generateReceiptPDF(receiptData({ logoPath: null }));

    expect(spies.image).not.toHaveBeenCalled();
    // Twice now: masthead + FROM block. A logo-less org must not be left with
    // a blank top-left corner.
    expect(countTextDraws(spies.text.mock.calls, "Meeting Minds FZ LLC")).toBe(2);
  });

  it("uses orgName when the org has no separate company name", async () => {
    vi.mocked(loadLocalLogo).mockResolvedValue(null);

    await generateReceiptPDF(receiptData({ logoPath: null, companyName: null }));

    expect(countTextDraws(spies.text.mock.calls, "MM Group")).toBe(2);
  });

  it("still renders, and logs, when the logo bytes are undecodable", async () => {
    // A corrupt or unsupported image must not withhold proof of a payment that
    // already happened — and the fallback is chosen AFTER the draw attempt, so
    // a decode failure has to land on the same branch as "no logo" rather than
    // leaving the corner blank.
    vi.mocked(loadLocalLogo).mockResolvedValue(Buffer.from("not an image at all"));

    const pdf = await generateReceiptPDF(receiptData());

    expect(pdf.subarray(0, 4).toString()).toBe("%PDF");
    expect(countTextDraws(spies.text.mock.calls, "Meeting Minds FZ LLC")).toBe(2);
    expect(apiLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ msg: "receipt-pdf:logo-image-decode-failed" }),
    );
  });
});
