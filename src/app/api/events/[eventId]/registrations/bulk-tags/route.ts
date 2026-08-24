import { NextResponse } from "next/server";
import { z } from "zod";
import { db, tenantTransaction } from "@/lib/db";
import { auth } from "@/lib/auth";
import { requireOrgId } from "@/lib/require-org";
import { denyReviewer, WEBINAR_STAFF_ALLOW } from "@/lib/auth-guards";
import { buildEventAccessWhere } from "@/lib/event-access";
import { apiLogger } from "@/lib/logger";
import { normalizeTag } from "@/lib/utils";
import { runWithTenant } from "@/lib/tenant-context";
import { computeTagDelta, syncRegistrationTagsToSpeakers, type RegistrationTagChange } from "@/lib/person-tag-sync";

const bulkTagsSchema = z.object({
  registrationIds: z.array(z.string()).min(1),
  tags: z.array(z.string().transform(normalizeTag)),
  mode: z.enum(["add", "remove", "replace"]),
});

type RouteParams = { params: Promise<{ eventId: string }> };

export async function PATCH(req: Request, { params }: RouteParams) {
  try {
    const [{ eventId }, session, body] = await Promise.all([
      params,
      auth(),
      req.json(),
    ]);

    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    const orgGuard = requireOrgId(session, { route: "events/[eventId]/registrations/bulk-tags:PATCH" });
    if ("error" in orgGuard) return orgGuard.error;

    // Restricted roles (REVIEWER/SUBMITTER/REGISTRANT/MEMBER/ONSITE) must not
    // rewrite tags — tags drive bulk-email cohorts and certificate eligibility.
    const denied = denyReviewer(session, { allow: WEBINAR_STAFF_ALLOW });
    if (denied) return denied;

    return await runWithTenant(orgGuard.orgId, async () => {
    const event = await db.event.findFirst({
      where: buildEventAccessWhere(session.user, eventId),
      select: { id: true },
    });

    if (!event) {
      return NextResponse.json({ error: "Event not found" }, { status: 404 });
    }

    const validated = bulkTagsSchema.safeParse(body);
    if (!validated.success) {
        apiLogger.warn({ msg: "events/registrations/bulk-tags:zod-validation-failed", errors: validated.error.flatten() });
      return NextResponse.json(
        { error: "Invalid input", details: validated.error.flatten() },
        { status: 400 }
      );
    }

    const { registrationIds, tags, mode } = validated.data;

    // Get attendees for these registrations
    const registrations = await db.registration.findMany({
      where: { id: { in: registrationIds }, eventId },
      select: { id: true, attendee: { select: { id: true, tags: true, email: true } } },
    });

    if (registrations.length === 0) {
      return NextResponse.json({ error: "No registrations found" }, { status: 404 });
    }

    // Track the per-person delta so we can mirror it onto the linked Speaker.
    const tagChanges: RegistrationTagChange[] = [];
    const updates = registrations.map((reg) => {
      let newTags: string[];
      if (mode === "add") {
        newTags = [...new Set([...reg.attendee.tags, ...tags])];
      } else if (mode === "remove") {
        const toRemove = new Set(tags);
        newTags = reg.attendee.tags.filter((t) => !toRemove.has(t));
      } else {
        newTags = tags;
      }
      tagChanges.push({
        registrationId: reg.id,
        email: reg.attendee.email,
        delta: computeTagDelta(reg.attendee.tags, newTags),
      });
      return { attendeeId: reg.attendee.id, newTags };
    });

    // Interactive form (was array-form `db.$transaction(updates)`): array form
    // can't carry the tenant SET LOCAL, so the writes run sequentially in one
    // tenantTransaction instead (same atomicity, flag-off identical).
    const results = await tenantTransaction(async (tx) => {
      const rows: { id: string; tags: string[] }[] = [];
      for (const u of updates) {
        rows.push(
          await tx.attendee.update({
            where: { id: u.attendeeId },
            data: { tags: u.newTags },
            select: { id: true, tags: true },
          }),
        );
      }
      return rows;
    });

    // Mirror the change onto each person's Speaker facet (best-effort).
    await syncRegistrationTagsToSpeakers(eventId, tagChanges);

    return NextResponse.json({ updated: results.length, attendees: results });
    });
  } catch (error) {
    apiLogger.error({ err: error, msg: "Error bulk-updating registration tags" });
    return NextResponse.json({ error: "Failed to update tags" }, { status: 500 });
  }
}
