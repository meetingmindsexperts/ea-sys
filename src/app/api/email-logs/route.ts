import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { denyReviewer, WEBINAR_STAFF_ALLOW } from "@/lib/auth-guards";
import { buildEventAccessWhere } from "@/lib/event-access";
import { getEmailLogsFor } from "@/lib/email-log";
import { runWithTenant } from "@/lib/tenant-context";

const querySchema = z.object({
  entityType: z.enum(["REGISTRATION", "SPEAKER", "CONTACT", "USER", "OTHER"]),
  entityId: z.string().min(1).max(100),
});

export async function GET(req: Request) {
  try {
    const session = await auth();
    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    const denied = denyReviewer(session, { allow: WEBINAR_STAFF_ALLOW });
    if (denied) return denied;

    const { searchParams } = new URL(req.url);
    const parsed = querySchema.safeParse({
      entityType: searchParams.get("entityType"),
      entityId: searchParams.get("entityId"),
    });
    if (!parsed.success) {
      apiLogger.warn({ msg: "email-logs:invalid-input", errors: parsed.error.flatten() });
      return NextResponse.json({ error: "Invalid query" }, { status: 400 });
    }

    const { entityType, entityId } = parsed.data;

    // Ownership / org-scope verification: confirm the entity belongs to the
    // caller's org before returning email history — otherwise an admin from
    // a different org could query arbitrary ids.
    const orgId = session.user.organizationId ?? null;
    if (!orgId) {
      return NextResponse.json({ logs: [] });
    }

    // WEBINARS (review M-1): email history only for entities on ITS events
    // (webinars + desk-assigned conferences, via the role-aware where below).
    // CONTACT is a straight side-door around its contacts exclusion
    // (canViewContacts=false) and USER/OTHER have no per-entity owner to
    // confine by — refuse all three for this role.
    const isWebinarsRole = session.user.role === "WEBINARS";
    if (isWebinarsRole && entityType !== "REGISTRATION" && entityType !== "SPEAKER") {
      apiLogger.warn({ msg: "email-logs:webinars-entity-type-refused", entityType, userId: session.user.id });
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
    // For WEBINARS the ownership lookup binds through buildEventAccessWhere
    // (desk surface) instead of bare org scope; identical for other roles.
    const entityEventWhere = isWebinarsRole
      ? buildEventAccessWhere(session.user, undefined, { surface: "desk" })
      : { organizationId: orgId };

    // Tenancy (Domain #18): the ownership lookups read swept Registration /
    // Speaker / Contact and the log read is on swept EmailLog — all ride the
    // caller's org lane. Passthrough on master.
    return await runWithTenant(orgId, async () => {

    let ownershipOk = false;
    switch (entityType) {
      case "REGISTRATION": {
        const row = await db.registration.findFirst({
          where: { id: entityId, event: entityEventWhere },
          select: { id: true },
        });
        ownershipOk = !!row;
        break;
      }
      case "SPEAKER": {
        const row = await db.speaker.findFirst({
          where: { id: entityId, event: entityEventWhere },
          select: { id: true },
        });
        ownershipOk = !!row;
        break;
      }
      case "CONTACT": {
        const row = await db.contact.findFirst({
          where: { id: entityId, organizationId: orgId },
          select: { id: true },
        });
        ownershipOk = !!row;
        break;
      }
      case "USER":
      case "OTHER":
        // No per-entity owner — only surface logs already tagged with the org.
        ownershipOk = true;
        break;
    }
    if (!ownershipOk) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    const logs = await getEmailLogsFor(entityType, entityId, orgId);
    return NextResponse.json({ logs });
    });
  } catch (error) {
    apiLogger.error({ err: error, msg: "Failed to fetch email logs" });
    return NextResponse.json({ error: "Failed to fetch email logs" }, { status: 500 });
  }
}
