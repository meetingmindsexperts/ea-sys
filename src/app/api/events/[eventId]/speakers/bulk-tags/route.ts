import { NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { auth } from "@/lib/auth";
import { denyReviewer } from "@/lib/auth-guards";
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

    // Restricted roles must not rewrite tags (drive email cohorts + cert eligibility).
    const denied = denyReviewer(session);
    if (denied) return denied;

    const event = await db.event.findFirst({
      where: { id: eventId, organizationId: session.user.organizationId! },
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
      return db.speaker.update({
        where: { id: speaker.id },
        data: { tags: newTags },
        select: { id: true, tags: true },
      });
    });

    const results = await db.$transaction(updates);

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
  } catch (error) {
    apiLogger.error({ err: error, msg: "Error bulk-updating speaker tags" });
    return NextResponse.json({ error: "Failed to update tags" }, { status: 500 });
  }
}
