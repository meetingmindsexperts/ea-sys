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
