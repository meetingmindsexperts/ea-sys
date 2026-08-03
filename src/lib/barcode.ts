/**
 * Server-side Code 128 barcode rendering.
 *
 * Single source of truth for turning a barcode string into a PNG buffer so
 * the printed badge (pdfkit) and the on-screen barcode image endpoints all
 * produce byte-identical, scannable output. bwip-js is CommonJS-only and
 * stays server-side — never import this from a client component.
 */

// eslint-disable-next-line @typescript-eslint/no-require-imports
const bwipjs = require("bwip-js");

import { formatSerialId } from "@/lib/registration-serial";

/**
 * Value ENCODED in every rendered entry barcode (badge PDF, portal/admin PNG,
 * confirmation-email PNG): `{qrCode}-{serialId padded to 3}`, e.g.
 * `1753791234567123456-007`.
 *
 * Why: a hardware scanner dumping scans to a file captures only the encoded
 * value, and the bare qrCode is opaque — the suffix lets an organizer map a
 * scan line back to a person via the "Registration #" shown across the
 * dashboard/CSV/emails (same 3-digit padding). The STORED `Registration.qrCode`
 * stays the bare code — changing stored values would invalidate barcodes
 * already delivered in confirmation emails. Check-in accepts BOTH forms via
 * `scannedEntryCodeCandidates()` below, so pre-existing printed/emailed
 * barcodes keep scanning.
 */
export function entryBarcodeValue(qrCode: string, serialId?: number | null): string {
  if (serialId == null) return qrCode;
  return `${qrCode}-${formatSerialId(serialId)}`;
}

/**
 * The values a scanned entry code may correspond to in `Registration.qrCode`.
 *
 * Always includes the scanned string as-is (legacy badges/emails encode the
 * bare code; DTCM barcodes are arbitrary external values and must match
 * exactly). When the scan looks like our suffixed form (bare digits + `-` +
 * digit serial — stored qrCodes are digits-only, so the shape is unambiguous
 * for OUR values), the bare prefix is offered as a second candidate.
 */
export function scannedEntryCodeCandidates(scanned: string): string[] {
  const m = /^(\d+)-(\d{1,6})$/.exec(scanned);
  return m ? [scanned, m[1]] : [scanned];
}

export interface RenderBarcodeOptions {
  /**
   * When true, bwip-js draws the human-readable value beneath the bars
   * (the look used for the screen images). The badge PDF passes false
   * because it draws the registration number itself in a separate cell.
   */
  includetext?: boolean;
  /** Module width multiplier. Default 2 — matches the badge render. */
  scale?: number;
  /** Bar height in millimetres (bwip-js unit). Default 14 — matches the badge. */
  height?: number;
}

/**
 * Render `text` as a Code 128 barcode PNG. Returns a Buffer suitable for
 * embedding in a PDF (`doc.image`) or streaming as an `image/png` response.
 *
 * Throws if bwip-js can't encode the value (e.g. empty string) — callers
 * should guard against empty/whitespace input first.
 */
export async function renderBarcodePng(
  text: string,
  opts: RenderBarcodeOptions = {},
): Promise<Buffer> {
  const { includetext = false, scale = 2, height = 14 } = opts;
  return bwipjs.toBuffer({
    bcid: "code128",
    text,
    scale,
    height,
    includetext,
    // Only meaningful when includetext is true — keeps the digits legible
    // and centred under the bars.
    ...(includetext ? { textxalign: "center", textsize: 11 } : {}),
  });
}

/**
 * Render `text` as a QR code PNG. Used for the DTCM compliance barcode on the
 * badge + detail sheet: DTCM values are externally-issued 36-char UUIDs, which
 * as Code 128 would need ~430 bar modules (~0.19mm bars at badge width —
 * unscannable on a 300-dpi print), while a QR holds them comfortably at
 * 14mm square. The ENTRY barcode stays Code 128 (`renderBarcodePng`) so
 * existing desk laser scanners keep working; DTCM is scanned by inspectors'
 * 2D imagers/phones and by our camera check-in scanner (html5-qrcode decodes
 * both symbologies).
 *
 * Throws if bwip-js can't encode the value (e.g. empty string) — callers
 * should guard against empty/whitespace input first.
 */
export async function renderQrPng(
  text: string,
  opts: { scale?: number } = {},
): Promise<Buffer> {
  const { scale = 3 } = opts;
  return bwipjs.toBuffer({
    bcid: "qrcode",
    text,
    scale,
    // Error-correction M — standard print redundancy without inflating the
    // module count for a 36-char payload.
    eclevel: "M",
  });
}
