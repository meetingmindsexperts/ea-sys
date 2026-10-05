import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { requirePermission } from "@/lib/permissions/require-permission";
import { can } from "@/lib/permissions/can";
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
    // `emailLogs.read` for the event-tied history (registrations, speakers),
    // scoped by the grant's own event filter.
    const gate = requirePermission(session, "emailLogs.read", { route: "email-logs:GET" });
    if (!gate.ok) return gate.response;

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

    // CONTACT, USER and OTHER history is not tied to an event the caller
    // works, so it needs `emailLogs.org.read` (ADMIN, ORGANIZER). WEBINARS
    // (review M-1) holds only the event-tied key: CONTACT would be a side-door
    // around its contacts exclusion, and USER/OTHER have no owner to confine by.
    if (entityType !== "REGISTRATION" && entityType !== "SPEAKER" && !can(gate.principal, "emailLogs.org.read")) {
      apiLogger.warn({ msg: "email-logs:entity-type-refused", entityType, userId: session.user.id });
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
    // The ownership lookup binds through the grant's event filter: the whole
    // organisation for ADMIN, ORGANIZER and WEBINARS today (WEBINARS reads the
    // desk on every event), never wider than the grant.
    const entityEventWhere = gate.eventWhere;

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
