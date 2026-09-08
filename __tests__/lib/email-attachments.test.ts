/**
 * Email attachments, server side (src/lib/email-attachments.ts).
 *
 * Since Sep 8, 2026 a send body carries storage REFERENCES; the resolver
 * binds each to the event, reads the bytes, and re-checks them. The bytes
 * check is shared with the upload route, so it is pinned on its own too.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { readStoredFile, warn } = vi.hoisted(() => ({ readStoredFile: vi.fn(), warn: vi.fn() }));
vi.mock("@/lib/storage", () => ({ readStoredFile }));
vi.mock("@/lib/logger", () => ({ apiLogger: { info: vi.fn(), warn, error: vi.fn(), debug: vi.fn() } }));

import { checkAttachmentBytes, resolveStoredAttachments, sanitizeAttachmentFilename } from "@/lib/email-attachments";

const PDF_MIME = "application/pdf";
const DOC_MIME = "application/msword";
const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const PDF_MAGIC = [0x25, 0x50, 0x44, 0x46, 0x2d];
const DOC_MAGIC = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];
const DOCX_MAGIC = [0x50, 0x4b, 0x03, 0x04];
const bytes = (magic: number[], pad = 0) => Buffer.concat([Buffer.from(magic), Buffer.alloc(pad, 0x20)]);
const PREFIX = "/uploads/email-attachments/ev1/";
const ref = (name: string, contentType = PDF_MIME, path = `${PREFIX}a.pdf`) => ({ storedPath: path, name, contentType });

beforeEach(() => vi.clearAllMocks());

describe("checkAttachmentBytes", () => {
  it("accepts the three allowed types when the magic bytes match", () => {
    expect(checkAttachmentBytes(bytes(PDF_MAGIC, 10), PDF_MIME, "a.pdf")).toEqual({ ok: true });
    expect(checkAttachmentBytes(bytes(DOC_MAGIC, 10), DOC_MIME, "a.doc")).toEqual({ ok: true });
    expect(checkAttachmentBytes(bytes(DOCX_MAGIC, 10), DOCX_MIME, "a.docx")).toEqual({ ok: true });
  });
  it("refuses an unsupported type, an empty file, a spoofed type, and a file over 5 MB", () => {
    expect(checkAttachmentBytes(bytes([0x89, 0x50, 0x4e, 0x47]), "image/png", "p.png")).toMatchObject({ ok: false, code: "UNSUPPORTED_TYPE" });
    expect(checkAttachmentBytes(Buffer.alloc(0), PDF_MIME, "e.pdf")).toMatchObject({ ok: false, code: "EMPTY_FILE" });
    expect(checkAttachmentBytes(bytes(DOCX_MAGIC, 10), PDF_MIME, "evil.pdf")).toMatchObject({ ok: false, code: "CONTENT_MISMATCH" });
    expect(checkAttachmentBytes(bytes(PDF_MAGIC, 5 * 1024 * 1024), PDF_MIME, "big.pdf")).toMatchObject({ ok: false, code: "TOO_LARGE" });
    // Exactly 5 MB is allowed; the cap is per FILE, not a total.
    expect(checkAttachmentBytes(bytes(PDF_MAGIC, 5 * 1024 * 1024 - PDF_MAGIC.length), PDF_MIME, "max.pdf")).toEqual({ ok: true });
  });
});

describe("resolveStoredAttachments", () => {
  it("returns ok + empty for no references", async () => {
    expect(await resolveStoredAttachments(undefined, "ev1")).toEqual({ ok: true, attachments: [] });
    expect(await resolveStoredAttachments([], "ev1")).toEqual({ ok: true, attachments: [] });
    expect(readStoredFile).not.toHaveBeenCalled();
  });

  it("reads the bytes through the prefix guard and returns base64 with a sanitised name", async () => {
    readStoredFile.mockResolvedValueOnce(bytes(PDF_MAGIC, 20));
    const res = await resolveStoredAttachments([ref("../../etc/agenda")], "ev1");
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.attachments[0]).toEqual({
      name: "agenda.pdf",
      content: bytes(PDF_MAGIC, 20).toString("base64"),
      contentType: PDF_MIME,
    });
    expect(readStoredFile).toHaveBeenCalledWith(`${PREFIX}a.pdf`, "/uploads/email-attachments/");
  });

  it("refuses a reference outside THIS event's prefix before any read (no cross-event fetch)", async () => {
    const foreign = await resolveStoredAttachments([ref("x.pdf", PDF_MIME, "/uploads/email-attachments/ev2/a.pdf")], "ev1");
    expect(foreign).toMatchObject({ ok: false, code: "INVALID_ATTACHMENT" });
    const traversal = await resolveStoredAttachments([ref("x.pdf", PDF_MIME, `${PREFIX}../ev2/a.pdf`)], "ev1");
    expect(traversal).toMatchObject({ ok: false, code: "INVALID_ATTACHMENT" });
    const otherStore = await resolveStoredAttachments([ref("x.pdf", PDF_MIME, "/uploads/speaker-docs/ev1/a.pdf")], "ev1");
    expect(otherStore).toMatchObject({ ok: false, code: "INVALID_ATTACHMENT" });
    expect(readStoredFile).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(expect.objectContaining({ msg: "email-attachments:path-outside-event" }));
  });

  it("a file gone from storage is a named refusal, not a 500", async () => {
    readStoredFile.mockRejectedValueOnce(Object.assign(new Error("gone"), { reason: "not-found" }));
    const res = await resolveStoredAttachments([ref("agenda.pdf")], "ev1");
    expect(res).toMatchObject({ ok: false, code: "ATTACHMENT_MISSING" });
    expect(warn).toHaveBeenCalledWith(expect.objectContaining({ msg: "email-attachments:read-failed", reason: "not-found" }));
  });

  it("re-checks the bytes at send time, so a swapped file in storage is still refused", async () => {
    readStoredFile.mockResolvedValueOnce(bytes(DOCX_MAGIC, 10)); // claims PDF, is a zip
    const res = await resolveStoredAttachments([ref("agenda.pdf")], "ev1");
    expect(res).toMatchObject({ ok: false, code: "CONTENT_MISMATCH" });
  });

  it("caps the count and collapses the same file referenced twice into one attachment", async () => {
    const one = ref("a.pdf");
    expect(await resolveStoredAttachments([one, one, one, one], "ev1")).toMatchObject({ ok: false, code: "TOO_MANY_FILES" });
    readStoredFile.mockResolvedValue(bytes(PDF_MAGIC, 10));
    const res = await resolveStoredAttachments([one, one], "ev1");
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.attachments).toHaveLength(1);
    expect(readStoredFile).toHaveBeenCalledTimes(1);
  });
});

describe("sanitizeAttachmentFilename", () => {
  it("strips a path and forces the extension", () => {
    expect(sanitizeAttachmentFilename("../../etc/agenda", PDF_MIME)).toBe("agenda.pdf");
    expect(sanitizeAttachmentFilename("C:\\x\\letter.DOCX", DOCX_MIME)).toBe("letter.DOCX");
    expect(sanitizeAttachmentFilename("", PDF_MIME)).toBe("attachment.pdf");
  });
});
