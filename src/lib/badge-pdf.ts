/**
 * Badge PDF rendering.
 *
 * Extracted from the badges route on Aug 25 2026 so the print run and the
 * settings preview cannot drift: a preview that renders through a second
 * implementation is worse than no preview, because it tells the organiser
 * their calibration is right when it is not.
 *
 * Interior geometry is laid out against absolute offsets from the badge's
 * top-left corner (registration number at +14, name +30, organisation and
 * country +72, barcode +95, the role row +145), tuned for the original
 * 288x216pt card. Now that the size is organiser-controlled, every one of
 * those is multiplied through `badgeScale`. At the default size all three
 * factors are exactly 1, so the output is byte-identical to what this event
 * has always printed.
 *
 * The name's band is DERIVED (badgeNameBandH = detail top - name top) rather
 * than given a fixed allowance, so a name at any organiser-chosen size wraps
 * and ellipsises inside its own space instead of over the line below it.
 *
 * The barcode row is the exception: its offsets come from `resolveBarcodeRow`
 * in badge-layout.ts, because the organiser can put the DTCM QR either in its
 * own band below the bottom row (the historical +172) or beside the bars, and
 * the settings card's "too narrow to scan" warning has to predict the same
 * widths this file draws.
 */
import PDFDocument from "pdfkit";
import { apiLogger } from "@/lib/logger";
import { formatSerialId } from "@/lib/registration-serial";
import { renderBarcodePng, renderQrPng, entryBarcodeValue } from "@/lib/barcode";
import { mapWithConcurrency } from "@/lib/concurrency";
import {
  BASE_MARGIN,
  badgeDetailTop,
  badgeNameBandH,
  badgeNameTop,
  badgeScale,
  badgeSerialTop,
  resolveBadgeOrigin,
  resolveBarcodeRow,
  type BadgeLayout,
} from "@/lib/badge-layout";

/**
 * Max simultaneous CPU-bound barcode rasterizations — keeps the event loop
 * responsive for latency-critical requests (check-in, webhooks) during a print.
 */
const BARCODE_RENDER_CONCURRENCY = 8;

export interface BadgeRegistration {
  id: string;
  serialId: number | null;
  qrCode: string | null;
  dtcmBarcode: string | null;
  badgeType: string | null;
  attendee: {
    firstName: string;
    lastName: string;
    country: string | null;
    /** Employer / institution. Prints between the name and the role. */
    organization: string | null;
  };
}

