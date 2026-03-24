import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { denyReviewer } from "@/lib/auth-guards";
import { apiLogger } from "@/lib/logger";

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
            select: {
              title: true,
              email: true,
              firstName: true,
              lastName: true,
              organization: true,
              jobTitle: true,
              phone: true,
              city: true,
              country: true,
              specialty: true,
              registrationType: true,
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
        data: dedupedToCreate.map((r) => ({
          eventId,
          title: r.attendee.title ?? undefined,
          email: r.attendee.email,
          firstName: r.attendee.firstName,
          lastName: r.attendee.lastName,
          organization: r.attendee.organization ?? undefined,
          jobTitle: r.attendee.jobTitle ?? undefined,
          phone: r.attendee.phone ?? undefined,
          city: r.attendee.city ?? undefined,
          country: r.attendee.country ?? undefined,
          specialty: r.attendee.specialty ?? undefined,
          registrationType: r.attendee.registrationType ?? undefined,
        })),
        skipDuplicates: true,
      });
    }

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
