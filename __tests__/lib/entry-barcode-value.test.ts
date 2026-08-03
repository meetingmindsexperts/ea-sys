/**
 * Entry-barcode serial suffix (July 29, 2026, organizer request).
 *
 * Rendered entry barcodes encode `{qrCode}-{serialId padded to 3}` so a
 * hardware scanner dumping raw scans to a file identifies the person (the
 * suffix matches the "Registration #" shown across dashboard/CSV/emails).
 * The STORED `Registration.qrCode` stays the bare digits — changing stored
 * values would invalidate barcodes already delivered in emails — so check-in
 * must accept BOTH forms. These tests pin the value format and the
 * scanned-code parsing that keeps legacy + DTCM barcodes scanning.
 */
import { describe, it, expect } from "vitest";
import { entryBarcodeValue, scannedEntryCodeCandidates } from "@/lib/barcode";

describe("entryBarcodeValue", () => {
  it("appends the serial padded to 3 (matches the displayed Registration #)", () => {
    expect(entryBarcodeValue("1753791234567123456", 7)).toBe("1753791234567123456-007");
    expect(entryBarcodeValue("1753791234567123456", 42)).toBe("1753791234567123456-042");
  });

  it("serials past 999 keep their full width", () => {
    expect(entryBarcodeValue("123456", 1234)).toBe("123456-1234");
  });

  it("no serial ⇒ bare code (legacy rows, previews)", () => {
    expect(entryBarcodeValue("123456", null)).toBe("123456");
    expect(entryBarcodeValue("123456", undefined)).toBe("123456");
  });
});

describe("scannedEntryCodeCandidates", () => {
  it("suffixed scan offers both the full value and the bare stored code", () => {
    expect(scannedEntryCodeCandidates("1753791234567123456-007")).toEqual([
      "1753791234567123456-007",
      "1753791234567123456",
    ]);
  });

  it("legacy bare-digit scan (old badges/emails) matches as-is only", () => {
    expect(scannedEntryCodeCandidates("1753791234567123456")).toEqual(["1753791234567123456"]);
  });

  it("DTCM-shaped external values are never stripped", () => {
    // Non-digit prefix — not our shape.
    expect(scannedEntryCodeCandidates("ABX-778")).toEqual(["ABX-778"]);
    // Multi-dash — not our shape either.
    expect(scannedEntryCodeCandidates("123-456-789")).toEqual(["123-456-789"]);
    // Alphanumeric suffix.
    expect(scannedEntryCodeCandidates("123456-A7")).toEqual(["123456-A7"]);
  });

  it("a real DTCM UUID passes through exactly (matches Registration.dtcmBarcode as-is)", () => {
    // The externally-issued DTCM shape — hex + hyphens. Must never be
    // serial-stripped or the check-in `dtcmBarcode = scanned` match breaks.
    expect(scannedEntryCodeCandidates("f83dc515-ade6-46e8-b846-1f216f694b44")).toEqual([
      "f83dc515-ade6-46e8-b846-1f216f694b44",
    ]);
  });

  it("round-trip: candidates of a rendered value always include the stored code", () => {
    const stored = "1753791234567123456";
    for (const serial of [1, 99, 100, 4321]) {
      expect(scannedEntryCodeCandidates(entryBarcodeValue(stored, serial))).toContain(stored);
    }
  });
});
