import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { denyReviewer } from "@/lib/auth-guards";
import { apiLogger } from "@/lib/logger";
import { getClientIp } from "@/lib/security";
import { ensureCompanionsForSpeakerEmails } from "@/lib/speaker-companion";

type RouteParams = { params: Promise<{ eventId: string }> };

const importSchema = z.object({
  contactIds: z.array(z.string()).min(1),
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
      apiLogger.warn({ msg: "events/speakers/import-contacts:zod-validation-failed", errors: validated.error.flatten() });
      return NextResponse.json({ error: "Invalid input" }, { status: 400 });
    }

    const { contactIds } = validated.data;

    // Verify event belongs to org and fetch existing speaker emails
    const [event, contacts, existingSpeakers] = await Promise.all([
      db.event.findFirst({
        where: { id: eventId, organizationId: session.user.organizationId! },
        select: { id: true },
      }),
      db.contact.findMany({
        where: {
          id: { in: contactIds },
          organizationId: session.user.organizationId!,
        },
        select: { id: true, title: true, email: true, firstName: true, lastName: true, organization: true, jobTitle: true, phone: true, city: true, country: true, specialty: true, registrationType: true },
      }),
      db.speaker.findMany({
        where: { eventId },
        select: { email: true },
      }),
    ]);

    if (!event) {
      return NextResponse.json({ error: "Event not found" }, { status: 404 });
    }

    const existingEmails = new Set(existingSpeakers.map((s) => s.email));
    const toCreate = contacts.filter((c) => !existingEmails.has(c.email));
    const skipped = contacts.length - toCreate.length;

    if (toCreate.length > 0) {
      await db.speaker.createMany({
        data: toCreate.map((c) => ({
          eventId,
          title: c.title ?? undefined,
          email: c.email,
          firstName: c.firstName,
          lastName: c.lastName,
          organization: c.organization ?? undefined,
          jobTitle: c.jobTitle ?? undefined,
          phone: c.phone ?? undefined,
          city: c.city ?? undefined,
          country: c.country ?? undefined,
          specialty: c.specialty ?? undefined,
          registrationType: c.registrationType ?? undefined,
        })),
        skipDuplicates: true,
      });
    }

    // Ensure each imported speaker gets a companion registration (badge /
    // barcode / DTCM / check-in / survey). Awaited; per-item failure-isolated.
    if (toCreate.length > 0) {
      await ensureCompanionsForSpeakerEmails(eventId, toCreate.map((c) => c.email));
    }

    // Audit trail (fire-and-forget) — bulk speaker import from contacts.
    db.auditLog
      .create({
        data: {
          eventId,
          userId: session.user.id,
          action: "CREATE",
          entityType: "Speaker",
          entityId: `bulk:${toCreate.length}`,
          changes: {
            bulk: true,
            source: "contacts-import",
            created: toCreate.length,
            skipped,
            ip: getClientIp(req),
          },
          ipAddress: getClientIp(req),
        },
      })
      .catch((err) => apiLogger.error({ err, msg: "Failed to write speaker contacts-import audit log" }));

    return NextResponse.json({ created: toCreate.length, skipped });
  } catch (error) {
    apiLogger.error({ err: error, msg: "Error importing contacts as speakers" });
    return NextResponse.json({ error: "Failed to import contacts" }, { status: 500 });
  }
}
