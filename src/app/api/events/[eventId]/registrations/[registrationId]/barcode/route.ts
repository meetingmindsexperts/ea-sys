import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { buildEventAccessWhere } from "@/lib/event-access";
import { renderBarcodePng } from "@/lib/barcode";

interface RouteParams {
  params: Promise<{ eventId: string; registrationId: string }>;
}

/**
 * Streams the registration's Code 128 barcode as a PNG so the admin detail
 * sheet can render a scannable image (byte-identical to the printed badge).
 *
 * Auth mirrors the registration detail GET: authenticated + event scoped to
 * the caller's access (org membership / event assignment).
 *
 * Entry barcode = `qrCode` ONLY. The DTCM barcode is a separate Dubai
 * (DET/DTCM) compliance artifact, not a substitute for the entry barcode —
 * it lives in its own field and is still scannable at check-in, but is never
 * rendered as the entry barcode here. 404 when there's no qrCode (the UI
 * gates the <img> on the value so this is only hit for real barcodes).
 */
export async function GET(_req: Request, { params }: RouteParams) {
  try {
    const [{ eventId, registrationId }, session] = await Promise.all([
      params,
      auth(),
    ]);

    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const [event, registration] = await Promise.all([
      db.event.findFirst({
        where: buildEventAccessWhere(session.user, eventId),
        select: { id: true },
      }),
      db.registration.findFirst({
        where: { id: registrationId, eventId },
        select: { qrCode: true },
      }),
    ]);

    if (!event) {
      return NextResponse.json({ error: "Event not found" }, { status: 404 });
    }
    if (!registration) {
      return NextResponse.json({ error: "Registration not found" }, { status: 404 });
    }

    // Entry barcode is the qrCode only — never the DTCM compliance barcode.
    if (!registration.qrCode) {
      return NextResponse.json({ error: "No barcode for this registration" }, { status: 404 });
    }

    const png = await renderBarcodePng(registration.qrCode, { includetext: true });
    return new NextResponse(new Uint8Array(png), {
      status: 200,
      headers: {
        "Content-Type": "image/png",
        // Barcode is immutable per registration — cache privately so the
        // sheet doesn't re-render it on every open.
        "Cache-Control": "private, max-age=3600",
      },
    });
  } catch (error) {
    apiLogger.error({ err: error, msg: "Error rendering registration barcode" });
    return NextResponse.json({ error: "Failed to render barcode" }, { status: 500 });
  }
}
