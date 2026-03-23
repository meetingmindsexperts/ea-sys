import { NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { auth } from "@/lib/auth";
import { apiLogger } from "@/lib/logger";
import { normalizeTag } from "@/lib/utils";

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

    const event = await db.event.findFirst({
      where: { id: eventId, organizationId: session.user.organizationId! },
      select: { id: true },
    });

    if (!event) {
      return NextResponse.json({ error: "Event not found" }, { status: 404 });
    }

    const validated = bulkTagsSchema.safeParse(body);
    if (!validated.success) {
      return NextResponse.json(
        { error: "Invalid input", details: validated.error.flatten() },
        { status: 400 }
      );
    }

    const { registrationIds, tags, mode } = validated.data;

    // Get attendees for these registrations
    const registrations = await db.registration.findMany({
      where: { id: { in: registrationIds }, eventId },
      select: { id: true, attendee: { select: { id: true, tags: true } } },
    });

    if (registrations.length === 0) {
      return NextResponse.json({ error: "No registrations found" }, { status: 404 });
    }

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
      return db.attendee.update({
        where: { id: reg.attendee.id },
        data: { tags: newTags },
        select: { id: true, tags: true },
      });
    });

    const results = await db.$transaction(updates);

    return NextResponse.json({ updated: results.length, attendees: results });
  } catch (error) {
    apiLogger.error({ err: error, msg: "Error bulk-updating registration tags" });
    return NextResponse.json({ error: "Failed to update tags" }, { status: 500 });
  }
}
