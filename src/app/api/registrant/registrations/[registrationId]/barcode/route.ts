import { NextResponse } from "next/server";
import type { Session } from "next-auth";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { renderBarcodePng } from "@/lib/barcode";

interface RouteParams {
  params: Promise<{ registrationId: string }>;
}

/**
 * GET /api/registrant/registrations/[registrationId]/barcode
 *
 * Streams the registrant's own entry barcode as a Code 128 PNG so the
 * `/e/[slug]/my-registration` portal can show a scannable image (identical
 * to the printed badge). Access is owner-scoped (REGISTRANT) or, for
 * convenience, org members viewing the same row. Uses `qrCode` only — the
 * DTCM barcode is an internal/admin concern and is never surfaced on the
 * public-facing portal. 404 when there's no qrCode (the page gates the
 * <img> on the value so a 404 is never requested).
 */
export async function GET(_req: Request, { params }: RouteParams) {
  let registrationId: string | undefined;
  let session: Session | null = null;
  try {
    [session, { registrationId }] = await Promise.all([
      auth() as Promise<Session | null>,
      params,
    ]);

    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    // Reviewers/submitters (non-REGISTRANT with no org) can't own a
    // registration — reject before the nested relation filter.
    const isRegistrant = session.user.role === "REGISTRANT";
    if (!isRegistrant && !session.user.organizationId) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const registration = await db.registration.findFirst({
      where: {
        id: registrationId,
        ...(isRegistrant
          ? { userId: session.user.id }
          : { event: { organizationId: session.user.organizationId! } }),
      },
      select: { qrCode: true },
    });

    if (!registration) {
      return NextResponse.json({ error: "Registration not found" }, { status: 404 });
    }

    // qrCode only — DTCM barcodes are never exposed on the public portal.
    if (!registration.qrCode) {
      return NextResponse.json({ error: "No barcode for this registration" }, { status: 404 });
    }

    const png = await renderBarcodePng(registration.qrCode, { includetext: true });
    return new NextResponse(new Uint8Array(png), {
      status: 200,
      headers: {
        "Content-Type": "image/png",
        "Cache-Control": "private, max-age=3600",
      },
    });
  } catch (error) {
    apiLogger.error({ err: error, msg: "Error rendering registrant barcode", registrationId });
    return NextResponse.json({ error: "Failed to render barcode" }, { status: 500 });
  }
}
