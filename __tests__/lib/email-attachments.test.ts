import { describe, it, expect } from "vitest";
import { validateManualAttachments } from "@/lib/email-attachments";

const PDF_MIME = "application/pdf";
const DOC_MIME = "application/msword";
const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

/** Build a base64 payload from magic bytes + optional padding. */
function b64(magic: number[], padBytes = 0): string {
  return Buffer.concat([Buffer.from(magic), Buffer.alloc(padBytes, 0x20)]).toString("base64");
}

const PDF_MAGIC = [0x25, 0x50, 0x44, 0x46, 0x2d]; // %PDF-
const DOC_MAGIC = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]; // OLE2
const DOCX_MAGIC = [0x50, 0x4b, 0x03, 0x04]; // ZIP

describe("validateManualAttachments", () => {
  it("returns ok + empty for no attachments", () => {
    expect(validateManualAttachments(undefined)).toEqual({ ok: true, attachments: [] });
    expect(validateManualAttachments([])).toEqual({ ok: true, attachments: [] });
  });

  it("accepts a valid PDF and preserves the filename", () => {
    const res = validateManualAttachments([{ name: "agenda.pdf", content: b64(PDF_MAGIC, 100), contentType: PDF_MIME }]);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.attachments).toHaveLength(1);
      expect(res.attachments[0].name).toBe("agenda.pdf");
      expect(res.attachments[0].contentType).toBe(PDF_MIME);
    }
  });

  it("accepts valid DOC and DOCX", () => {
    const res = validateManualAttachments([
      { name: "letter.doc", content: b64(DOC_MAGIC, 50), contentType: DOC_MIME },
      { name: "form.docx", content: b64(DOCX_MAGIC, 50), contentType: DOCX_MIME },
    ]);
    expect(res.ok).toBe(true);
  });

  it("rejects an unsupported MIME type", () => {
    const res = validateManualAttachments([{ name: "pic.png", content: b64([0x89, 0x50, 0x4e, 0x47]), contentType: "image/png" }]);
    expect(res).toMatchObject({ ok: false, code: "UNSUPPORTED_TYPE" });
  });

  it("rejects a spoofed contentType (magic-byte mismatch)", () => {
    // Claims PDF but the bytes are a ZIP (.docx) header.
    const res = validateManualAttachments([{ name: "evil.pdf", content: b64(DOCX_MAGIC, 100), contentType: PDF_MIME }]);
    expect(res).toMatchObject({ ok: false, code: "CONTENT_MISMATCH" });
  });

  it("rejects more than the max file count", () => {
    const one = { name: "a.pdf", content: b64(PDF_MAGIC, 10), contentType: PDF_MIME };
    const res = validateManualAttachments([one, one, one, one]);
    expect(res).toMatchObject({ ok: false, code: "TOO_MANY_FILES" });
  });

  it("rejects when the total decoded size exceeds 10 MB", () => {
    const big = { name: "big.pdf", content: b64(PDF_MAGIC, 6 * 1024 * 1024), contentType: PDF_MIME };
    const res = validateManualAttachments([big, big]); // ~12 MB total
    expect(res).toMatchObject({ ok: false, code: "TOO_LARGE" });
  });

  it("rejects an empty file", () => {
    const res = validateManualAttachments([{ name: "empty.pdf", content: "", contentType: PDF_MIME }]);
    expect(res).toMatchObject({ ok: false, code: "EMPTY_FILE" });
  });

  it("strips a path and forces the extension on the filename", () => {
    const res = validateManualAttachments([{ name: "../../etc/agenda", content: b64(PDF_MAGIC, 10), contentType: PDF_MIME }]);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.attachments[0].name).toBe("agenda.pdf");
  });
});
