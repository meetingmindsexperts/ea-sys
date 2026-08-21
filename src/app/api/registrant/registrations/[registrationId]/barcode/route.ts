import { NextResponse } from "next/server";
import type { Session } from "next-auth";
import { auth } from "@/lib/auth";
import { resolveRequestOrgId } from "@/lib/tenant/resolver";
import { runWithTenantLane } from "@/lib/tenant-lane";
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { renderBarcodePng, entryBarcodeValue } from "@/lib/barcode";
import { buildEventAccessWhere } from "@/lib/event-access";
import { checkRateLimit } from "@/lib/security";

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
export async function GET(req: Request, { params }: RouteParams) {
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

    // Tenancy lane (item 6 follow-on). A REGISTRANT is org-null on master by
    // design, and the rows below sit behind an RLS policy on the platform — so
    // the lane cannot come from the session and cannot be read out of the
    // database first. It comes from the host, exactly as sign-in does.
    // `session` is a `let` above (assigned by the destructuring), so its
    // narrowing does not survive into the closure below. Capture it.
    const authedUser = session.user;
    const orgId = await resolveRequestOrgId(req);
    return await runWithTenantLane(orgId, { route: "registrant/registrations/[registrationId]/barcode", userId: authedUser.id }, async () => {

    // L4: the barcode is a physical-access credential — rate-limit fetches by
    // caller so the org-staff branch below can't be used to enumerate PNGs.
    const { allowed, retryAfterSeconds } = checkRateLimit({
      key: `registrant-barcode:${authedUser.id}`,
      limit: 120,
      windowMs: 3600_000,
    });
    if (!allowed) {
      apiLogger.warn({ userId: authedUser.id, registrationId }, "registrant-barcode:rate-limited");
      return NextResponse.json(
        { error: "Too many requests" },
        { status: 429, headers: { "Retry-After": String(retryAfterSeconds) } },
      );
    }

    // Reviewers/submitters (non-REGISTRANT with no org) can't own a
    // registration — reject before the nested relation filter.
    const isRegistrant = authedUser.role === "REGISTRANT";
    if (!isRegistrant && !authedUser.organizationId) {
      apiLogger.warn({ userId: authedUser.id, role: authedUser.role, registrationId }, "registrant-barcode:forbidden-no-org");
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const registration = await db.registration.findFirst({
      where: {
        id: registrationId,
        // H8: a registrant is owner-scoped (their own row only). An org-staff
        // caller must have EVENT ACCESS to the registration's event —
        // `buildEventAccessWhere` (no eventId) makes this ASSIGNMENT-scoped for
        // ONSITE (settings.onsiteUserIds) instead of org-wide, so an ONSITE
        // temp assigned to Event A can no longer pull a barcode for Event B.
        ...(isRegistrant
          ? { userId: authedUser.id }
          : { event: buildEventAccessWhere(authedUser) }),
      },
      select: { qrCode: true, serialId: true },
    });

    if (!registration) {
      apiLogger.warn({ userId: authedUser.id, registrationId, isRegistrant }, "registrant-barcode:not-found-or-no-access");
      return NextResponse.json({ error: "Registration not found" }, { status: 404 });
    }

    // qrCode only — DTCM barcodes are never exposed on the public portal.
    if (!registration.qrCode) {
      return NextResponse.json({ error: "No barcode for this registration" }, { status: 404 });
    }

    // Encodes `{qrCode}-{serialId}` so a raw scanner dump identifies the person.
    const png = await renderBarcodePng(entryBarcodeValue(registration.qrCode, registration.serialId), { includetext: true });
    return new NextResponse(new Uint8Array(png), {
      status: 200,
      headers: {
        "Content-Type": "image/png",
        "Cache-Control": "private, max-age=3600",
      },
    });
    });
  } catch (error) {
    apiLogger.error({ err: error, msg: "Error rendering registrant barcode", registrationId });
    return NextResponse.json({ error: "Failed to render barcode" }, { status: 500 });
  }
}