export async function generateBadgePDF(
  registrations: BadgeRegistration[],
  layout: BadgeLayout,
  includeDtcm: boolean,
): Promise<Buffer> {
  // Pre-render all barcodes (async) before drawing. Bounded concurrency, NOT
  // `Promise.all` over every row — each render is a CPU-bound bwip-js.toBuffer,
  // and firing thousands at once pins the event loop on the box that also
  // serves the live scanner. Dedup first so shared codes render once.
  // Encoded value is `{qrCode}-{serialId}` (entryBarcodeValue) so a raw
  // scanner dump identifies the person; check-in accepts both forms.
  const barcodeBuffers = new Map<string, Buffer>();
  // Skip the rasterization entirely when the field is off: on an overprinted
  // badge this is thousands of CPU-bound renders for something never drawn.
  const uniqueBarcodes = !layout.fields.barcode ? [] : [
    ...new Set(
      registrations
        .map((r) => (r.qrCode ? entryBarcodeValue(r.qrCode, r.serialId) : null))
        .filter((c): c is string => !!c),
    ),
  ];
  await mapWithConcurrency(uniqueBarcodes, BARCODE_RENDER_CONCURRENCY, async (barcodeText) => {
    try {
      // Badge draws the registration number itself, so the bars carry no
      // baked-in text (includetext defaults to false in the helper).
      const png = await renderBarcodePng(barcodeText);
      barcodeBuffers.set(barcodeText, png);
    } catch (err) {
      apiLogger.warn({
        msg: "Barcode render failed",
        barcodeText,
        error: err instanceof Error ? err.message : "Unknown",
      });
    }
  });

  // DTCM compliance QR (Dubai-flagged events only): the externally-issued
  // 36-char UUID renders as a QR — as Code 128 the bars would be ~0.19mm at
  // badge width and unscannable in print (see renderQrPng). Separate buffer
  // map so a hypothetical value collision with an entry code can't serve the
  // wrong symbology. A failed render logs and that badge simply omits the QR,
  // never fails the whole print.
  const dtcmQrBuffers = new Map<string, Buffer>();
  if (includeDtcm) {
    const uniqueDtcm = [
      ...new Set(registrations.map((r) => r.dtcmBarcode).filter((c): c is string => !!c)),
    ];
    await mapWithConcurrency(uniqueDtcm, BARCODE_RENDER_CONCURRENCY, async (dtcmValue) => {
      try {
        const png = await renderQrPng(dtcmValue);
        dtcmQrBuffers.set(dtcmValue, png);
      } catch (err) {
        apiLogger.warn({
          msg: "badges:dtcm-qr-render-failed",
          // Truncated — the full value is a compliance credential.
          dtcmPrefix: dtcmValue.slice(0, 8),
          error: err instanceof Error ? err.message : "Unknown",
        });
      }
    });
  }

  return new Promise((resolve, reject) => {
    const chunks: Uint8Array[] = [];
    const doc = new PDFDocument({ size: "A4", margin: 0 });

    doc.on("data", (chunk: Uint8Array) => chunks.push(chunk));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    // One badge per page, positioned by the organiser's alignment + nudge.
    const { x, y } = resolveBadgeOrigin(layout);

    for (let i = 0; i < registrations.length; i++) {
      if (i > 0) doc.addPage();
      drawBadge(doc, registrations[i], x, y, layout, barcodeBuffers, dtcmQrBuffers);
    }

    doc.end();
  });
}

