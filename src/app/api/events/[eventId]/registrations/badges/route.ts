import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { denyReviewer, REGISTRATION_DESK_ALLOW } from "@/lib/auth-guards";
import { buildEventAccessWhere } from "@/lib/event-access";
import { getClientIp } from "@/lib/security";
import { formatSerialId } from "@/lib/registration-serial";
import { renderBarcodePng } from "@/lib/barcode";
import { isPaymentAdmissible } from "@/lib/check-in";
import { mapWithConcurrency } from "@/lib/concurrency";
import PDFDocument from "pdfkit";

interface RouteParams {
  params: Promise<{ eventId: string }>;
}

// Badge dimensions (in points, 72pt = 1 inch)
// 4" x 3" landscape badge — standard conference badge size
const BADGE_W = 288; // 4 inches
const BADGE_H = 216; // 3 inches
const MARGIN = 20;

// A4 page width (in points)
const A4_W = 595.28;

// H4: a "Print All" larger than this is refused (batch instead) so one request
// can't build a multi-thousand-page PDF on the box that serves the live
// scanner. Well above a realistic single event (MM Group runs 500-2000).
const MAX_BADGES_PER_REQUEST = 2500;
// Max simultaneous CPU-bound barcode rasterizations — keeps the event loop
// responsive for latency-critical requests (check-in, webhooks) during a print.
const BARCODE_RENDER_CONCURRENCY = 8;

export async function POST(req: Request, { params }: RouteParams) {
  try {
    const [{ eventId }, session] = await Promise.all([params, auth()]);

    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    // ONSITE (registration-desk staff) is allowed to print badges.
    const denied = denyReviewer(session, { allow: REGISTRATION_DESK_ALLOW });
    if (denied) return denied;

    const event = await db.event.findFirst({
      // Assignment-scoped for ONSITE (per-event desk staff) — an ONSITE user may
      // only print badges for events they're assigned to (badge PDFs carry entry
      // barcodes). Org-scoped (unchanged) for admin/organizer.
      where: buildEventAccessWhere(session.user, eventId),
      select: { id: true, badgeVerticalOffset: true },
    });

    if (!event) {
      return NextResponse.json({ error: "Event not found" }, { status: 404 });
    }

    const body = await req.json();
    const { registrationIds, all } = body as {
      registrationIds?: string[];
      all?: boolean;
    };

    // Virtual attendees have no venue presence (and no qrCode) — never badge
    // them, even if explicitly selected.
    const where = all
      ? { eventId, status: { not: "CANCELLED" as const }, attendanceMode: { not: "VIRTUAL" as const } }
      : { eventId, id: { in: registrationIds || [] }, attendanceMode: { not: "VIRTUAL" as const } };

    // H4: guard against an unbounded "Print All" building a multi-thousand-page
    // PDF in one request on the box that also serves the live scanner. `take`
    // one past the cap so we can tell "at the cap" from "over it". Realistic
    // events (≤ a couple thousand) pass; a runaway falls back to batching.
    const allRegistrations = await db.registration.findMany({
      where,
      take: MAX_BADGES_PER_REQUEST + 1,
      select: {
        id: true,
        serialId: true,
        qrCode: true,
        dtcmBarcode: true,
        badgeType: true,
        paymentStatus: true,
        attendee: { select: { firstName: true, lastName: true, country: true } },
        ticketType: { select: { name: true, price: true } },
        pricingTier: { select: { price: true } },
      },
      orderBy: [{ attendee: { lastName: "asc" } }, { attendee: { firstName: "asc" } }],
    });

    // Badge everyone the door would admit — the SAME predicate as the check-in
    // gate (review H1). This route used to filter `PAID || complimentary`,
    // silently dropping sponsor-paid (INCLUSIVE) and pay-at-desk (UNASSIGNED)
    // delegates who scan in fine but then have no badge. `isPaymentAdmissible`
    // is the shared source of truth so the two can't drift again.
    const registrations = allRegistrations.filter((r) =>
      isPaymentAdmissible({
        paymentStatus: r.paymentStatus,
        ticketTypePrice: r.ticketType?.price ?? null,
        pricingTierPrice: r.pricingTier?.price ?? null,
      }),
    );

    if (registrations.length === 0) {
      apiLogger.warn(
        { msg: "badges:no-eligible-registrations", eventId, requested: all ? "all" : (registrationIds?.length ?? 0) },
        "No badge-eligible registrations",
      );
      return NextResponse.json(
        {
          error:
            "No badge-eligible registrations found. Registrations that still owe payment (unpaid or pending) are excluded.",
        },
        { status: 400 }
      );
    }

    // H4: over the per-request cap. Refuse rather than freeze the box mid-render.
    if (registrations.length > MAX_BADGES_PER_REQUEST) {
      apiLogger.warn(
        { msg: "badges:over-cap", eventId, cap: MAX_BADGES_PER_REQUEST, matched: registrations.length },
        "Badge request exceeds the per-request cap",
      );
      return NextResponse.json(
        {
          error: `Too many badges for one request (limit ${MAX_BADGES_PER_REQUEST}). Filter by registration type or select a batch, then print again.`,
          code: "BADGE_LIMIT_EXCEEDED",
          limit: MAX_BADGES_PER_REQUEST,
        },
        { status: 400 }
      );
    }

    // Use event's saved vertical offset, clamped to reasonable range
    const vOffset = Math.max(-200, Math.min(200, event.badgeVerticalOffset || 0));
    const pdfBuffer = await generateBadgePDF(registrations, vOffset);

    // Record the print for analytics ("badges printed vs registered" +
    // reprints). Awaited but failure-isolated — a tracking error must never
    // block handing the operator their PDF. badgePrintedAt is set only on the
    // first print (where still null); badgePrintCount bumps every time; the
    // AuditLog row gives the per-print timeline + who/when.
    const printedIds = registrations.map((r) => r.id);
    try {
      await db.$transaction([
        db.registration.updateMany({
          where: { id: { in: printedIds } },
          data: { badgePrintCount: { increment: 1 } },
        }),
        db.registration.updateMany({
          where: { id: { in: printedIds }, badgePrintedAt: null },
          data: { badgePrintedAt: new Date() },
        }),
        db.auditLog.create({
          data: {
            eventId,
            userId: session.user.id,
            action: "BADGE_PRINTED",
            entityType: "Registration",
            entityId: `bulk:${printedIds.length}`,
            // Cap the id list so a 1000-badge print doesn't bloat the row;
            // the count is the headline figure for analytics.
            changes: { count: printedIds.length, all: !!all, registrationIds: printedIds.slice(0, 200) },
            ipAddress: getClientIp(req),
          },
        }),
      ]);
    } catch (err) {
      apiLogger.error({ err, msg: "Failed to record badge-print analytics", eventId, count: printedIds.length });
    }

    return new Response(new Uint8Array(pdfBuffer), {
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `attachment; filename="badges-${eventId}.pdf"`,
      },
    });
  } catch (error) {
    apiLogger.error({ err: error, msg: "Error generating badges" });
    return NextResponse.json({ error: "Badge generation failed" }, { status: 500 });
  }
}

