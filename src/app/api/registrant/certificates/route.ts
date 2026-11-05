import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { apiLogger } from "@/lib/logger";
import { resolveRequestOrgId } from "@/lib/tenant/resolver";
import { runWithTenantLane } from "@/lib/tenant-lane";
import { certificateMeta, certificateTitle, findReleasedCertificates } from "@/lib/registrant-certificates";
import { loadRegistrantScope } from "@/lib/registrant-access";

const ROUTE = "registrant/certificates:GET";

/**
 * GET /api/registrant/certificates?event={slug}
 *
 * The signed-in person's released certificates, for an event's own My
 * Registration page (the all-events list reads them on the server). The same
 * `findReleasedCertificates` the download route asks, so everything listed
 * here downloads and nothing else does. `event` narrows to one event.
 */
export async function GET(req: Request) {
  try {
    const session = await auth();
    if (!session?.user?.id || !session.user.email) {
      apiLogger.warn({ msg: `${ROUTE}:unauthorized` });
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    const userId = session.user.id;
    const eventSlug = new URL(req.url).searchParams.get("event");

    // A registrant is org-null, so the lane comes from the host, as sign-in does.
    const orgId = await resolveRequestOrgId(req);
    return await runWithTenantLane(orgId, { route: ROUTE, userId }, async () => {
      const scope = await loadRegistrantScope(userId);
      const certs = scope ? await findReleasedCertificates(scope) : [];
      const certificates = certs
        .filter((c) => !eventSlug || c.event.slug === eventSlug)
        .map((c) => ({ id: c.id, eventSlug: c.event.slug, title: certificateTitle(c), meta: certificateMeta(c) }));
      return NextResponse.json({ certificates });
    });
  } catch (error) {
    apiLogger.error({ err: error, msg: `${ROUTE}:failed` });
    return NextResponse.json({ error: "Could not load your certificates" }, { status: 500 });
  }
}
