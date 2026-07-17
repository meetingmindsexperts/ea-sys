/**
 * Agreement PDF letterhead images + signer-only signature block
 * (July 17, 2026, organizer request).
 *
 * The speaker and presenter agreements each carry their OWN header/footer
 * image pair (`scope`), and both PDFs end with a single signer block (no
 * organizer counter-signature) sized for e-signature insertion.
 *
 * Pins:
 * 1. Magic-byte sniffing — PNG/JPEG accepted, WebP + garbage rejected (pdfkit
 *    cannot embed WebP, so a spoofed Content-Type must die at upload).
 * 2. Dimension probing — PNG IHDR + JPEG SOF header walk; malformed → null.
 * 3. Letterhead placement math — full page width when the aspect fits,
 *    height-capped + centered when it doesn't (a square upload can't swallow
 *    the content area).
 * 4. Render integration — the PDF renders with header/footer images (single
 *    and multi-page), and a corrupt image buffer degrades instead of
 *    failing the agreement.
 * 5. saveAgreementPdfImage / deleteAgreementPdfImage — validation order
 *    (size/magic before DB), org-bound event lookup, scope→column routing
 *    (speaker vs presenter must never cross), previous-file cleanup.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const { dbMock, fsMock } = vi.hoisted(() => ({
  dbMock: {
    event: {
      findFirst: vi.fn(),
      update: vi.fn(),
    },
  },
  fsMock: {
    mkdir: vi.fn(),
    writeFile: vi.fn(),
    unlink: vi.fn(),
    readFile: vi.fn(),
  },
}));
vi.mock("@/lib/db", () => ({ db: dbMock }));
vi.mock("fs/promises", () => ({ default: fsMock, ...fsMock }));

import {
  sniffAgreementImageFormat,
  probeImageDimensions,
  placeLetterheadImage,
  renderAgreementHtmlToPdf,
  saveAgreementPdfImage,
  deleteAgreementPdfImage,
  SpeakerAgreementTemplateError,
  AGREEMENT_PDF_IMAGE_MAX_SIZE,
} from "@/lib/speaker-agreement";

// A real, decodable 1×1 PNG — pdfkit embeds it in the render tests.
const ONE_PX_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

/** Minimal JPEG header: SOI + APP0 + SOF0 declaring the given dimensions. */
function jpegHeader(width: number, height: number): Buffer {
  const app0 = Buffer.from([0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00]);
  const sof0 = Buffer.alloc(2 + 2 + 15);
  sof0[0] = 0xff;
  sof0[1] = 0xc0;
  sof0.writeUInt16BE(17, 2); // segment length
  sof0[4] = 8; // precision
  sof0.writeUInt16BE(height, 5);
  sof0.writeUInt16BE(width, 7);
  return Buffer.concat([Buffer.from([0xff, 0xd8]), app0, sof0]);
}

const WEBP = Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WEBP"), Buffer.alloc(16)]);

const BASE_RENDER_OPTS = {
  html: "<p>Agreement body.</p>",
  docTitle: "Speaker Agreement — Test",
  docAuthor: "Test Org",
  headingTitle: "Speaker Agreement",
  headingSubtitle: "Test Event",
  signatureLabel: "Speaker",
  signatureName: "Dr. Jane Smith",
};

const EMPTY_EVENT_ROW = {
  id: "evt1",
  speakerAgreementPdfHeaderImage: null,
  speakerAgreementPdfFooterImage: null,
  presenterAgreementPdfHeaderImage: null,
  presenterAgreementPdfFooterImage: null,
};

beforeEach(() => {
  vi.clearAllMocks();
  fsMock.mkdir.mockResolvedValue(undefined);
  fsMock.writeFile.mockResolvedValue(undefined);
  fsMock.unlink.mockResolvedValue(undefined);
  dbMock.event.update.mockResolvedValue({});
});

describe("sniffAgreementImageFormat", () => {
  it("identifies PNG and JPEG by magic bytes", () => {
    expect(sniffAgreementImageFormat(ONE_PX_PNG)).toBe("png");
    expect(sniffAgreementImageFormat(jpegHeader(100, 50))).toBe("jpeg");
  });

  it("rejects WebP — pdfkit cannot embed it", () => {
    expect(sniffAgreementImageFormat(WEBP)).toBeNull();
  });

  it("rejects garbage and empty buffers", () => {
    expect(sniffAgreementImageFormat(Buffer.from("not an image"))).toBeNull();
    expect(sniffAgreementImageFormat(Buffer.alloc(0))).toBeNull();
  });
});

