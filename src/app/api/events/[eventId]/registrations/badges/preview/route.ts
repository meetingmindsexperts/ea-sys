import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { denyReviewer, REGISTRATION_DESK_ALLOW } from "@/lib/auth-guards";
import { buildEventAccessWhere } from "@/lib/event-access";
import { getClientIp, checkRateLimit } from "@/lib/security";
import { runWithTenantLane } from "@/lib/tenant-lane";
import { rateLimited } from "@/lib/api-errors";
import { readBadgeLayout, type BadgeAlign, type BadgeLayout } from "@/lib/badge-layout";
import { generateBadgePDF, type BadgeRegistration } from "@/lib/badge-pdf";

/**
 * One sample badge, rendered through the SAME pipeline as a real print run.
 *
 * Why this exists: badge placement is calibrated against physical stock, and
 * before this the only way to see the result of changing `badgeVerticalOffset`
 * was to run a print job. An organiser adjusting alignment for pre-cut cards
 * was typing a number and hoping.
 *
 * Query params override the SAVED layout so the preview reflects what is on
 * screen, not what was last persisted — a preview you have to save first is
 * not a calibration tool. Unrecognised or malformed values fall back to the
 * saved layout field by field, via the same `readBadgeLayout` clamps.
 *
 * Deliberately sample data, not a real registrant: this is reachable by desk
 * staff, it must work on an event with zero registrations, and a preview is
 * not a reason to put someone's entry barcode on screen. The sample name is
 * long on purpose — the interior ellipsises, and the failure an organiser
 * needs to see is a name that does not fit.
 */

interface RouteParams {
  params: Promise<{ eventId: string }>;
}

const SAMPLE: BadgeRegistration = {
  id: "preview",
  serialId: 188,
  // Not a real code. Renders as a valid Code 128 so the bars occupy the same
  // space a real barcode will.
  qrCode: "PREVIEW0000000",
  dtcmBarcode: null,
  badgeType: "DELEGATE",
  attendee: {
    firstName: "Abdulrahman",
    lastName: "Al-Muhairi-Sample",
    country: "United Arab Emirates",
    organization: "Meeting Minds Experts",
  },
};

function numParam(v: string | null): number | undefined {
  if (v === null || v.trim() === "") return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

export async function GET(req: Request, { params }: RouteParams) {
  try {
    const [{ eventId }, session] = await Promise.all([params, auth()]);

    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    // Same population as the print route: desk staff calibrate too, and they
    // cannot reach Settings to read the saved numbers.
    const denied = denyReviewer(session, { allow: REGISTRATION_DESK_ALLOW, route: "events/[eventId]/registrations/badges/preview:GET" });
    if (denied) return denied;

    // Each preview rasterizes a barcode, so it is CPU-bound on the box that
    // also serves the live scanner. Generous enough to drag a slider, bounded
    // enough that a stuck client cannot spin.
    const limit = checkRateLimit({
      key: `badge-preview:${session.user.id}`,
      limit: 120,
      windowMs: 60 * 60 * 1000,
    });
    if (!limit.allowed) {
      return rateLimited(limit, {
        route: "registrations/badges/preview",
        userId: session.user.id,
      });
    }

    return await runWithTenantLane(
      session.user.organizationId,
      { route: "registrations:badges:preview", userId: session.user.id },
      async () => {
        const event = await db.event.findFirst({
          where: buildEventAccessWhere(session.user, eventId, { surface: "desk" }),
          select: {
            id: true,
            badgeVerticalOffset: true,
            settings: true,
            requiresDtcmBarcode: true,
          },
        });

        if (!event) {
          apiLogger.warn({
            msg: "badge-preview:event-not-found",
            eventId,
            userId: session.user.id,
            role: session.user.role,
          });
          return NextResponse.json({ error: "Event not found" }, { status: 404 });
        }

        const saved = readBadgeLayout(event);

        // Overlay the unsaved values, then re-run the reader so the overrides
        // get the identical clamping the saved path gets. Validating them here
        // instead would be a second set of bounds to drift from.
        const { searchParams } = new URL(req.url);
        const align = searchParams.get("align");

        // `fields` is a comma-separated list of the ENABLED keys. Presence is
        // checked with `has`, not truthiness, because "everything off" is a
        // legitimate state that serialises to an empty string — and it is the
        // state an organiser reaches while switching things off one at a time.
        const enabled = searchParams.has("fields")
          ? new Set((searchParams.get("fields") ?? "").split(",").filter(Boolean))
          : null;
        const fields = enabled
          ? Object.fromEntries(
              Object.keys(saved.fields).map((k) => [k, enabled.has(k)]),
            )
          : saved.fields;

        const overridden: BadgeLayout = readBadgeLayout({
          settings: {
            badge: {
              widthPt: numParam(searchParams.get("w")) ?? saved.widthPt,
              heightPt: numParam(searchParams.get("h")) ?? saved.heightPt,
              align: (align as BadgeAlign) ?? saved.align,
              offsetXPt: numParam(searchParams.get("ox")) ?? saved.offsetXPt,
              offsetYPt: numParam(searchParams.get("oy")) ?? saved.offsetYPt,
              fields,
            },
          },
        });

        // A flagged event previews with the compliance band occupied, because
        // that band is the part most likely to fall off a shortened badge.
        const sample: BadgeRegistration = event.requiresDtcmBarcode
          ? { ...SAMPLE, dtcmBarcode: "00000000-0000-4000-8000-000000000000" }
          : SAMPLE;

        const pdf = await generateBadgePDF([sample], overridden, !!event.requiresDtcmBarcode);

        return new NextResponse(new Uint8Array(pdf), {
          headers: {
            "Content-Type": "application/pdf",
            "Content-Disposition": 'inline; filename="badge-preview.pdf"',
            // Never cached: the whole point is that it tracks the form.
            "Cache-Control": "no-store",
          },
        });
      },
    );
  } catch (error) {
    apiLogger.error({ err: error, msg: "badge-preview:failed", ip: getClientIp(req) });
    return NextResponse.json({ error: "Failed to render preview" }, { status: 500 });
  }
}
