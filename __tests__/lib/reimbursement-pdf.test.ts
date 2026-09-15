/**
 * The reimbursement claim PDF (Sep 15, 2026).
 *
 * pdfkit compresses its content streams and subsets fonts, so the text of a
 * finished PDF cannot be asserted by searching its bytes (receipt-pdf-masthead
 * test). These tests spy on PDFDocument.prototype.text with call-through, so the
 * document is genuinely rendered and what was drawn is still observable.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("@/lib/logger", () => ({
  apiLogger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));
vi.mock("@/lib/storage", () => ({ readStoredFile: vi.fn() }));

import PDFDocument from "pdfkit";
import {
  generateReimbursementPdf,
  readClaimLines,
  type ReimbursementPdfData,
} from "@/lib/reimbursement/reimbursement-pdf";
import { reimbursementPdfFilename } from "@/lib/reimbursement/constants";

function base(overrides: Partial<ReimbursementPdfData> = {}): ReimbursementPdfData {
  return {
    reimbursementId: "cmreimb0000abcdefgh",
    generatedAt: new Date("2026-09-15T08:00:00Z"),
    organization: {
      name: "MM Group",
      logo: null,
      companyName: "Meeting Minds FZ LLC",
      companyAddress: "508 & 509, DSC Tower",
      companyCity: "Dubai",
      companyState: null,
      companyZipCode: null,
      companyCountry: "United Arab Emirates",
      taxId: "100352048100003",
    },
    event: {
      name: "BRIDGES 2026",
      startDate: new Date("2026-10-01T05:00:00Z"),
      endDate: new Date("2026-10-03T12:00:00Z"),
      venue: "Conrad",
      city: "Dubai",
    },
    speaker: {
      fullName: "Ahmed Osman",
      designation: "Consultant",
      institution: "Cleveland Clinic",
      country: "United Arab Emirates",
      email: "ahmed@example.com",
      phone: "+971500000000",
      nationality: "Egyptian",
      passportNumber: "A1234567",
      roleAtEvent: "Speaker",
    },
    claimLines: [
      { item: "SPEAKER_FEE", currency: "USD", amount: 1500 },
      { item: "FLIGHT", currency: "USD", amount: 820.5 },
      { item: "HOTEL", currency: "AED", amount: 1200 },
    ],
    bankDetails: {
      beneficiaryName: "Ahmed Osman",
      bankName: "Emirates NBD",
      iban: "AE070331234567890123456",
      swift: "EBILAEAD",
    },
    documents: [
      { kind: "PASSPORT", filename: "passport.pdf", size: 120_000 },
      { kind: "FLIGHT_RECEIPT", filename: "flight.png", size: 48_000 },
    ],
    signedName: "Ahmed Osman",
    submittedAt: new Date("2026-09-14T10:30:00Z"),
    ...overrides,
  };
}

let drawn: string[];

beforeEach(() => {
  drawn = [];
  const original = PDFDocument.prototype.text;
  vi.spyOn(PDFDocument.prototype, "text").mockImplementation(function (this: PDFKit.PDFDocument, ...args: unknown[]) {
    if (typeof args[0] === "string") drawn.push(args[0]);
    return (original as (...a: unknown[]) => PDFKit.PDFDocument).apply(this, args);
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("generateReimbursementPdf", () => {
  it("renders a real PDF", async () => {
    const pdf = await generateReimbursementPdf(base());
    expect(pdf.subarray(0, 5).toString()).toBe("%PDF-");
  });

  it("totals each currency separately and never adds USD to AED", async () => {
    await generateReimbursementPdf(base());
    expect(drawn).toContain("Total (USD)");
    expect(drawn).toContain("USD 2,320.50");
    expect(drawn).toContain("Total (AED)");
    expect(drawn).toContain("AED 1,200.00");
    expect(drawn.some((s) => s.includes("3,520.50"))).toBe(false);
  });

  it("prints the bank details and passport number in full", async () => {
    await generateReimbursementPdf(base());
    expect(drawn).toContain("AE070331234567890123456");
    expect(drawn).toContain("A1234567");
    expect(drawn).toContain("EBILAEAD");
  });

  it("lists the documents without embedding them", async () => {
    await generateReimbursementPdf(base());
    expect(drawn.some((s) => s.startsWith("Passport copy (photo page): passport.pdf"))).toBe(true);
    expect(drawn.some((s) => s.startsWith("Flight receipt: flight.png"))).toBe(true);
  });

  it("does not fail on text Helvetica cannot encode", async () => {
    const pdf = await generateReimbursementPdf(
      base({
        speaker: { ...base().speaker, fullName: "أحمد عثمان", institution: "北京协和医院" },
        bankDetails: { beneficiaryName: "أحمد", bankName: "Bank", iban: "AE07", swift: "EBILAEAD", bankAddress: "😀 Street" },
      }),
    );
    expect(pdf.subarray(0, 5).toString()).toBe("%PDF-");
    expect(drawn.some((s) => /[^\x00-\xff–—•€™]/.test(s))).toBe(false);
  });

  it("says so when there are no documents and no claim lines", async () => {
    await generateReimbursementPdf(base({ documents: [], claimLines: [] }));
    expect(drawn).toContain("None uploaded.");
    expect(drawn).toContain("No claim lines.");
  });

  it("flows onto more pages instead of drawing past the footer", async () => {
    const documents = Array.from({ length: 40 }, (_, i) => ({ kind: "OTHER", filename: `receipt-${i}.pdf`, size: 1000 }));
    const pdf = await generateReimbursementPdf(base({ documents }));
    const pages = pdf.toString("latin1").match(/\/Type \/Page\b/g) ?? [];
    expect(pages.length).toBeGreaterThan(1);
  });
});

describe("readClaimLines", () => {
  it("keeps the lines that parse and counts the rest", () => {
    const { lines, dropped } = readClaimLines([
      { item: "FLIGHT", currency: "USD", amount: 10 },
      { item: "FLIGHT", currency: "EUR", amount: 10 },
      "junk",
    ]);
    expect(lines).toHaveLength(1);
    expect(dropped).toBe(2);
  });

  it("reads a non-array as no lines", () => {
    expect(readClaimLines(null)).toEqual({ lines: [], dropped: 0 });
  });
});

describe("reimbursementPdfFilename", () => {
  it("builds an ASCII name from the event and the person", () => {
    expect(reimbursementPdfFilename("BRIDGES 2026", "Dr. Ahmed Osman")).toBe("reimbursement-bridges-2026-dr-ahmed-osman.pdf");
  });

  it("shortens a long event name at a whole word", () => {
    expect(reimbursementPdfFilename("EHS International Mental Health Conference 2026", "Krishna Pallapolu")).toBe(
      "reimbursement-ehs-international-mental-health-krishna-pallapolu.pdf",
    );
  });

  it("drops what cannot be spelled in ASCII rather than emitting a broken header", () => {
    expect(reimbursementPdfFilename("BRIDGES 2026", "أحمد")).toBe("reimbursement-bridges-2026.pdf");
    expect(reimbursementPdfFilename(null, null)).toBe("reimbursement.pdf");
  });
});
