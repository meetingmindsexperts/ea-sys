import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { denyReviewer } from "@/lib/auth-guards";
import { apiLogger } from "@/lib/logger";

type RouteParams = { params: Promise<{ contactId: string }> };

const updateContactSchema = z.object({
  email: z.string().email().optional(),
  firstName: z.string().min(1).optional(),
  lastName: z.string().min(1).optional(),
  organization: z.string().optional().nullable(),
  jobTitle: z.string().optional().nullable(),
  phone: z.string().optional().nullable(),
  photo: z.string().url().optional().or(z.literal("")).nullable(),
  city: z.string().optional().nullable(),
  country: z.string().optional().nullable(),
  tags: z.array(z.string()).optional(),
  notes: z.string().optional().nullable(),
});

export async function GET(req: Request, { params }: RouteParams) {
  try {
    const [{ contactId }, session] = await Promise.all([params, auth()]);

    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const contact = await db.contact.findFirst({
      where: { id: contactId, organizationId: session.user.organizationId! },
    });

    if (!contact) {
      return NextResponse.json({ error: "Contact not found" }, { status: 404 });
    }

    // Derive event history from speakers and registrations by email
    const [speakers, registrations] = await Promise.all([
      db.speaker.findMany({
        where: {
          email: contact.email,
          event: { organizationId: session.user.organizationId! },
        },
        select: {
          id: true,
          status: true,
          createdAt: true,
          event: { select: { id: true, name: true, startDate: true } },
        },
        orderBy: { createdAt: "desc" },
      }),
      db.registration.findMany({
        where: {
          attendee: { email: contact.email },
          event: { organizationId: session.user.organizationId! },
        },
        select: {
          id: true,
          status: true,
          createdAt: true,
          event: { select: { id: true, name: true, startDate: true } },
          ticketType: { select: { name: true } },
        },
        orderBy: { createdAt: "desc" },
      }),
    ]);

    const eventHistory = [
      ...speakers.map((s) => ({
        eventId: s.event.id,
        eventName: s.event.name,
        eventDate: s.event.startDate,
        role: "Speaker" as const,
        status: s.status,
        recordId: s.id,
        createdAt: s.createdAt,
      })),
      ...registrations.map((r) => ({
        eventId: r.event.id,
        eventName: r.event.name,
        eventDate: r.event.startDate,
        role: "Attendee" as const,
        status: r.status,
        recordId: r.id,
        createdAt: r.createdAt,
      })),
    ].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());

    return NextResponse.json({ contact, eventHistory });
  } catch (error) {
    apiLogger.error({ err: error, msg: "Error fetching contact" });
    return NextResponse.json({ error: "Failed to fetch contact" }, { status: 500 });
  }
}

export async function PUT(req: Request, { params }: RouteParams) {
  try {
    const [{ contactId }, session, body] = await Promise.all([params, auth(), req.json()]);

    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const denied = denyReviewer(session);
    if (denied) return denied;

    const validated = updateContactSchema.safeParse(body);
    if (!validated.success) {
      return NextResponse.json(
        { error: "Invalid input", details: validated.error.flatten() },
        { status: 400 }
      );
    }

    const contact = await db.contact.findFirst({
      where: { id: contactId, organizationId: session.user.organizationId! },
      select: { id: true },
    });

    if (!contact) {
      return NextResponse.json({ error: "Contact not found" }, { status: 404 });
    }

    // Check email uniqueness if changing email
    if (validated.data.email) {
      const existing = await db.contact.findFirst({
        where: {
          organizationId: session.user.organizationId!,
          email: validated.data.email,
          id: { not: contactId },
        },
        select: { id: true },
      });
      if (existing) {
        return NextResponse.json(
          { error: "A contact with this email already exists" },
          { status: 409 }
        );
      }
    }

    const updated = await db.contact.update({
      where: { id: contactId },
      data: validated.data,
    });

    return NextResponse.json(updated);
  } catch (error) {
    apiLogger.error({ err: error, msg: "Error updating contact" });
    return NextResponse.json({ error: "Failed to update contact" }, { status: 500 });
  }
}

export async function DELETE(req: Request, { params }: RouteParams) {
  try {
    const [{ contactId }, session] = await Promise.all([params, auth()]);

    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const denied = denyReviewer(session);
    if (denied) return denied;

    const contact = await db.contact.findFirst({
      where: { id: contactId, organizationId: session.user.organizationId! },
      select: { id: true },
    });

    if (!contact) {
      return NextResponse.json({ error: "Contact not found" }, { status: 404 });
    }

    await db.contact.delete({ where: { id: contactId } });

    return NextResponse.json({ success: true });
  } catch (error) {
    apiLogger.error({ err: error, msg: "Error deleting contact" });
    return NextResponse.json({ error: "Failed to delete contact" }, { status: 500 });
  }
}
