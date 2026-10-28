/**
 * A certificate's text is drawn in the PDF standard fonts, which encode WinAnsi only. On Oct 28, 2026
 * an accreditation reference pasted as "ACA‐20260003589" (U+2010, a Unicode hyphen) failed every
 * preview for its event with "WinAnsi cannot encode". The text is now cleaned before it is drawn.
 */
import { describe, it, expect, vi } from "vitest";
import { PDFDocument } from "pdf-lib";

vi.mock("@/lib/logger", () => ({ apiLogger: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
// A blank one-page background instead of a stored file.
vi.mock("@/lib/certificates/pdf-loader", () => ({
  loadCertificatePdfBytes: async () => {
    const doc = await PDFDocument.create();
    doc.addPage([842, 595]);
    return Buffer.from(await doc.save());
  },
}));

import { renderCertificate } from "@/lib/certificates/render";
import { buildPreviewCertificate } from "@/lib/certificates/sample-data";

const box = (content: string) => ({
  id: "b1", content, x: 100, y: 100, width: 600, height: 40,
  font: "Helvetica" as const, size: 18, color: "#1a2e5a", align: "center" as const,
});

describe("renderCertificate with text the standard fonts cannot encode", () => {
  it("draws a Unicode hyphen, smart quotes and a non-Latin name instead of failing", async () => {
    const data = buildPreviewCertificate({
      type: "ATTENDANCE",
      event: {
        id: "evt-1",
        name: "5th Expert Forum 2026",
        startDate: new Date("2026-10-01T00:00:00Z"),
        endDate: new Date("2026-10-02T00:00:00Z"),
        venue: "Riyadh",
        city: "Riyadh",
        country: "Saudi Arabia",
        cmeHours: 6,
        // The production value, Unicode hyphen included.
        settings: { cme: { accreditations: [{ body: "SCFHS", name: "Saudi Commission for Health Specialties", reference: "ACA‐20260003589" }] } },
        organization: { name: "Meeting Minds Group", logo: null },
      },
      template: {
        backgroundPdfUrl: "/uploads/certificates/bg.pdf",
        textBoxes: [box("Reference ACA‐20260003589"), box("“Excellence” in care"), box("Ćorović 李")],
      },
    } as unknown as Parameters<typeof buildPreviewCertificate>[0]);
    const pdf = await renderCertificate(data);
    expect(pdf.slice(0, 4).toString("ascii")).toBe("%PDF");
  }, 35_000);
});
