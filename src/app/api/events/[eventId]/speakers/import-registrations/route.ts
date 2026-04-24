import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { denyReviewer } from "@/lib/auth-guards";
import { apiLogger } from "@/lib/logger";
import { refreshEventStats } from "@/lib/event-stats";

type RouteParams = { params: Promise<{ eventId: string }> };

const importSchema = z.object({
  registrationIds: z.array(z.string()).min(1).max(500),
});

export async function POST(req: Request, { params }: RouteParams) {
  try {
    const [{ eventId }, session, body] = await Promise.all([params, auth(), req.json()]);

    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const denied = denyReviewer(session);
    if (denied) return denied;

    const validated = importSchema.safeParse(body);
    if (!validated.success) {
      apiLogger.warn({ msg: "events/speakers/import-registrations:zod-validation-failed", errors: validated.error.flatten() });
      return NextResponse.json({ error: "Invalid input" }, { status: 400 });
    }

    const { registrationIds } = validated.data;

    // Verify event belongs to org, fetch registrations with attendee data, and existing speaker emails
    const [event, registrations, existingSpeakers] = await Promise.all([
      db.event.findFirst({
        where: { id: eventId, organizationId: session.user.organizationId! },
        select: { id: true },
      }),
      db.registration.findMany({
        where: {
          id: { in: registrationIds },
          eventId,
          status: { not: "CANCELLED" },
        },
        include: {
          attendee: {
            // Select every Attendee column that has a matching Speaker
            // column. Fields only on Attendee (dietaryReqs, customFields,
            // memberId, studentId, studentIdExpiry, associationName) are
            // registrant-specific and correctly omitted here.
            select: {
              title: true,
              role: true,
              email: true,
              additionalEmail: true,
              firstName: true,
              lastName: true,
              organization: true,
              jobTitle: true,
              phone: true,
              photo: true,
              city: true,
              state: true,
              zipCode: true,
              country: true,
              bio: true,
              specialty: true,
              customSpecialty: true,
              registrationType: true,
              tags: true,
            },
          },
        },
      }),
      db.speaker.findMany({
        where: { eventId },
        select: { email: true },
      }),
    ]);

    if (!event) {
      return NextResponse.json({ error: "Event not found" }, { status: 404 });
    }

    const existingEmails = new Set(existingSpeakers.map((s) => s.email.toLowerCase()));
    const toCreate = registrations.filter(
      (r) => !existingEmails.has(r.attendee.email.toLowerCase())
    );
    // Deduplicate by email within the batch (same attendee could have multiple registrations)
    const seen = new Set<string>();
    const dedupedToCreate = toCreate.filter((r) => {
      const key = r.attendee.email.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    const skipped = registrations.length - dedupedToCreate.length;

    if (dedupedToCreate.length > 0) {
      await db.speaker.createMany({
        // Map every Attendee column onto the corresponding Speaker column.
        // `undefined` is used for optional fields (Prisma treats it as
        // "leave null") rather than explicit null so we match createMany's
        // behaviour. Arrays default to [] at the DB when omitted.
        data: dedupedToCreate.map((r) => ({
          eventId,
          title: r.attendee.title ?? undefined,
          role: r.attendee.role ?? undefined,
          email: r.attendee.email,
          additionalEmail: r.attendee.additionalEmail ?? undefined,
          firstName: r.attendee.firstName,
          lastName: r.attendee.lastName,
          organization: r.attendee.organization ?? undefined,
          jobTitle: r.attendee.jobTitle ?? undefined,
          phone: r.attendee.phone ?? undefined,
          photo: r.attendee.photo ?? undefined,
          city: r.attendee.city ?? undefined,
          state: r.attendee.state ?? undefined,
          zipCode: r.attendee.zipCode ?? undefined,
          country: r.attendee.country ?? undefined,
          bio: r.attendee.bio ?? undefined,
          specialty: r.attendee.specialty ?? undefined,
          customSpecialty: r.attendee.customSpecialty ?? undefined,
          registrationType: r.attendee.registrationType ?? undefined,
          tags: r.attendee.tags.length > 0 ? r.attendee.tags : undefined,
        })),
        skipDuplicates: true,
      });
    }

    // Refresh denormalized event stats (fire-and-forget)
    refreshEventStats(eventId);

    apiLogger.info({
      msg: "Imported registrations as speakers",
      eventId,
      created: dedupedToCreate.length,
      skipped,
    });

    return NextResponse.json({ created: dedupedToCreate.length, skipped });
  } catch (error) {
    apiLogger.error({ err: error, msg: "Error importing registrations as speakers" });
    return NextResponse.json({ error: "Failed to import registrations" }, { status: 500 });
  }
}
