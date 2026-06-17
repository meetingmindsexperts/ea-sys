/**
 * Entry-barcode template token (`{{entryBarcode}}`) — organizer-controlled.
 *
 * The attendee entry barcode used to be hard-appended to every in-person
 * registration confirmation. Organizers wanted control over whether it
 * appears (in the auto-confirmation AND in bulk sends), so it's now a
 * template token: place `{{entryBarcode}}` in an email template's HTML and
 * the recipient's barcode renders there; remove it and there's no barcode.
 *
 * Mechanics mirror the existing inline-image pattern (`cid:reg-barcode` +
 * a sibling PNG part), so the image renders offline in the inbox and stays
 * scannable at the registration desk with no remote fetch.
 *
 * Token pair (same convention as passcodeBlock/passcodeBlockText etc. — the
 * renderer uses one var map for both HTML and plain-text bodies):
 *   - `{{entryBarcode}}`     → raw-HTML `<img cid:reg-barcode>` block (HTML body)
 *   - `{{entryBarcodeText}}` → plain-text "Your entry barcode: <code>" (text body)
 * `entryBarcode` is registered in `DEFAULT_RAW_HTML_KEYS` so it renders unescaped.
 */
import { renderBarcodePng } from "./barcode";

/** Var key for the raw-HTML barcode block (must be in DEFAULT_RAW_HTML_KEYS). */
export const ENTRY_BARCODE_VAR = "entryBarcode";
/** Var key for the plain-text barcode line (used in text bodies). */
export const ENTRY_BARCODE_TEXT_VAR = "entryBarcodeText";

/** The inline image content-id the HTML block references. */
const BARCODE_CONTENT_ID = "reg-barcode";

// Matches either token, tolerant of inner whitespace: {{ entryBarcode }} etc.
const ENTRY_BARCODE_TOKEN_RE = /\{\{\s*entryBarcode(Text)?\s*\}\}/;

/**
 * True when any of the supplied template parts contains the `{{entryBarcode}}`
 * (or `{{entryBarcodeText}}`) token — i.e. the organizer opted the barcode in.
 * When false, callers skip all barcode work.
 */
export function templateUsesEntryBarcode(
  ...parts: Array<string | null | undefined>
): boolean {
  return parts.some((p) => p != null && ENTRY_BARCODE_TOKEN_RE.test(p));
}

export interface EntryBarcode {
  /** Raw-HTML block referencing the inline cid:reg-barcode image. */
  html: string;
  /** Plain-text equivalent for text bodies. */
  text: string;
  /** Inline PNG attachment (carries the cid the html block references). */
  attachment: {
    name: string;
    content: string; // base64
    contentType: string;
    contentId: string;
  };
}

/**
 * Render a recipient's entry barcode for the token.
 *
 * Returns `null` when there's no in-person barcode to render (virtual
 * attendance or a missing qrCode) — callers then substitute the token with
 * an empty string so the placeholder cleanly disappears.
 *
 * Throws if the underlying barcode render fails; callers treat that as
 * non-fatal (log + send without the barcode), matching prior behavior.
 */
export async function buildEntryBarcode(params: {
  qrCode?: string | null;
  attendanceMode?: "IN_PERSON" | "VIRTUAL" | null;
}): Promise<EntryBarcode | null> {
  // Virtual attendees have no entry barcode; neither does a registration
  // missing its qrCode (e.g. virtual rows never mint one).
  if (params.attendanceMode === "VIRTUAL" || !params.qrCode) return null;

  const png = await renderBarcodePng(params.qrCode, { includetext: true });

  return {
    html: `<div style="text-align:center; margin:24px 0; padding:16px; background:#ffffff; border:1px solid #e5e7eb; border-radius:8px;">
        <p style="margin:0 0 8px; font-size:12px; letter-spacing:0.05em; color:#6b7280; font-weight:600;">YOUR ENTRY BARCODE</p>
        <img src="cid:${BARCODE_CONTENT_ID}" alt="Entry barcode" style="display:block; margin:0 auto; max-width:280px; height:auto;" />
        <p style="margin:10px 0 0; font-size:12px; color:#6b7280;">Show this at the registration desk for check-in.</p>
      </div>`,
    text: `\n\nYour entry barcode: ${params.qrCode}\nShow this at the registration desk for check-in.`,
    attachment: {
      name: "entry-barcode.png",
      content: png.toString("base64"),
      contentType: "image/png",
      contentId: BARCODE_CONTENT_ID,
    },
  };
}
