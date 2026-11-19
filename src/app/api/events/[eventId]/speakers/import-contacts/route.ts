import { NextResponse } from "next/server";
import { z } from "zod";
import { CONTACT_IMPORT_MAX, CONTACT_IMPORT_TOO_MANY } from "@/lib/contact-page-sizes";
import { auth } from "@/lib/auth";
import { requireOrgId } from "@/lib/require-org";
import { findGatedEvent } from "@/lib/tenant/event-tenant";
import { runWithTenant } from "@/lib/tenant-context";
import { requirePermission } from "@/lib/permissions/require-permission";
import { apiLogger } from "@/lib/logger";
import { getClientIp } from "@/lib/security";
import { importSpeakersFromContacts } from "@/services/speaker-service";

type RouteParams = { params: Promise<{ eventId: string }> };

const importSchema = z.object({
  contactIds: z.array(z.string()).min(1).max(CONTACT_IMPORT_MAX),
});

/**
 * Speakers, Import from Contacts. The import itself is
 * `importSpeakersFromContacts`, shared with the agent's
 * `import_speakers_from_contacts` (Nov 18, 2026); this door keeps the sign-in,
 * the permission, the grant's event filter and the HTTP answer.
 */
export async function POST(req: Request, { params }: RouteParams) {
  try {
    const [{ eventId }, session, body] = await Promise.all([params, auth(), req.json()]);

    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    const orgGuard = requireOrgId(session, { route: "events/[eventId]/speakers/import-contacts:POST" });
    if ("error" in orgGuard) return orgGuard.error;

    const gate = requirePermission(session, "speakers.import", { route: "events/[eventId]/speakers/import-contacts:POST", eventId });
    if (!gate.ok) return gate.response;

    const orgId = orgGuard.orgId;
    return await runWithTenant(orgId, async () => {
      const validated = importSchema.safeParse(body);
      if (!validated.success) {
        apiLogger.warn({ msg: "events/speakers/import-contacts:zod-validation-failed", errors: validated.error.flatten() });
        // Too many picked says so (Nov 19, 2026), rather than "Invalid input".
        const tooMany = validated.error.issues.some((i) => i.path[0] === "contactIds" && i.code === "too_big");
        return NextResponse.json(tooMany ? { error: CONTACT_IMPORT_TOO_MANY, code: "TOO_MANY_CONTACTS" } : { error: "Invalid input" }, { status: 400 });
      }

      // The grant's own event filter (an assigned-events role sees fewer).
      const event = await findGatedEvent(gate, { select: { id: true } });
      if (!event) {
        apiLogger.warn({ msg: "events/speakers/import-contacts:event-not-found", eventId });
        return NextResponse.json({ error: "Event not found" }, { status: 404 });
      }

      const result = await importSpeakersFromContacts({
        eventId,
        organizationId: orgId,
        userId: session.user.id,
        contactIds: validated.data.contactIds,
        source: "rest",
        role: session.user.role,
        requestIp: getClientIp(req),
      });
      if (!result.ok) {
        apiLogger.warn({ msg: "events/speakers/import-contacts:refused", eventId, code: result.code });
        return NextResponse.json({ error: result.message, code: result.code }, { status: 404 });
      }

      return NextResponse.json({
        created: result.created,
        skipped: result.skipped,
        facultyRegistrations: result.registrations.created,
        linkedRegistrations: result.registrations.linked,
        failedRegistrations: result.registrations.failed,
      });
    });
  } catch (error) {
    apiLogger.error({ err: error, msg: "Error importing contacts as speakers" });
    return NextResponse.json({ error: "Failed to import contacts" }, { status: 500 });
  }
}