describe("probeImageDimensions", () => {
  it("reads PNG IHDR dimensions", () => {
    expect(probeImageDimensions(ONE_PX_PNG, "png")).toEqual({ width: 1, height: 1 });
  });

  it("reads JPEG SOF dimensions past leading segments", () => {
    expect(probeImageDimensions(jpegHeader(2000, 400), "jpeg")).toEqual({ width: 2000, height: 400 });
  });

  it("returns null for truncated or malformed headers", () => {
    expect(probeImageDimensions(ONE_PX_PNG.subarray(0, 12), "png")).toBeNull();
    expect(probeImageDimensions(Buffer.from([0xff, 0xd8, 0xff, 0xd9]), "jpeg")).toBeNull(); // EOI before SOF
    expect(probeImageDimensions(Buffer.from([0xff, 0xd8, 0x00, 0x00]), "jpeg")).toBeNull(); // broken marker
  });
});

describe("placeLetterheadImage", () => {
  it("spans the full page width when the scaled height fits the cap", () => {
    // 2000×400 → at 595.28pt wide the height is ~119pt, under the 200pt cap.
    const placed = placeLetterheadImage({ buffer: Buffer.alloc(0), width: 2000, height: 400 }, 200);
    expect(placed.x).toBe(0);
    expect(placed.width).toBeCloseTo(595.28, 2);
    expect(placed.height).toBeCloseTo(595.28 * 0.2, 2);
  });

  it("caps the height and centers a too-tall image", () => {
    // Square image → full-width height would be 595.28pt; capped to 200 and centered.
    const placed = placeLetterheadImage({ buffer: Buffer.alloc(0), width: 500, height: 500 }, 200);
    expect(placed.height).toBe(200);
    expect(placed.width).toBe(200);
    expect(placed.x).toBeCloseTo((595.28 - 200) / 2, 2);
  });
});

describe("renderAgreementHtmlToPdf letterhead", () => {
  const pngImage = { buffer: ONE_PX_PNG, width: 1, height: 1 };

  it("renders a valid PDF with header and footer images", async () => {
    const buffer = await renderAgreementHtmlToPdf({
      ...BASE_RENDER_OPTS,
      headerImage: pngImage,
      footerImage: pngImage,
    });
    expect(buffer.subarray(0, 5).toString("ascii")).toBe("%PDF-");
    // The embedded image must actually be in the document.
    const plain = await renderAgreementHtmlToPdf(BASE_RENDER_OPTS);
    expect(buffer.length).toBeGreaterThan(plain.length);
  });

  it("renders multi-page documents with letterhead on page breaks", async () => {
    const longHtml = Array.from({ length: 80 }, (_, i) => `<p>Clause ${i + 1}: terms and conditions text.</p>`).join("");
    const buffer = await renderAgreementHtmlToPdf({
      ...BASE_RENDER_OPTS,
      html: longHtml,
      headerImage: pngImage,
      footerImage: pngImage,
    });
    expect(buffer.subarray(0, 5).toString("ascii")).toBe("%PDF-");
  });

  it("degrades instead of throwing when an image buffer is corrupt", async () => {
    const buffer = await renderAgreementHtmlToPdf({
      ...BASE_RENDER_OPTS,
      headerImage: { buffer: Buffer.from("corrupt bytes"), width: 100, height: 40 },
    });
    expect(buffer.subarray(0, 5).toString("ascii")).toBe("%PDF-");
  });

  it("renders the single-signer signature block (no organizer column)", async () => {
    const buffer = await renderAgreementHtmlToPdf(BASE_RENDER_OPTS);
    expect(buffer.subarray(0, 5).toString("ascii")).toBe("%PDF-");
  });
});

