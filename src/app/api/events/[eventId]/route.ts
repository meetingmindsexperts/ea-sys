import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { buildEventAccessWhere } from "@/lib/event-access";
import { denyReviewer } from "@/lib/auth-guards";
import { getClientIp } from "@/lib/security";
import { notifyEventAdmins } from "@/lib/notifications";

const updateEventSchema = z.object({
  name: z.string().min(2).max(255).optional(),
  slug: z.string().min(2).max(200).optional(),
  description: z.string().max(2000).nullable().optional(),
  eventType: z.enum(["CONFERENCE", "WEBINAR", "HYBRID"]).nullable().optional(),
  tag: z.string().max(255).nullable().optional(),
  specialty: z.string().max(255).nullable().optional(),
  code: z.string().max(20).nullable().optional(),
  startDate: z.string().datetime().optional(),
  endDate: z.string().datetime().optional(),
  timezone: z.string().max(100).optional(),
  venue: z.string().max(255).nullable().optional(),
  address: z.string().max(500).nullable().optional(),
  city: z.string().max(255).nullable().optional(),
  country: z.string().max(255).nullable().optional(),
  supportEmail: z.string().email().max(255).nullable().optional(),
  status: z.enum(["DRAFT", "PUBLISHED", "LIVE", "COMPLETED", "CANCELLED"]).optional(),
  bannerImage: z.string().max(500).nullable().optional(),
  footerHtml: z.string().max(10000).nullable().optional(),
  emailHeaderImage: z.string().max(500).nullable().optional(),
  emailFooterHtml: z.string().max(10000).nullable().optional(),
  emailFromAddress: z.string().email().max(255).nullable().optional(),
  emailFromName: z.string().max(255).nullable().optional(),
  // Per-event auto-CC list. Server re-validates each entry against the
  // email regex and lowercases — the UI does the same on save, this is
  // belt-and-braces for direct API callers.
  emailCcAddresses: z
    .array(z.string().trim().toLowerCase().email().max(255))
    .max(20)
    .optional(),
  registrationTermsHtml: z.string().max(50000).nullable().optional(),
  registrationWelcomeHtml: z.string().max(50000).nullable().optional(),
  abstractWelcomeHtml: z.string().max(50000).nullable().optional(),
  abstractTermsHtml: z.string().max(50000).nullable().optional(),
  abstractConfirmationHtml: z.string().max(50000).nullable().optional(),
  registrationConfirmationHtml: z.string().max(50000).nullable().optional(),
  speakerAgreementHtml: z.string().max(50000).nullable().optional(),
  taxRate: z.number().min(0).max(100).nullable().optional(),
  taxLabel: z.string().max(50).nullable().optional(),
  bankDetails: z.string().max(5000).nullable().optional(),
  badgeVerticalOffset: z.number().int().min(-200).max(200).optional(),
  settings: z.record(z.string(), z.unknown()).optional(),
});

interface RouteParams {
  params: Promise<{ eventId: string }>;
}

export async function GET(req: Request, { params }: RouteParams) {
  try {
    // Parallelize params and auth for faster response
    const [{ eventId }, session] = await Promise.all([params, auth()]);

    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const event = await db.event.findFirst({
      where: buildEventAccessWhere(session.user, eventId),
      include: {
        _count: {
          select: {
            registrations: true,
            speakers: true,
            eventSessions: true,
            tracks: true,
          },
        },
      },
    });

    if (!event) {
      return NextResponse.json({ error: "Event not found" }, { status: 404 });
    }

    // Add cache headers for better performance
    const response = NextResponse.json(event);
    response.headers.set("Cache-Control", "private, max-age=0, stale-while-revalidate=30");
    return response;
  } catch (error) {
    apiLogger.error({ err: error, msg: "Error fetching event" });
    return NextResponse.json(
      { error: "Failed to fetch event" },
      { status: 500 }
    );
  }
}

