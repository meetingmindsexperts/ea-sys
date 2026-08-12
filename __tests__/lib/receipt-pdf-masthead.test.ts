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

/** Smallest valid PNG pdfkit will embed: 1x1, transparent. */
const TINY_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64",
);

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
    vi.mocked(loadLocalLogo).mockResolvedValue(TINY_PNG);

    const pdf = await generateReceiptPDF(receiptData());

    expect(loadLocalLogo).toHaveBeenCalledWith("/uploads/media/2026/06/logo.png");
    expect(pdf.subarray(0, 4).toString()).toBe("%PDF");

    // Width is the specified 100pt; the height is a ceiling, and `fit` keeps
    // aspect ratio, so a tall logo shrinks rather than growing into the
    // "PAYMENT RECEIPT" line below it.
    expect(spies.image).toHaveBeenCalledWith(
      TINY_PNG,
      50,
      26,
      expect.objectContaining({ fit: [100, 36] }),
    );

    // The 20pt masthead copy is gone. The name still appears exactly once,
    // in the FROM block — that is what makes replacing this one lossless.
    expect(countTextDraws(spies.text.mock.calls, "Meeting Minds FZ LLC")).toBe(1);
    expect(drewTextStartingWith(spies.text.mock.calls, "PAYMENT RECEIPT")).toBe(true);
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
