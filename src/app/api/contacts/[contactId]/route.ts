import { NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { getOrgContext } from "@/lib/api-auth";
import { normalizeTag } from "@/lib/utils";
import { titleEnum } from "@/lib/schemas";

type RouteParams = { params: Promise<{ contactId: string }> };

const updateContactSchema = z.object({
  title: titleEnum.optional().nullable(),
  email: z.string().email().max(255).optional(),
  firstName: z.string().min(1).max(100).optional(),
  lastName: z.string().min(1).max(100).optional(),
  organization: z.string().max(255).optional().nullable(),
  jobTitle: z.string().max(255).optional().nullable(),
  specialty: z.string().max(255).optional().nullable(),
  registrationType: z.string().max(255).optional().nullable(),
  bio: z.string().max(5000).optional().nullable(),
  phone: z.string().max(50).optional().nullable(),
  photo: z.string().max(500).optional().or(z.literal("")).nullable(),
  city: z.string().max(255).optional().nullable(),
  country: z.string().max(255).optional().nullable(),
  tags: z.array(z.string().max(100).transform(normalizeTag)).optional(),
  notes: z.string().max(2000).optional().nullable(),
});

export async function GET(req: Request, { params }: RouteParams) {
  try {
    const [{ contactId }, ctx] = await Promise.all([params, getOrgContext(req)]);

    if (!ctx) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const contact = await db.contact.findFirst({
      where: { id: contactId, organizationId: ctx.organizationId },
    });

    if (!contact) {
      return NextResponse.json({ error: "Contact not found" }, { status: 404 });
    }

    // Derive event history from speakers and registrations by email
    const [speakers, registrations] = await Promise.all([
      db.speaker.findMany({
        where: {
          email: contact.email,
          event: { organizationId: ctx.organizationId },
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
          event: { organizationId: ctx.organizationId },
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
    const [{ contactId }, ctx, body] = await Promise.all([params, getOrgContext(req), req.json()]);

    if (!ctx) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    if (ctx.role === "REVIEWER" || ctx.role === "SUBMITTER") {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const validated = updateContactSchema.safeParse(body);
    if (!validated.success) {
      return NextResponse.json(
        { error: "Invalid input", details: validated.error.flatten() },
        { status: 400 }
      );
    }

    const contact = await db.contact.findFirst({
      where: { id: contactId, organizationId: ctx.organizationId },
      select: { id: true },
    });

    if (!contact) {
      return NextResponse.json({ error: "Contact not found" }, { status: 404 });
    }

    // Check email uniqueness if changing email
    if (validated.data.email) {
      const existing = await db.contact.findFirst({
        where: {
          organizationId: ctx.organizationId,
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
    const [{ contactId }, ctx] = await Promise.all([params, getOrgContext(req)]);

    if (!ctx) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    if (ctx.role === "REVIEWER" || ctx.role === "SUBMITTER") {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const contact = await db.contact.findFirst({
      where: { id: contactId, organizationId: ctx.organizationId },
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
