import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { buildEventAccessWhere } from "@/lib/event-access";
import { canViewEntryBarcode } from "@/lib/barcode-visibility";
import { renderBarcodePng, renderQrPng, entryBarcodeValue } from "@/lib/barcode";
import { runWithTenantLane } from "@/lib/tenant-lane";

interface RouteParams {
  params: Promise<{ eventId: string; registrationId: string }>;
}

/**
 * Streams a registration's barcode as a PNG for the admin detail sheet.
 *
 * Two codes, selected by `?code=`:
 *   - default (no param): the ENTRY barcode — Code 128 of
 *     `{qrCode}-{serialId}`, byte-identical to the printed badge. 404 when the
 *     registration has no qrCode (e.g. virtual). It never falls back to the
 *     DTCM value — the two are different credentials.
 *   - `?code=dtcm`: the Dubai (DET/DTCM) compliance barcode rendered as a QR
 *     (externally-issued 36-char UUIDs don't survive Code 128 at print size —
 *     see renderQrPng). Only served on events flagged `requiresDtcmBarcode`
 *     and only when the registration has an imported/entered value; 404
 *     otherwise, both paths logged.
 *
 * Auth: authenticated + event scoped to the caller's access (org membership /
 * ONSITE event assignment) + `canViewEntryBarcode` — both codes are
 * door/compliance credentials, so MEMBER (and any role outside the barcode
 * boundary) is refused even though it can open the detail sheet. Registrants
 * fetch their OWN entry barcode via the separate /api/registrant route.
 */
export async function GET(req: Request, { params }: RouteParams) {
  try {
    const [{ eventId, registrationId }, session] = await Promise.all([
      params,
      auth(),
    ]);

    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    // Barcode boundary (July 11 H6-H8 model): the JSON payloads strip these
    // fields for non-door roles, and this image endpoint must agree — before
    // this gate a MEMBER (or an event-linked REGISTRANT) could fetch the PNG
    // directly even though the UI never shows them the value.
    if (!canViewEntryBarcode(session.user.role)) {
      apiLogger.warn({
        msg: "registration-barcode:role-refused",
        eventId,
        registrationId,
        userId: session.user.id,
        role: session.user.role,
      });
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const wantDtcm = new URL(req.url).searchParams.get("code") === "dtcm";

    return await runWithTenantLane(session.user.organizationId, { route: "registrations:barcode", userId: session.user.id }, async () => {
    const [event, registration] = await Promise.all([
      db.event.findFirst({
        where: buildEventAccessWhere(session.user, eventId),
        select: { id: true, requiresDtcmBarcode: true },
      }),
      db.registration.findFirst({
        where: { id: registrationId, eventId },
        select: { qrCode: true, serialId: true, dtcmBarcode: true },
      }),
    ]);

    if (!event) {
      return NextResponse.json({ error: "Event not found" }, { status: 404 });
    }
    if (!registration) {
      return NextResponse.json({ error: "Registration not found" }, { status: 404 });
    }

    let png: Buffer;
    if (wantDtcm) {
      // DTCM is Dubai-only — refuse on unflagged events so a stale value on a
      // non-Dubai event can't be rendered as if it were live compliance data.
      if (!event.requiresDtcmBarcode) {
        apiLogger.warn({ msg: "registration-barcode:dtcm-not-flagged", eventId, registrationId, userId: session.user.id });
        return NextResponse.json({ error: "This event is not DTCM-flagged" }, { status: 404 });
      }
      if (!registration.dtcmBarcode) {
        apiLogger.warn({ msg: "registration-barcode:dtcm-not-set", eventId, registrationId, userId: session.user.id });
        return NextResponse.json({ error: "No DTCM barcode for this registration" }, { status: 404 });
      }
      png = await renderQrPng(registration.dtcmBarcode);
    } else {
      // Entry barcode is the qrCode only — never the DTCM compliance barcode.
      if (!registration.qrCode) {
        return NextResponse.json({ error: "No barcode for this registration" }, { status: 404 });
      }
      // Encodes `{qrCode}-{serialId}` so a raw scanner dump identifies the person.
      png = await renderBarcodePng(entryBarcodeValue(registration.qrCode, registration.serialId), { includetext: true });
    }

    return new NextResponse(new Uint8Array(png), {
      status: 200,
      headers: {
        "Content-Type": "image/png",
        // Barcodes are effectively immutable per registration (DTCM re-imports
        // are rare corrections) — cache privately so the sheet doesn't
        // re-render on every open.
        "Cache-Control": "private, max-age=3600",
      },
    });
    });
  } catch (error) {
    apiLogger.error({ err: error, msg: "Error rendering registration barcode" });
    return NextResponse.json({ error: "Failed to render barcode" }, { status: 500 });
  }
}