export async function PUT(req: Request, { params }: RouteParams) {
  try {
    // Parallelize params, auth, and body parsing
    const [{ eventId }, session, body] = await Promise.all([
      params,
      auth(),
      req.json(),
    ]);

    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const denied = denyReviewer(session);
    if (denied) return denied;

    // Verify event belongs to user's organization (use select for minimal data)
    const existingEvent = await db.event.findFirst({
      where: buildEventAccessWhere(session.user, eventId),
      select: { id: true, slug: true, status: true, settings: true },
    });

    if (!existingEvent) {
      return NextResponse.json({ error: "Event not found" }, { status: 404 });
    }
    const validated = updateEventSchema.safeParse(body);

    if (!validated.success) {
      const details = validated.error.flatten();
      apiLogger.warn({ msg: "Event update validation failed", eventId, userId: session.user.id, errors: details, body });
      return NextResponse.json(
        { error: "Invalid input", details },
        { status: 400 }
      );
    }

    const {
      name,
      slug,
      description,
      eventType,
      tag,
      specialty,
      code,
      startDate,
      endDate,
      timezone,
      venue,
      address,
      city,
      country,
      supportEmail,
      status,
      bannerImage,
      footerHtml,
      emailHeaderImage,
      emailFooterHtml,
      emailFromAddress,
      emailFromName,
      emailCcAddresses,
      registrationTermsHtml,
      registrationWelcomeHtml,
      abstractWelcomeHtml,
      abstractTermsHtml,
      abstractConfirmationHtml,
      registrationConfirmationHtml,
      speakerAgreementHtml,
      taxRate,
      taxLabel,
      bankDetails,
      badgeVerticalOffset,
      settings,
    } = validated.data;

    // If slug is being changed, check for uniqueness
    if (slug && slug !== existingEvent.slug) {
      const slugExists = await db.event.findFirst({
        where: {
          organizationId: session.user.organizationId!,
          slug,
          id: { not: eventId },
        },
      });

      if (slugExists) {
        return NextResponse.json(
          { error: "An event with this slug already exists" },
          { status: 400 }
        );
      }
    }

    // Merge settings if provided — protect managed keys from being overwritten
    const currentSettings = (existingEvent.settings as Record<string, unknown>) || {};
    let mergedSettings = currentSettings;
    if (settings) {
      // Strip protected keys that are managed by dedicated endpoints (e.g. reviewers API)
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const { reviewerUserIds: _protected, ...safeSettings } = settings;
      mergedSettings = { ...currentSettings, ...safeSettings };
    }
    const updatedSettings = JSON.parse(JSON.stringify(mergedSettings));

    const event = await db.event.update({
      where: { id: eventId },
      data: {
        ...(name && { name }),
        ...(slug && { slug }),
        ...(description !== undefined && { description }),
        ...(eventType !== undefined && { eventType }),
        ...(tag !== undefined && { tag }),
        ...(specialty !== undefined && { specialty }),
        ...(code !== undefined && { code }),
        ...(startDate && { startDate: new Date(startDate) }),
        ...(endDate && { endDate: new Date(endDate) }),
        ...(timezone && { timezone }),
        ...(venue !== undefined && { venue }),
        ...(address !== undefined && { address }),
        ...(city !== undefined && { city }),
        ...(country !== undefined && { country }),
        ...(supportEmail !== undefined && { supportEmail }),
        ...(status && { status }),
        ...(bannerImage !== undefined && { bannerImage }),
        ...(footerHtml !== undefined && { footerHtml }),
        ...(emailHeaderImage !== undefined && { emailHeaderImage }),
        ...(emailFooterHtml !== undefined && { emailFooterHtml }),
        ...(emailFromAddress !== undefined && { emailFromAddress }),
        ...(emailFromName !== undefined && { emailFromName }),
        ...(emailCcAddresses !== undefined && { emailCcAddresses }),
        ...(registrationTermsHtml !== undefined && { registrationTermsHtml }),
        ...(registrationWelcomeHtml !== undefined && { registrationWelcomeHtml }),
        ...(abstractWelcomeHtml !== undefined && { abstractWelcomeHtml }),
        ...(abstractTermsHtml !== undefined && { abstractTermsHtml }),
        ...(abstractConfirmationHtml !== undefined && { abstractConfirmationHtml }),
        ...(registrationConfirmationHtml !== undefined && { registrationConfirmationHtml }),
        ...(speakerAgreementHtml !== undefined && { speakerAgreementHtml }),
        ...(taxRate !== undefined && { taxRate }),
        ...(taxLabel !== undefined && { taxLabel }),
        ...(bankDetails !== undefined && { bankDetails }),
        ...(badgeVerticalOffset !== undefined && { badgeVerticalOffset }),
        settings: updatedSettings,
      },
    });

    apiLogger.info({ msg: "Event updated", eventId, userId: session.user.id, fields: Object.keys(validated.data) });

    // Log the action
    await db.auditLog.create({
      data: {
        eventId,
        userId: session.user.id,
        action: "UPDATE",
        entityType: "Event",
        entityId: eventId,
        changes: { ...JSON.parse(JSON.stringify(validated.data)), ip: getClientIp(req) },
      },
    });

    // Notify admins on status change
    if (validated.data.status && validated.data.status !== existingEvent.status) {
      notifyEventAdmins(eventId, {
        type: "REGISTRATION",
        title: "Event Status Updated",
        message: `Event "${event.name}" is now ${validated.data.status}`,
        link: `/events/${eventId}`,
      }).catch((err) => apiLogger.error({ err, msg: "Failed to send event status notification" }));
    }

    return NextResponse.json(event);
  } catch (error) {
    apiLogger.error({ err: error, msg: "Error updating event" });
    return NextResponse.json(
      { error: "Failed to update event" },
      { status: 500 }
    );
  }
}

export async function DELETE(req: Request, { params }: RouteParams) {
  try {
    // Parallelize params and auth
    const [{ eventId }, session] = await Promise.all([params, auth()]);

    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const deniedDel = denyReviewer(session);
    if (deniedDel) return deniedDel;

    // Require explicit confirmation to prevent accidental deletion
    const { searchParams } = new URL(req.url);
    if (searchParams.get("confirm") !== "true") {
      return NextResponse.json(
        { error: "Deleting an event removes all registrations, speakers, sessions, abstracts, and accommodations. Pass ?confirm=true to proceed." },
        { status: 400 }
      );
    }

    // Verify event belongs to user's organization (select only needed fields)
    const existingEvent = await db.event.findFirst({
      where: buildEventAccessWhere(session.user, eventId),
      select: { id: true, name: true },
    });

    if (!existingEvent) {
      return NextResponse.json({ error: "Event not found" }, { status: 404 });
    }

    await db.event.delete({
      where: { id: eventId },
    });

    apiLogger.info({ msg: "Event deleted", eventId, name: existingEvent.name, userId: session.user.id });

    // Log the action (non-blocking for better response time)
    db.auditLog.create({
      data: {
        userId: session.user.id,
        action: "DELETE",
        entityType: "Event",
        entityId: eventId,
        changes: { name: existingEvent.name, ip: getClientIp(req) },
      },
    }).catch((err) => apiLogger.error({ err, msg: "Failed to create audit log" }));

    return NextResponse.json({ success: true });
  } catch (error) {
    apiLogger.error({ err: error, msg: "Error deleting event" });
    return NextResponse.json(
      { error: "Failed to delete event" },
      { status: 500 }
    );
  }
}
