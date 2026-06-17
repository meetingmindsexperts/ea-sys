/**
 * Entry-barcode token (`{{entryBarcode}}`) — organizer-controlled barcode.
 * The barcode renders only where a template carries the token, and only for
 * in-person registrations with a qrCode. These tests pin token detection and
 * the build helper's render/skip decisions (renderBarcodePng is mocked so the
 * suite stays fast and deterministic).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/barcode", () => ({
  renderBarcodePng: vi.fn(async () => Buffer.from("PNGDATA")),
}));

import { renderBarcodePng } from "@/lib/barcode";
import {
  templateUsesEntryBarcode,
  buildEntryBarcode,
} from "@/lib/email-barcode";

describe("templateUsesEntryBarcode", () => {
  it("detects the {{entryBarcode}} token (incl. inner whitespace)", () => {
    expect(templateUsesEntryBarcode("<p>{{entryBarcode}}</p>")).toBe(true);
    expect(templateUsesEntryBarcode("{{ entryBarcode }}")).toBe(true);
  });

  it("detects the {{entryBarcodeText}} token", () => {
    expect(templateUsesEntryBarcode("Code: {{entryBarcodeText}}")).toBe(true);
  });

  it("checks every supplied part (html OR text)", () => {
    expect(templateUsesEntryBarcode("<p>no token</p>", "text {{entryBarcode}}")).toBe(true);
  });

  it("is false when the token is absent", () => {
    expect(templateUsesEntryBarcode("<p>Welcome {{firstName}}</p>", "Welcome")).toBe(false);
    expect(templateUsesEntryBarcode(null, undefined)).toBe(false);
  });

  it("does not match an unrelated token", () => {
    expect(templateUsesEntryBarcode("{{entryBarcodeXYZ}}")).toBe(false);
  });
});

describe("buildEntryBarcode", () => {
  beforeEach(() => vi.clearAllMocks());

  it("renders html + text + inline attachment for in-person + qrCode", async () => {
    const result = await buildEntryBarcode({ qrCode: "ABC123", attendanceMode: "IN_PERSON" });
    expect(result).not.toBeNull();
    expect(result!.html).toContain('src="cid:reg-barcode"');
    expect(result!.text).toContain("ABC123");
    expect(result!.attachment).toEqual({
      name: "entry-barcode.png",
      content: Buffer.from("PNGDATA").toString("base64"),
      contentType: "image/png",
      contentId: "reg-barcode",
    });
    expect(renderBarcodePng).toHaveBeenCalledWith("ABC123", { includetext: true });
  });

  it("returns null for virtual attendance (no entry barcode)", async () => {
    const result = await buildEntryBarcode({ qrCode: "ABC123", attendanceMode: "VIRTUAL" });
    expect(result).toBeNull();
    expect(renderBarcodePng).not.toHaveBeenCalled();
  });

  it("returns null when there's no qrCode", async () => {
    expect(await buildEntryBarcode({ qrCode: null, attendanceMode: "IN_PERSON" })).toBeNull();
    expect(await buildEntryBarcode({ qrCode: "", attendanceMode: "IN_PERSON" })).toBeNull();
    expect(renderBarcodePng).not.toHaveBeenCalled();
  });

  it("treats a missing attendanceMode as in-person (renders when qrCode present)", async () => {
    const result = await buildEntryBarcode({ qrCode: "XYZ" });
    expect(result).not.toBeNull();
  });

  it("propagates a render failure (caller treats as non-fatal)", async () => {
    vi.mocked(renderBarcodePng).mockRejectedValueOnce(new Error("boom"));
    await expect(buildEntryBarcode({ qrCode: "ABC", attendanceMode: "IN_PERSON" })).rejects.toThrow("boom");
  });
});
