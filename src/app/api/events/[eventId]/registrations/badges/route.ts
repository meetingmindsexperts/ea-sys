import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { denyReviewer } from "@/lib/auth-guards";
import { formatPersonName } from "@/lib/utils";
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
const BADGES_PER_ROW = 2;
const BADGES_PER_COL = 3;
const BADGES_PER_PAGE = BADGES_PER_ROW * BADGES_PER_COL;
const PAGE_MARGIN = 36; // 0.5 inch page margins
const GAP = 12;

// Badge type colors
const BADGE_TYPE_COLORS: Record<string, { bg: string; text: string }> = {
  DELEGATE:  { bg: "#00aade", text: "#ffffff" },
  FACULTY:   { bg: "#7c3aed", text: "#ffffff" },
  EXHIBITOR: { bg: "#059669", text: "#ffffff" },
};

const DEFAULT_BADGE_COLOR = { bg: "#00aade", text: "#ffffff" };

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
      select: { id: true, name: true },
    });

    if (!event) {
      return NextResponse.json({ error: "Event not found" }, { status: 404 });
    }

    const body = await req.json();
    const { registrationIds, all } = body as { registrationIds?: string[]; all?: boolean };

    const where = all
      ? { eventId, status: { not: "CANCELLED" as const }, barcode: { not: null } }
      : { eventId, id: { in: registrationIds || [] }, barcode: { not: null } };

    const registrations = await db.registration.findMany({
      where,
      include: {
        attendee: {
          select: {
            title: true,
            firstName: true,
            lastName: true,
            organization: true,
          },
        },
        ticketType: { select: { name: true } },
      },
      orderBy: [{ attendee: { lastName: "asc" } }, { attendee: { firstName: "asc" } }],
    });

    if (registrations.length === 0) {
      return NextResponse.json(
        { error: "No registrations with barcodes found. Import barcodes first before generating badges." },
        { status: 400 }
      );
    }

    const pdfBuffer = await generateBadgePDF(registrations, event);

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
  barcode: string | null;
  badgeType: string | null;
  attendee: {
    title: string | null;
    firstName: string;
    lastName: string;
    organization: string | null;
  };
  ticketType: { name: string };
}

interface BadgeEvent {
  name: string;
}

async function generateBadgePDF(
  registrations: BadgeRegistration[],
  event: BadgeEvent
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Uint8Array[] = [];
    const doc = new PDFDocument({ size: "A4", margin: PAGE_MARGIN });

    doc.on("data", (chunk: Uint8Array) => chunks.push(chunk));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    for (let i = 0; i < registrations.length; i++) {
      const reg = registrations[i];
      const posOnPage = i % BADGES_PER_PAGE;

      if (i > 0 && posOnPage === 0) {
        doc.addPage();
      }

      const col = posOnPage % BADGES_PER_ROW;
      const row = Math.floor(posOnPage / BADGES_PER_ROW);

      const x = PAGE_MARGIN + col * (BADGE_W + GAP);
      const y = PAGE_MARGIN + row * (BADGE_H + GAP);

      drawBadge(doc, reg, event, x, y);
    }

    doc.end();
  });
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function drawBadge(doc: any, reg: BadgeRegistration, event: BadgeEvent, x: number, y: number) {
  const badgeType = (reg.badgeType || "DELEGATE").toUpperCase();
  const colors = BADGE_TYPE_COLORS[badgeType] || DEFAULT_BADGE_COLOR;

  // Badge border (dashed for cutting guide)
  doc.save()
    .rect(x, y, BADGE_W, BADGE_H)
    .dash(3, { space: 3 })
    .stroke("#cccccc")
    .undash();

  // Event name bar at top — colored by badge type
  doc.rect(x, y, BADGE_W, 32).fill(colors.bg);
  doc.font("Helvetica-Bold").fontSize(9).fillColor(colors.text);
  const eventNameTrunc = event.name.length > 45 ? event.name.substring(0, 42) + "..." : event.name;
  doc.text(eventNameTrunc, x + MARGIN, y + 10, {
    width: BADGE_W - MARGIN * 2,
    align: "center",
    lineBreak: false,
  });

  // Badge type label (Delegate / Faculty / Exhibitor)
  doc.font("Helvetica-Bold").fontSize(10).fillColor(colors.bg);
  doc.text(badgeType, x + MARGIN, y + 40, {
    width: BADGE_W - MARGIN * 2,
    align: "center",
    lineBreak: false,
  });

  // Attendee name (large)
  const fullName = formatPersonName(reg.attendee.title, reg.attendee.firstName, reg.attendee.lastName);
  doc.font("Helvetica-Bold").fontSize(16).fillColor("#1e293b");
  doc.text(fullName, x + MARGIN, y + 60, {
    width: BADGE_W - MARGIN * 2,
    align: "center",
    lineBreak: true,
    height: 44,
    ellipsis: true,
  });

  // Organization
  if (reg.attendee.organization) {
    doc.font("Helvetica").fontSize(10).fillColor("#64748b");
    const orgTrunc = reg.attendee.organization.length > 40
      ? reg.attendee.organization.substring(0, 37) + "..."
      : reg.attendee.organization;
    doc.text(orgTrunc, x + MARGIN, y + 108, {
      width: BADGE_W - MARGIN * 2,
      align: "center",
      lineBreak: false,
    });
  }

  // Registration type (smaller, below org)
  doc.font("Helvetica").fontSize(8).fillColor("#94a3b8");
  doc.text(reg.ticketType.name, x + MARGIN, y + 125, {
    width: BADGE_W - MARGIN * 2,
    align: "center",
    lineBreak: false,
  });

  // Barcode at bottom (always present since we filter for barcode != null)
  if (reg.barcode) {
    try {
      const png = bwipjs.toBufferSync({
        bcid: "code128",
        text: reg.barcode,
        scale: 2,
        height: 12,
        includetext: true,
        textsize: 8,
        textxalign: "center",
      });
      doc.image(png, x + MARGIN + 20, y + BADGE_H - 60, {
        fit: [BADGE_W - MARGIN * 2 - 40, 45],
        align: "center",
      });
    } catch (err) {
      apiLogger.warn({ msg: "Barcode render failed, falling back to text", error: err instanceof Error ? err.message : "Unknown" });
      doc.font("Courier").fontSize(8).fillColor("#94a3b8");
      doc.text(reg.barcode, x + MARGIN, y + BADGE_H - 30, {
        width: BADGE_W - MARGIN * 2,
        align: "center",
        lineBreak: false,
      });
    }
  }

  doc.restore();
}