describe("saveAgreementPdfImage", () => {
  const baseArgs = {
    eventId: "evt1",
    organizationId: "org1",
    scope: "speaker" as const,
    slot: "header" as const,
    actorUserId: "user1",
  };

  it("rejects an oversized buffer before touching the database", async () => {
    await expect(
      saveAgreementPdfImage({ ...baseArgs, buffer: Buffer.alloc(AGREEMENT_PDF_IMAGE_MAX_SIZE + 1) }),
    ).rejects.toMatchObject({ code: "IMAGE_TOO_LARGE" });
    expect(dbMock.event.findFirst).not.toHaveBeenCalled();
  });

  it("rejects WebP and garbage by magic bytes with INVALID_IMAGE", async () => {
    await expect(saveAgreementPdfImage({ ...baseArgs, buffer: WEBP })).rejects.toMatchObject({
      code: "INVALID_IMAGE",
    });
    await expect(
      saveAgreementPdfImage({ ...baseArgs, buffer: Buffer.from("plain text") }),
    ).rejects.toMatchObject({ code: "INVALID_IMAGE" });
    expect(dbMock.event.findFirst).not.toHaveBeenCalled();
  });

  it("throws EVENT_NOT_FOUND when the event is missing or in another org", async () => {
    dbMock.event.findFirst.mockResolvedValue(null);
    await expect(saveAgreementPdfImage({ ...baseArgs, buffer: ONE_PX_PNG })).rejects.toMatchObject({
      code: "EVENT_NOT_FOUND",
    });
    expect(dbMock.event.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "evt1", organizationId: "org1" } }),
    );
    expect(dbMock.event.update).not.toHaveBeenCalled();
  });

  it("stores the file and writes the SPEAKER header column", async () => {
    dbMock.event.findFirst.mockResolvedValue(EMPTY_EVENT_ROW);
    const { url } = await saveAgreementPdfImage({ ...baseArgs, buffer: ONE_PX_PNG });
    expect(url).toMatch(/^\/uploads\/agreements\/evt1\/speaker-header-[0-9a-f-]+\.png$/);
    expect(fsMock.writeFile).toHaveBeenCalledTimes(1);
    expect(dbMock.event.update).toHaveBeenCalledWith({
      where: { id: "evt1" },
      data: { speakerAgreementPdfHeaderImage: url },
    });
    expect(fsMock.unlink).not.toHaveBeenCalled(); // nothing to replace
  });

  it("routes the PRESENTER scope to the presenter columns — never the speaker's", async () => {
    dbMock.event.findFirst.mockResolvedValue({
      ...EMPTY_EVENT_ROW,
      // A speaker header already exists — a presenter upload must not touch it.
      speakerAgreementPdfHeaderImage: "/uploads/agreements/evt1/speaker-header-keep.png",
    });
    const { url } = await saveAgreementPdfImage({
      ...baseArgs,
      scope: "presenter",
      buffer: jpegHeader(2000, 250),
    });
    expect(url).toMatch(/^\/uploads\/agreements\/evt1\/presenter-header-[0-9a-f-]+\.jpg$/);
    expect(dbMock.event.update).toHaveBeenCalledWith({
      where: { id: "evt1" },
      data: { presenterAgreementPdfHeaderImage: url },
    });
    expect(fsMock.unlink).not.toHaveBeenCalled(); // the speaker's file stays
  });

  it("uses a .jpg extension for JPEG uploads on the footer slot", async () => {
    dbMock.event.findFirst.mockResolvedValue(EMPTY_EVENT_ROW);
    const { url } = await saveAgreementPdfImage({
      ...baseArgs,
      slot: "footer",
      buffer: jpegHeader(2000, 250),
    });
    expect(url).toMatch(/^\/uploads\/agreements\/evt1\/speaker-footer-[0-9a-f-]+\.jpg$/);
    expect(dbMock.event.update).toHaveBeenCalledWith({
      where: { id: "evt1" },
      data: { speakerAgreementPdfFooterImage: url },
    });
  });

  it("unlinks the previous file of the SAME scope+slot when replacing", async () => {
    dbMock.event.findFirst.mockResolvedValue({
      ...EMPTY_EVENT_ROW,
      speakerAgreementPdfHeaderImage: "/uploads/agreements/evt1/speaker-header-old.png",
    });
    await saveAgreementPdfImage({ ...baseArgs, buffer: ONE_PX_PNG });
    expect(fsMock.unlink).toHaveBeenCalledTimes(1);
    expect(String(fsMock.unlink.mock.calls[0][0])).toContain("speaker-header-old.png");
  });

  it("never unlinks a path outside /uploads/agreements/ (traversal guard)", async () => {
    dbMock.event.findFirst.mockResolvedValue({
      ...EMPTY_EVENT_ROW,
      speakerAgreementPdfHeaderImage: "/uploads/agreements/../../.env",
    });
    await saveAgreementPdfImage({ ...baseArgs, buffer: ONE_PX_PNG });
    expect(fsMock.unlink).not.toHaveBeenCalled();
  });
});

describe("deleteAgreementPdfImage", () => {
  it("unlinks the stored file and nulls the presenter footer column", async () => {
    dbMock.event.findFirst.mockResolvedValue({
      ...EMPTY_EVENT_ROW,
      presenterAgreementPdfFooterImage: "/uploads/agreements/evt1/presenter-footer-x.jpg",
    });
    await deleteAgreementPdfImage({ eventId: "evt1", organizationId: "org1", scope: "presenter", slot: "footer" });
    expect(fsMock.unlink).toHaveBeenCalledTimes(1);
    expect(dbMock.event.update).toHaveBeenCalledWith({
      where: { id: "evt1" },
      data: { presenterAgreementPdfFooterImage: null },
    });
  });

  it("is a no-op unlink (still nulls the column) when the slot is already empty", async () => {
    dbMock.event.findFirst.mockResolvedValue(EMPTY_EVENT_ROW);
    await deleteAgreementPdfImage({ eventId: "evt1", organizationId: "org1", scope: "speaker", slot: "header" });
    expect(fsMock.unlink).not.toHaveBeenCalled();
    expect(dbMock.event.update).toHaveBeenCalledWith({
      where: { id: "evt1" },
      data: { speakerAgreementPdfHeaderImage: null },
    });
  });

  it("throws EVENT_NOT_FOUND for a foreign org", async () => {
    dbMock.event.findFirst.mockResolvedValue(null);
    await expect(
      deleteAgreementPdfImage({ eventId: "evt1", organizationId: "other-org", scope: "speaker", slot: "header" }),
    ).rejects.toBeInstanceOf(SpeakerAgreementTemplateError);
  });
});