function drawBadge(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  doc: any,
  reg: BadgeRegistration,
  x: number,
  y: number,
  layout: BadgeLayout,
  barcodeBuffers: Map<string, Buffer>,
  dtcmQrBuffers: Map<string, Buffer>,
) {
  const badgeType = (reg.badgeType || "DELEGATE").toUpperCase();
  const { sy, sf } = badgeScale(layout);
  const f = layout.fields;
  const fonts = layout.fontSizes;
  const W = layout.widthPt;
  const H = layout.heightPt;
  const margin = BASE_MARGIN * sf;

  doc.save();

  // Badge border (dashed for cutting guide). OFF for overprinting: on
  // pre-printed stock this lands a grey dashed rectangle across someone's
  // finished design.
  if (f.border) {
    doc.rect(x, y, W, H).dash(3, { space: 3 }).stroke("#cccccc").undash();
  }

  const contentW = W - margin * 2;

  // ── Registration number (its own band, ABOVE the name) ──
  // It sat directly under the name until Aug 26 2026, which put it inside the
  // name's own band — and the name is allowed to wrap, so a long name printed
  // its second line straight through the number. Moving it above is what frees
  // the name's full 30..72 for a real second line. See SERIAL_TOP.
  if (f.registrationNumber) {
    doc.font("Helvetica-BoldOblique").fontSize(10 * sf).fillColor("#000000");
    doc.text(formatSerialId(reg.serialId), x + margin, y + badgeSerialTop(sy), {
      width: contentW,
      align: "center",
      lineBreak: false,
    });
  }

  // ── Name (large, bold, centered) ──
  // `height` is the band, not a generous allowance: pdfkit wraps within it and
  // ellipsises at its boundary, so whatever size the organiser picks, the name
  // cannot reach the line below. At 18pt that is two full lines.
  const fullName = `${reg.attendee.firstName} ${reg.attendee.lastName}`;
  if (f.name) {
    doc.font("Helvetica-Bold").fontSize(fonts.name * sf).fillColor("#000000");
    doc.text(fullName, x + margin, y + badgeNameTop(sy), {
      width: contentW,
      align: "center",
      lineBreak: true,
      height: badgeNameBandH(sy),
      ellipsis: true,
    });
  }

  // ── Organisation and country, one line ──
  // They used to be mutually exclusive, organisation winning, because both
  // wanted the same band and drawing both would collide. That left a Country
  // switch that was on and printed nothing, which is worse than not offering
  // it. Joined with a middot instead (owner, Aug 26 2026): either one alone
  // still renders alone, and the pair costs no extra vertical space.
  //
  // U+00B7 is in WinAnsi, so Helvetica encodes it without the substitution
  // sweep the agreement renderer needs for arbitrary pasted text.
  const detail = [
    f.organization ? reg.attendee.organization : null,
    f.country ? reg.attendee.country : null,
  ]
    .filter((v): v is string => !!v && v.trim() !== "")
    .join(" \u00B7 ");

  if (detail) {
    doc.font("Helvetica").fontSize(fonts.detail * sf).fillColor("#000000");
    doc.text(detail, x + margin, y + badgeDetailTop(sy), {
      width: contentW,
      align: "center",
      lineBreak: false,
      ellipsis: true,
    });
  }

  // ── Entry barcode + DTCM QR ──
  // Geometry comes from `resolveBarcodeRow`, the SAME function the settings
  // card's "too narrow to scan" warning predicts with, so the warning and the
  // print cannot disagree.
  //
  // `hasDtcm` is resolved from the pre-rendered BUFFER, not from
  // `reg.dtcmBarcode`: if the QR failed to rasterise there is no symbol to make
  // room for, and narrowing the bars for it would cost scannability to reserve
  // empty space.
  const dtcmPng = reg.dtcmBarcode ? dtcmQrBuffers.get(reg.dtcmBarcode) : undefined;
  const row = resolveBarcodeRow(layout, !!dtcmPng);

  // qrCode only — see the pre-render loop above. Same serial-suffixed value
  // as the pre-render dedup key, or the buffer lookup would miss.
  const barcodeText = f.barcode && reg.qrCode ? entryBarcodeValue(reg.qrCode, reg.serialId) : null;
  if (barcodeText) {
    const png = barcodeBuffers.get(barcodeText);
    if (png) {
      doc.image(png, x + row.barcodeDx, y + row.barcodeDy, {
        fit: [row.barcodeW, row.barcodeH],
        align: "center",
      });
    }
  }

  // ── Bottom row: Badge type ──
  // The registration number used to sit flush left on this row; it now prints
  // under the name, so the role has the row to itself and stays centred.
  const bottomY = y + 145 * sy;

  // Badge type (large, bold, center)
  if (f.badgeType) {
    doc.font("Helvetica-Bold").fontSize(fonts.badgeType * sf).fillColor("#000000");
    doc.text(badgeType, x + margin, bottomY, {
      width: contentW,
      align: "center",
      lineBreak: false,
    });
  }

  // ── DTCM compliance QR (Dubai-flagged events only) ──
  // Occupies the band below the bottom row so NOTHING above moves: non-DTCM
  // events and DTCM regs without an imported code print identically.
  //
  // QR ONLY (owner, Aug 25 2026). This used to also print a "DTCM" label and
  // the full 36-character UUID in plain text. That value is a compliance
  // CREDENTIAL, and a badge is worn in public and photographed, so printing it
  // legibly put it in every group photo of the event. The QR carries the same
  // value to a scanner without carrying it to a camera.
  //
  // The trade this accepts: the human-readable line existed so an inspector
  // could read the value out if a scan failed. That fallback is now the
  // registration detail sheet, which is where the value lives anyway.
  // In `stacked` this is the band below the bottom row, exactly where it has
  // always printed. In `side-by-side` it shares the barcode's row. Both
  // positions come from `resolveBarcodeRow` above.
  if (dtcmPng) {
    doc.image(dtcmPng, x + row.qrDx, y + row.qrDy, { fit: [row.qrSize, row.qrSize] });
  }

  doc.restore();
}