interface BadgeRegistration {
  id: string;
  serialId: number | null;
  qrCode: string | null;
  dtcmBarcode: string | null;
  badgeType: string | null;
  attendee: {
    firstName: string;
    lastName: string;
    country: string | null;
  };
}

async function generateBadgePDF(
  registrations: BadgeRegistration[],
  verticalOffset: number,
): Promise<Buffer> {
  // Pre-render all barcodes (async) before drawing. H4: bounded concurrency,
  // NOT `Promise.all` over every row — each render is a CPU-bound
  // bwip-js.toBuffer, and firing thousands at once pins the event loop on the
  // box that also serves the live scanner. Dedup first so shared codes render
  // once. Entry barcode = qrCode only (the DTCM code is never on the badge).
  const barcodeBuffers = new Map<string, Buffer>();
  const uniqueBarcodes = [...new Set(registrations.map((r) => r.qrCode).filter((c): c is string => !!c))];
  await mapWithConcurrency(uniqueBarcodes, BARCODE_RENDER_CONCURRENCY, async (barcodeText) => {
    try {
      // Badge draws the registration number itself, so the bars carry no
      // baked-in text (includetext defaults to false in the helper).
      const png = await renderBarcodePng(barcodeText);
      barcodeBuffers.set(barcodeText, png);
    } catch (err) {
      apiLogger.warn({ msg: "Barcode render failed", barcodeText, error: err instanceof Error ? err.message : "Unknown" });
    }
  });

  return new Promise((resolve, reject) => {
    const chunks: Uint8Array[] = [];
    const doc = new PDFDocument({ size: "A4", margin: 0 });

    doc.on("data", (chunk: Uint8Array) => chunks.push(chunk));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    // One badge per page: horizontally centered, vertically at top + offset
    const x = (A4_W - BADGE_W) / 2;
    const baseY = 36 + verticalOffset; // 0.5 inch default top margin + organizer adjustment

    for (let i = 0; i < registrations.length; i++) {
      if (i > 0) doc.addPage();
      drawBadge(doc, registrations[i], x, baseY, i + 1, barcodeBuffers);
    }

    doc.end();
  });
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function drawBadge(doc: any, reg: BadgeRegistration, x: number, y: number, _regIndex: number, barcodeBuffers: Map<string, Buffer>) {
  const badgeType = (reg.badgeType || "DELEGATE").toUpperCase();

  // Badge border (dashed for cutting guide)
  doc.save()
    .rect(x, y, BADGE_W, BADGE_H)
    .dash(3, { space: 3 })
    .stroke("#cccccc")
    .undash();

  const contentW = BADGE_W - MARGIN * 2;

  // ── Name (large, bold, centered) ──
  const fullName = `${reg.attendee.firstName} ${reg.attendee.lastName}`;
  doc.font("Helvetica-Bold").fontSize(18).fillColor("#000000");
  doc.text(fullName, x + MARGIN, y + 30, {
    width: contentW,
    align: "center",
    lineBreak: true,
    height: 48,
    ellipsis: true,
  });

  // ── Country (below name, smaller) ──
  if (reg.attendee.country) {
    doc.font("Helvetica").fontSize(10).fillColor("#000000");
    doc.text(reg.attendee.country, x + MARGIN, y + 72, {
      width: contentW,
      align: "center",
      lineBreak: false,
    });
  }

  // ── Barcode (centered, using pre-rendered buffer) ──
  // qrCode only — see the pre-render loop above.
  const barcodeText = reg.qrCode;
  if (barcodeText) {
    const png = barcodeBuffers.get(barcodeText);
    if (png) {
      doc.image(png, x + MARGIN + 10, y + 95, {
        fit: [contentW - 20, 40],
        align: "center",
      });
    }
  }

  // ── Bottom row: Registration # (left) | Badge type (center) ──
  const bottomY = y + 145;

  // Registration number (left, italic)
  doc.font("Helvetica-BoldOblique").fontSize(10).fillColor("#000000");
  doc.text(formatSerialId(reg.serialId), x + MARGIN, bottomY + 4, {
    width: 50,
    align: "left",
    lineBreak: false,
  });

  // Badge type (large, bold, center)
  doc.font("Helvetica-Bold").fontSize(20).fillColor("#000000");
  doc.text(badgeType, x + MARGIN, bottomY, {
    width: contentW,
    align: "center",
    lineBreak: false,
  });

  doc.restore();
}
