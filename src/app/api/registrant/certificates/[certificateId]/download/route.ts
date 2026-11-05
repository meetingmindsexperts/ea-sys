import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { apiLogger } from "@/lib/logger";
import { checkRateLimit } from "@/lib/security";
import { rateLimited } from "@/lib/api-errors";
import { resolveRequestOrgId } from "@/lib/tenant/resolver";
import { runWithTenantLane } from "@/lib/tenant-lane";
import { loadCertificatePdfBytes } from "@/lib/certificates/pdf-loader";
import { findReleasedCertificates } from "@/lib/registrant-certificates";
import { loadRegistrantScope } from "@/lib/registrant-access";

const ROUTE = "registrant/certificates/[certificateId]/download:GET";
const DOWNLOAD_LIMIT = 60;
const DOWNLOAD_WINDOW_MS = 3600_000;

/**
 * GET /api/registrant/certificates/[certificateId]/download
 *
 * A person's own certificate PDF, from their portal. Certificate files are on
 * the private upload prefix, so this route is the only way in: it finds the
 * certificate through `findReleasedCertificates`, which is what the portal
 * lists by, so an id that is not theirs, not yet sent, or revoked is a 404
 * whichever of those it is.
 */
export async function GET(req: Request, { params }: { params: Promise<{ certificateId: string }> }) {
  try {
    const [session, { certificateId }] = await Promise.all([auth(), params]);
    if (!session?.user?.id || !session.user.email) {
      apiLogger.warn({ msg: `${ROUTE}:unauthorized` });
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    const userId = session.user.id;

    const rl = checkRateLimit({ key: `registrant-cert-download:${userId}`, limit: DOWNLOAD_LIMIT, windowMs: DOWNLOAD_WINDOW_MS });
    if (!rl.allowed) {
      return rateLimited(rl, { route: ROUTE, userId, limit: DOWNLOAD_LIMIT, windowSeconds: DOWNLOAD_WINDOW_MS / 1000 });
    }

    // A registrant is org-null, so the lane comes from the host, as sign-in does.
    const orgId = await resolveRequestOrgId(req);
    return await runWithTenantLane(orgId, { route: ROUTE, userId }, async () => {
      const scope = await loadRegistrantScope(userId);
      const [cert] = scope ? await findReleasedCertificates(scope, certificateId) : [];
      if (!cert?.pdfUrl) {
        apiLogger.warn({ msg: `${ROUTE}:not-found`, userId, certificateId });
        return NextResponse.json({ error: "Certificate not found" }, { status: 404 });
      }

      const bytes = await loadCertificatePdfBytes(cert.pdfUrl, { eventId: cert.event.id, certificateId: cert.id, userId });
      apiLogger.info({ msg: `${ROUTE}:downloaded`, userId, certificateId: cert.id, eventId: cert.event.id });
      // The serial is system-generated, but the header is built from it, so
      // keep only what a filename can safely hold.
      const filename = `Certificate-${cert.serial.replace(/[^A-Za-z0-9._-]/g, "")}.pdf`;
      return new NextResponse(new Uint8Array(bytes), {
        headers: {
          "Content-Type": "application/pdf",
          "Content-Disposition": `attachment; filename="${filename}"`,
          "Cache-Control": "private, no-store",
        },
      });
    });
  } catch (error) {
    apiLogger.error({ err: error, msg: `${ROUTE}:failed` });
    return NextResponse.json({ error: "Could not download the certificate" }, { status: 500 });
  }
}
