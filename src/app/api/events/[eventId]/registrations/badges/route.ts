import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { denyReviewer } from "@/lib/auth-guards";
// eslint-disable-next-line @typescript-eslint/no-require-imports
const bwipjs = require("bwip-js");
import PDFDocument from "pdfkit";

interface RouteParams {
  params: Promise<{ eventId: string }>;
}

// Badge dimensions (in points, 72pt = 1 inch)
// 4" x 3" landscape badge — standard conference badge size
const BADGE_W = 288; // 4 inches
const BADGE_H = 216; // 3 inches
const MARGIN = 20;

// A4 page dimensions
const A4_W = 595.28;
const A4_H = 841.89;

export async function POST(req: Request, { params }: RouteParams) {
  try {
    const [{ eventId }, session] = await Promise.all([params, auth()]);

    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const denied = denyReviewer(session);
    if (denied) return denied;

    const event = await db.event.findFirst({
      where: { id: eventId, organizationId: session.user.organizationId! },
      select: { id: true },
    });

    if (!event) {
      return NextResponse.json({ error: "Event not found" }, { status: 404 });
    }

    const body = await req.json();
    const { registrationIds, all, verticalOffset = 0 } = body as {
      registrationIds?: string[];
      all?: boolean;
      verticalOffset?: number;
    };

    const where = all
      ? { eventId, status: { not: "CANCELLED" as const } }
      : { eventId, id: { in: registrationIds || [] } };

    const allRegistrations = await db.registration.findMany({
      where,
      include: {
        attendee: {
          select: {
            firstName: true,
            lastName: true,
            country: true,
          },
        },
        ticketType: { select: { name: true, price: true } },
        pricingTier: { select: { price: true } },
      },
      orderBy: [{ attendee: { lastName: "asc" } }, { attendee: { firstName: "asc" } }],
    });

    // Filter to only paid or complimentary registrations
    const registrations = allRegistrations.filter((r) => {
      const isComplimentary = r.paymentStatus === "COMPLIMENTARY" ||
        Number(r.ticketType.price) === 0 ||
        (r.pricingTier && Number(r.pricingTier.price) === 0);
      return r.paymentStatus === "PAID" || isComplimentary;
    });

    if (registrations.length === 0) {
      return NextResponse.json(
        { error: "No paid or complimentary registrations found for badge generation." },
        { status: 400 }
      );
    }

    // Clamp vertical offset to reasonable range (-200 to 200 points)
    const vOffset = Math.max(-200, Math.min(200, Number(verticalOffset) || 0));
    const pdfBuffer = await generateBadgePDF(registrations, vOffset);

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
  // Pre-render all barcodes (async) before drawing
  const barcodeBuffers = new Map<string, Buffer>();
  await Promise.all(
    registrations.map(async (reg) => {
      const barcodeText = reg.qrCode || reg.dtcmBarcode;
      if (barcodeText && !barcodeBuffers.has(barcodeText)) {
        try {
          const png = await bwipjs.toBuffer({
            bcid: "code128",
            text: barcodeText,
            scale: 2,
            height: 14,
            includetext: false,
          });
          barcodeBuffers.set(barcodeText, png);
        } catch (err) {
          apiLogger.warn({ msg: "Barcode render failed", barcodeText, error: err instanceof Error ? err.message : "Unknown" });
        }
      }
    })
  );

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
function drawBadge(doc: any, reg: BadgeRegistration, x: number, y: number, regIndex: number, barcodeBuffers: Map<string, Buffer>) {
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
  const barcodeText = reg.qrCode || reg.dtcmBarcode;
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
  doc.text(String(regIndex), x + MARGIN, bottomY + 4, {
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
