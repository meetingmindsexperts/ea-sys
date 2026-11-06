/** The file signature table: the bytes decide what a file is (Nov 6, 2026). */
import { describe, expect, it } from "vitest";
import { extensionMatches, signatureMatches, typeFromExtension } from "@/lib/file-signature";

const bytes = (...b: number[]) => Uint8Array.from(b);

describe("signatureMatches", () => {
  it("recognises each type by its first bytes", () => {
    expect(signatureMatches(new TextEncoder().encode("%PDF-1.4"), "application/pdf")).toBe(true);
    expect(signatureMatches(bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a), "image/png")).toBe(true);
    expect(signatureMatches(bytes(0xff, 0xd8, 0xff, 0xe0), "image/jpeg")).toBe(true);
    expect(signatureMatches(new TextEncoder().encode("GIF89a"), "image/gif")).toBe(true);
    expect(signatureMatches(bytes(0x50, 0x4b, 0x03, 0x04), "application/vnd.openxmlformats-officedocument.presentationml.presentation")).toBe(true);
  });

  it("tells WebP from other RIFF files (WAV)", () => {
    expect(signatureMatches(new TextEncoder().encode("RIFF\0\0\0\0WEBPVP8 "), "image/webp")).toBe(true);
    expect(signatureMatches(new TextEncoder().encode("RIFF\0\0\0\0WAVEfmt "), "image/webp")).toBe(false);
  });

  it("finds a PDF header anywhere in the first 1,024 bytes, not beyond", () => {
    const at = (n: number) => Uint8Array.from([...new Array(n).fill(0x20), ...new TextEncoder().encode("%PDF-1.7")]);
    expect(signatureMatches(at(3), "application/pdf")).toBe(true);
    expect(signatureMatches(at(1000), "application/pdf")).toBe(true);
    expect(signatureMatches(at(1100), "application/pdf")).toBe(false);
  });

  it("refuses a mismatch, a short buffer and an unknown type", () => {
    expect(signatureMatches(new TextEncoder().encode("<html>"), "application/pdf")).toBe(false);
    expect(signatureMatches(bytes(0x25), "application/pdf")).toBe(false);
    expect(signatureMatches(new TextEncoder().encode("%PDF-1.4"), "text/html")).toBe(false);
  });
});

describe("extensions", () => {
  it("maps an unambiguous extension to its type, case-insensitively", () => {
    expect(typeFromExtension("Prospectus.PDF")).toBe("application/pdf");
    expect(typeFromExtension("photo.jpeg")).toBe("image/jpeg");
    expect(typeFromExtension("archive.zip")).toBeNull();
    expect(typeFromExtension("noext")).toBeNull();
  });

  it("checks a name against a type", () => {
    expect(extensionMatches("deck.pptx", "application/vnd.openxmlformats-officedocument.presentationml.presentation")).toBe(true);
    expect(extensionMatches("run.exe", "application/pdf")).toBe(false);
  });
});
