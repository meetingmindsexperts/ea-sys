import { NextResponse } from "next/server";
import { z } from "zod";
import { db, tenantTransaction } from "@/lib/db";
import { runWithTenant } from "@/lib/tenant-context";
import { auth } from "@/lib/auth";
import { requireOrgId } from "@/lib/require-org";
import { denyReviewer, WEBINAR_STAFF_ALLOW } from "@/lib/auth-guards";
import { buildEventAccessWhere } from "@/lib/event-access";
import { apiLogger } from "@/lib/logger";
import { normalizeTag } from "@/lib/utils";
import { getClientIp } from "@/lib/security";
import { computeTagDelta, syncSpeakerTagsToRegistrations, type SpeakerTagChange } from "@/lib/person-tag-sync";

const bulkTagsSchema = z.object({
  speakerIds: z.array(z.string()).min(1),
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
    const orgGuard = requireOrgId(session, { route: "events/[eventId]/speakers/bulk-tags:PATCH" });
    if ("error" in orgGuard) return orgGuard.error;

    // Restricted roles must not rewrite tags (drive email cohorts + cert eligibility).
    const denied = denyReviewer(session, { allow: WEBINAR_STAFF_ALLOW });
    if (denied) return denied;

    // Tenancy sweep: ALS tenant scope (no-op while RLS_SET_LOCAL is off).
    const orgId = orgGuard.orgId;
    return await runWithTenant(orgId, async () => {
    const event = await db.event.findFirst({
      where: buildEventAccessWhere(session.user, eventId),
      select: { id: true },
    });

    if (!event) {
      return NextResponse.json({ error: "Event not found" }, { status: 404 });
    }

    const validated = bulkTagsSchema.safeParse(body);
    if (!validated.success) {
        apiLogger.warn({ msg: "events/speakers/bulk-tags:zod-validation-failed", errors: validated.error.flatten() });
      return NextResponse.json(
        { error: "Invalid input", details: validated.error.flatten() },
        { status: 400 }
      );
    }

    const { speakerIds, tags, mode } = validated.data;

    const speakers = await db.speaker.findMany({
      where: { id: { in: speakerIds }, eventId },
      select: { id: true, tags: true, email: true, sourceRegistrationId: true },
    });

    if (speakers.length === 0) {
      return NextResponse.json({ error: "No speakers found" }, { status: 404 });
    }

    // Track the per-person delta so we can mirror it onto the linked Registration.
    const tagChanges: SpeakerTagChange[] = [];
    const updates = speakers.map((speaker) => {
      let newTags: string[];
      if (mode === "add") {
        newTags = [...new Set([...speaker.tags, ...tags])];
      } else if (mode === "remove") {
        const toRemove = new Set(tags);
        newTags = speaker.tags.filter((t) => !toRemove.has(t));
      } else {
        newTags = tags;
      }
      tagChanges.push({
        speakerId: speaker.id,
        email: speaker.email,
        sourceRegistrationId: speaker.sourceRegistrationId,
        delta: computeTagDelta(speaker.tags, newTags),
      });
      return { id: speaker.id, newTags };
    });

    // tenantTransaction (was array-form db.$transaction(updates)): the array
    // form can't carry SET LOCAL onto its own pooled backend → the updates
    // fail-close under platform RLS. Sequential interactive; passthrough on
    // master. Rebuild each update on `tx` so it rides the tenant store.
    const results = await tenantTransaction(async (tx) => {
      const out: { id: string; tags: string[] }[] = [];
      for (const u of updates) {
        out.push(
          await tx.speaker.update({
            where: { id: u.id },
            data: { tags: u.newTags },
            select: { id: true, tags: true },
          }),
        );
      }
      return out;
    });

    // Mirror the change onto each person's Registration facet (best-effort).
    await syncSpeakerTagsToRegistrations(eventId, tagChanges);

    // Audit trail (fire-and-forget). Tags drive email cohorts + cert
    // eligibility, so bulk retag is consequential — one row per bulk op.
    db.auditLog
      .create({
        data: {
          eventId,
          userId: session.user.id,
          action: "UPDATE",
          entityType: "Speaker",
          entityId: `bulk:${results.length}`,
          changes: {
            bulk: true,
            operation: "tags",
            mode,
            tags,
            speakerIds: results.map((r) => r.id),
            ip: getClientIp(req),
          },
          ipAddress: getClientIp(req),
        },
      })
      .catch((err) => apiLogger.error({ err, msg: "Failed to write speaker bulk-tags audit log" }));

    return NextResponse.json({ updated: results.length, speakers: results });
    });
  } catch (error) {
    apiLogger.error({ err: error, msg: "Error bulk-updating speaker tags" });
    return NextResponse.json({ error: "Failed to update tags" }, { status: 500 });
  }
}
