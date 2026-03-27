import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { denyReviewer } from "@/lib/auth-guards";
import { buildEventAccessWhere } from "@/lib/event-access";
import { getClientIp } from "@/lib/security";

const updateTicketTypeSchema = z.object({
  name: z.string().min(1).max(255).optional(),
  description: z.string().max(2000).optional(),
  isActive: z.boolean().optional(),
  sortOrder: z.number().int().optional(),
});

interface RouteParams {
  params: Promise<{ eventId: string; ticketId: string }>;
}

export async function GET(req: Request, { params }: RouteParams) {
  try {
    const [{ eventId, ticketId }, session] = await Promise.all([params, auth()]);

    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const [event, ticketType] = await Promise.all([
      db.event.findFirst({
        where: buildEventAccessWhere(session.user, eventId),
        select: { id: true },
      }),
      db.ticketType.findFirst({
        where: { id: ticketId, eventId },
        include: {
          pricingTiers: {
            orderBy: { sortOrder: "asc" },
            include: { _count: { select: { registrations: true } } },
          },
          _count: { select: { registrations: true } },
        },
      }),
    ]);

    if (!event) {
      return NextResponse.json({ error: "Event not found" }, { status: 404 });
    }

    if (!ticketType) {
      return NextResponse.json({ error: "Registration type not found" }, { status: 404 });
    }

    return NextResponse.json(ticketType);
  } catch (error) {
    apiLogger.error({ err: error, msg: "Error fetching registration type" });
    return NextResponse.json(
      { error: "Failed to fetch registration type" },
      { status: 500 }
    );
  }
}

export async function PUT(req: Request, { params }: RouteParams) {
  try {
    const [{ eventId, ticketId }, session, body] = await Promise.all([
      params,
      auth(),
      req.json(),
    ]);

    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const denied = denyReviewer(session);
    if (denied) return denied;

    const [event, existing] = await Promise.all([
      db.event.findFirst({
        where: { id: eventId, organizationId: session.user.organizationId! },
        select: { id: true },
      }),
      db.ticketType.findFirst({
        where: { id: ticketId, eventId },
      }),
    ]);

    if (!event) {
      return NextResponse.json({ error: "Event not found" }, { status: 404 });
    }

    if (!existing) {
      return NextResponse.json({ error: "Registration type not found" }, { status: 404 });
    }

    const validated = updateTicketTypeSchema.safeParse(body);
    if (!validated.success) {
      return NextResponse.json(
        { error: "Invalid input", details: validated.error.flatten() },
        { status: 400 }
      );
    }

    const data = validated.data;

    // Check uniqueness if name is changing
    if (data.name && data.name !== existing.name) {
      const dup = await db.ticketType.findFirst({
        where: { eventId, name: data.name, id: { not: ticketId } },
        select: { id: true },
      });
      if (dup) {
        return NextResponse.json(
          { error: `Registration type "${data.name}" already exists` },
          { status: 409 }
        );
      }
    }

    const ticketType = await db.ticketType.update({
      where: { id: ticketId },
      data: {
        ...(data.name && { name: data.name }),
        ...(data.description !== undefined && { description: data.description || null }),
        ...(data.isActive !== undefined && { isActive: data.isActive }),
        ...(data.sortOrder !== undefined && { sortOrder: data.sortOrder }),
      },
      include: {
        pricingTiers: {
          orderBy: { sortOrder: "asc" },
          include: { _count: { select: { registrations: true } } },
        },
        _count: { select: { registrations: true } },
      },
    });

    apiLogger.info({ msg: "Registration type updated", eventId, ticketTypeId: ticketId, userId: session.user.id, changes: data });

    await db.auditLog.create({
      data: {
        eventId,
        userId: session.user.id,
        action: "UPDATE",
        entityType: "TicketType",
        entityId: ticketType.id,
        changes: { before: existing, after: ticketType, ip: getClientIp(req) },
      },
    });

    return NextResponse.json(ticketType);
  } catch (error) {
    apiLogger.error({ err: error, msg: "Error updating registration type" });
    return NextResponse.json(
      { error: "Failed to update registration type" },
      { status: 500 }
    );
  }
}

export async function DELETE(req: Request, { params }: RouteParams) {
  try {
    const [{ eventId, ticketId }, session] = await Promise.all([params, auth()]);

    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const denied = denyReviewer(session);
    if (denied) return denied;

    const [event, ticketType] = await Promise.all([
      db.event.findFirst({
        where: { id: eventId, organizationId: session.user.organizationId! },
        select: { id: true },
      }),
      db.ticketType.findFirst({
        where: { id: ticketId, eventId },
        include: { _count: { select: { registrations: true } } },
      }),
    ]);

    if (!event) {
      return NextResponse.json({ error: "Event not found" }, { status: 404 });
    }

    if (!ticketType) {
      return NextResponse.json({ error: "Registration type not found" }, { status: 404 });
    }

    if (ticketType._count.registrations > 0) {
      return NextResponse.json(
        { error: "Cannot delete registration type with existing registrations" },
        { status: 400 }
      );
    }

    // Cascade deletes pricing tiers via schema
    await db.ticketType.delete({ where: { id: ticketId } });

    apiLogger.info({ msg: "Registration type deleted", eventId, ticketTypeId: ticketId, name: ticketType.name, userId: session.user.id });

    await db.auditLog.create({
      data: {
        eventId,
        userId: session.user.id,
        action: "DELETE",
        entityType: "TicketType",
        entityId: ticketId,
        changes: { deleted: ticketType, ip: getClientIp(req) },
      },
    });

    return NextResponse.json({ success: true });
  } catch (error) {
    apiLogger.error({ err: error, msg: "Error deleting registration type" });
    return NextResponse.json(
      { error: "Failed to delete registration type" },
      { status: 500 }
    );
  }
}
