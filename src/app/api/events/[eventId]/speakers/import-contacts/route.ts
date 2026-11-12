import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { requireOrgId } from "@/lib/require-org";
import { db } from "@/lib/db";
import { runWithTenant } from "@/lib/tenant-context";
import { requirePermission } from "@/lib/permissions/require-permission";
import { apiLogger } from "@/lib/logger";
import { recordImport } from "@/lib/audit-data-transfer";
import { getClientIp } from "@/lib/security";
import { ensureCompanionsForSpeakerEmails } from "@/lib/speaker-companion";
import { SPEAKER_API_REGISTRATION_TYPE } from "@/lib/faculty-filter";

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
    const orgGuard = requireOrgId(session, { route: "events/[eventId]/speakers/import-contacts:POST" });
    if ("error" in orgGuard) return orgGuard.error;

    const gate = requirePermission(session, "speakers.import", { route: "events/[eventId]/speakers/import-contacts:POST", eventId });
    if (!gate.ok) return gate.response;

    // Tenancy sweep: ALS tenant scope (no-op while RLS_SET_LOCAL is off).
    const orgId = orgGuard.orgId;
    return await runWithTenant(orgId, async () => {
    const validated = importSchema.safeParse(body);
    if (!validated.success) {
      apiLogger.warn({ msg: "events/speakers/import-contacts:zod-validation-failed", errors: validated.error.flatten() });
      return NextResponse.json({ error: "Invalid input" }, { status: 400 });
    }

    const { contactIds } = validated.data;

    // Verify event belongs to org and fetch existing speaker emails
    const [event, contacts, existingSpeakers] = await Promise.all([
      db.event.findFirst({
        where: gate.eventWhere,
        select: { id: true },
      }),
      db.contact.findMany({
        where: {
          id: { in: contactIds },
          organizationId: orgGuard.orgId,
        },
        // Every person column a Speaker also has: the same set Import from
        // Registrations copies, so a speaker brought in here is not thinner
        // than one brought in through a registration (tags and role were
        // dropped before Nov 12, 2026).
        select: {
          id: true, title: true, role: true, email: true, additionalEmail: true, firstName: true, lastName: true,
          organization: true, jobTitle: true, phone: true, photo: true, city: true, state: true, zipCode: true,
          country: true, bio: true, specialty: true, customSpecialty: true, registrationType: true, tags: true,
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

    // Ignoring case, and once per address within the batch: the Speaker
    // unique is on the address as stored, so "A@x.com" beside "a@x.com" would
    // otherwise become a second speaker for one person.
    const seen = new Set(existingSpeakers.map((s) => s.email.toLowerCase()));
    const toCreate = contacts.filter((c) => {
      const key = c.email.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    const skipped = contacts.length - toCreate.length;

    if (toCreate.length > 0) {
      await db.speaker.createMany({
        data: toCreate.map((c) => ({
          eventId,
          organizationId: orgGuard.orgId, // multi-tenancy: Speaker sweep
          title: c.title ?? undefined,
          role: c.role ?? undefined,
          email: c.email,
          additionalEmail: c.additionalEmail ?? undefined,
          firstName: c.firstName,
          lastName: c.lastName,
          organization: c.organization ?? undefined,
          jobTitle: c.jobTitle ?? undefined,
          phone: c.phone ?? undefined,
          photo: c.photo ?? undefined,
          city: c.city ?? undefined,
          state: c.state ?? undefined,
          zipCode: c.zipCode ?? undefined,
          country: c.country ?? undefined,
          bio: c.bio ?? undefined,
          specialty: c.specialty ?? undefined,
          customSpecialty: c.customSpecialty ?? undefined,
          // Not the contact's own category: this column is what the speakers
          // API serves and the website sync shows, and a speaker made here
          // is Faculty (SPEAKER_API_REGISTRATION_TYPE). The profession is
          // carried by `role` above.
          registrationType: SPEAKER_API_REGISTRATION_TYPE,
          tags: c.tags.length > 0 ? c.tags : undefined,
        })),
        skipDuplicates: true,
      });
    }

    // Ensure each imported speaker gets a companion registration (badge /
    // barcode / DTCM / check-in / survey). Awaited; per-item failure-isolated.
    // The summary is the answer, not a detail (review of efb00d74): "linked"
    // is someone who was already registered and keeps that registration, on
    // whatever type and payment it stands, and "failed" is a speaker with no
    // registration. Neither heals on a second import, because the person is a
    // speaker by then and is skipped, so both go back to the organiser.
    let registrations = { created: 0, linked: 0, failed: 0 };
    if (toCreate.length > 0) {
      registrations = await ensureCompanionsForSpeakerEmails(eventId, toCreate.map((c) => c.email));
      if (registrations.linked > 0 || registrations.failed > 0) {
        apiLogger.warn({ msg: "events/speakers/import-contacts:registrations-not-all-made", eventId, speakers: toCreate.length, ...registrations });
      }
      // The event goes on each contact, as Add Speaker and the speakers CSV
      // import do through syncToContact: it is what the central contacts table
      // reads to say which events a person was part of. Only the stamp: the
      // contact is where these details came from. A failure here must not
      // undo an import that has already happened.
      await db.contact
        .updateMany({
          where: { id: { in: toCreate.map((c) => c.id) }, organizationId: orgGuard.orgId, NOT: { eventIds: { has: eventId } } },
          data: { eventIds: { push: eventId } },
        })
        .catch((err) => apiLogger.error({ err, msg: "events/speakers/import-contacts:contact-event-stamp-failed", eventId }));
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

    recordImport(req, {
      entityType: "Speaker",
      eventId,
      organizationId: orgGuard.orgId,
      userId: session.user.id,
      role: session.user.role,
      totalProcessed: contacts.length,
      created: toCreate.length,
      skipped,
      format: "contacts",
    });

    return NextResponse.json({
      created: toCreate.length,
      skipped,
      facultyRegistrations: registrations.created,
      linkedRegistrations: registrations.linked,
      failedRegistrations: registrations.failed,
    });
    });
  } catch (error) {
    apiLogger.error({ err: error, msg: "Error importing contacts as speakers" });
    return NextResponse.json({ error: "Failed to import contacts" }, { status: 500 });
  }
}
