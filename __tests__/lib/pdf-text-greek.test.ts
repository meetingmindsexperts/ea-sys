/**
 * Greek letters in PDFs (Nov 19, 2026). The built-in PDF font cannot draw
 * Greek, and the shared cleaner turned every Greek letter into "?": the
 * speaker agreement for "Improving Outcomes in β-Thalassemia" printed
 * "?-Thalassemia". Letters are now written out by name.
 */
import { describe, expect, it, vi } from "vitest";
import { inflateSync } from "node:zlib";

vi.mock("@/lib/db", () => ({ db: {} }));

import { sanitizePdfText } from "@/lib/pdf/pdf-text";
import { greekLetterName, toAsciiLetters } from "@/lib/event-slug";
import { renderAgreementHtmlToPdf } from "@/lib/speaker-agreement";

/** The text a pdfkit PDF draws: inflate each stream, decode the hex strings of its TJ arrays. */
function drawnText(pdf: Buffer): string {
  const raw = pdf.toString("latin1");
  let text = "";
  for (const m of raw.matchAll(/stream\r?\n([\s\S]*?)\r?\nendstream/g)) {
    let body: string;
    try {
      body = inflateSync(Buffer.from(m[1], "latin1")).toString("latin1");
    } catch {
      continue;
    }
    for (const t of body.matchAll(/\[(.*?)\]\s*TJ/g)) {
      for (const h of t[1].matchAll(/<([0-9a-fA-F]+)>/g)) text += Buffer.from(h[1], "hex").toString("latin1");
    }
    text += "\n";
  }
  return text;
}

describe("sanitizePdfText and Greek letters", () => {
  it("writes a Greek letter out by name instead of '?'", () => {
    expect(sanitizePdfText("Improving Outcomes in β-Thalassemia")).toBe("Improving Outcomes in beta-Thalassemia");
    expect(sanitizePdfText("α, γ and δ")).toBe("alpha, gamma and delta");
  });

  it("capitalises an upper-case Greek letter", () => {
    expect(sanitizePdfText("Δ group, Ω")).toBe("Delta group, Omega");
  });

  it("keeps 'μg' readable as the micro sign, which the font can draw", () => {
    expect(sanitizePdfText("5 μg")).toBe("5 µg");
  });

  it("still turns what it cannot name into '?' (Arabic, CJK, emoji)", () => {
    expect(sanitizePdfText("مرحبا 你好 😀")).toBe("????? ?? ?");
  });

  it("leaves accented Latin letters and the usual typography alone", () => {
    expect(sanitizePdfText("Café – Zürich — 10 €")).toBe("Café – Zürich — 10 €");
  });

  it("uses the same letter names as event web addresses (one table)", () => {
    expect(greekLetterName("β")).toBe("beta");
    expect(greekLetterName("Β")).toBe("Beta");
    expect(greekLetterName("b")).toBeNull();
    expect(toAsciiLetters("β-Thalassemia")).toBe("beta-Thalassemia");
  });
});

describe("the speaker agreement PDF", () => {
  it("prints a Greek letter by name in the body, the heading and the signature, never '?'", async () => {
    const pdf = await renderAgreementHtmlToPdf({
      html: "<p>Speaker agreement for Improving Outcomes in β-Thalassemia, dose 5 μg.</p>",
      docTitle: "Speaker Agreement",
      docAuthor: "Test Org",
      headingTitle: "Agreement: β-Thalassemia",
      headingSubtitle: "Improving Outcomes in β-Thalassemia",
      signatureLabel: "Speaker",
      signatureName: "Dr Δ Test",
    });

    const text = drawnText(pdf);
    expect(text).toContain("beta-Thalassemia");
    expect(text).toContain("Agreement: beta-Thalassemia");
    expect(text).toContain("Dr Delta Test");
    expect(text).toContain("5 µg");
    expect(text).not.toContain("?-Thalassemia");
  });
});
