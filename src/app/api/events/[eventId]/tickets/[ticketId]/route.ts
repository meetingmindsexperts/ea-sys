import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { requireOrgId } from "@/lib/require-org";
import { db, tenantTransaction } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { denyReviewer, WEBINAR_STAFF_ALLOW } from "@/lib/auth-guards";
import { buildEventAccessWhere } from "@/lib/event-access";
import { getClientIp } from "@/lib/security";
import { runWithTenant } from "@/lib/tenant-context";

const updateTicketTypeSchema = z.object({
  name: z.string().min(1).max(255).optional(),
  description: z.string().max(2000).optional(),
  isActive: z.boolean().optional(),
  // Type-level approval gate — editable so a tier-less type can toggle it.
  requiresApproval: z.boolean().optional(),
  sortOrder: z.number().int().optional(),
  // Seat limit — the hard ceiling for the whole type: public tier sign-ups,
  // staff adds and desk registrations all count against it; each tier's own
  // quantity is a sub-cap inside it (see registration-seat.ts).
  quantity: z.number().int().min(1).optional(),
  // Supporting-document policy (Aug 13, 2026). Two booleans, not one enum:
  // "ask but do not block" has to stay expressible. See
  // src/lib/supporting-document.ts.
  requiresDocument: z.boolean().optional(),
  requiresMemberId: z.boolean().optional(),
  requiresStudentId: z.boolean().optional(),
  requiresStudentIdExpiry: z.boolean().optional(),
  documentRequired: z.boolean().optional(),
  documentLabel: z.string().max(120).optional(),
  documentInstructions: z.string().max(2000).optional(),
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
    const orgGuard = requireOrgId(session, { route: "events/[eventId]/tickets/[ticketId]:GET" });
    if ("error" in orgGuard) return orgGuard.error;

    // Tenancy sweep (B1 fix): wrap opens BEFORE the swept ticketType read so it
    // rides the tenant store (a read outside the wrap fail-closes on platform).
    return await runWithTenant(orgGuard.orgId, async () => {
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
    });
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
    const orgGuard = requireOrgId(session, { route: "events/[eventId]/tickets/[ticketId]:PUT" });
    if ("error" in orgGuard) return orgGuard.error;

    const denied = denyReviewer(session, { allow: WEBINAR_STAFF_ALLOW, route: "events/[eventId]/tickets/[ticketId]:PUT" });
    if (denied) return denied;

    // Tenancy sweep (B1 fix): wrap opens BEFORE the swept ticketType read.
    return await runWithTenant(orgGuard.orgId, async () => {
    const [event, existing] = await Promise.all([
      db.event.findFirst({
        where: buildEventAccessWhere(session.user, eventId),
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
        apiLogger.warn({ msg: "events/tickets:zod-validation-failed", errors: validated.error.flatten() });
      return NextResponse.json(
        { error: "Invalid input", details: validated.error.flatten() },
        { status: 400 }
      );
    }

    const data = validated.data;

    // Setting a seat limit RE-COUNTS the seats held under this type from the
    // registration rows first, under a row lock so concurrent claims serialise
    // against it (the event-cap PUT does the same). The type's limit is the
    // ceiling over every tier plus staff adds (registration-seat.ts), so the
    // number it is compared against, and the counter the public form will
    // claim against from now on, must be the true total rather than whatever
    // the counter had drifted to. The limit can never drop below that total
    // (mirrors the pricing-tier PUT guard); to stop sales, deactivate the type.
    if (data.quantity !== undefined) {
      const requested = data.quantity;
      const recount = await tenantTransaction(async (tx) => {
        await tx.$queryRaw`SELECT "id" FROM "TicketType" WHERE "id" = ${ticketId} FOR UPDATE`;
        // Row-truth mirror of holdsSeat() + seatCounter(): not cancelled, in
        // person, not a speaker companion. The explicit OR keeps null
        // createdSource rows IN (Prisma `not` excludes nulls).
        const held = await tx.registration.count({
          where: {
            ticketTypeId: ticketId,
            status: { not: "CANCELLED" },
            attendanceMode: "IN_PERSON",
            OR: [{ createdSource: null }, { createdSource: { not: "SPEAKER_COMPANION" } }],
          },
        });
        if (requested < held) return { ok: false as const, held };
        await tx.ticketType.updateMany({ where: { id: ticketId, eventId }, data: { soldCount: held } });
        return { ok: true as const, held };
      });
      if (!recount.ok) {
        apiLogger.warn({
          msg: "events/tickets:quantity-below-sold-count",
          eventId,
          ticketTypeId: ticketId,
          requestedQuantity: requested,
          soldCount: recount.held,
          userId: session.user.id,
        });
        return NextResponse.json(
          { error: `Seat limit cannot be less than seats already sold (${recount.held})` },
          { status: 400 }
        );
      }
    }

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
      where: { id: ticketId, eventId },
      data: {
        ...(data.name && { name: data.name }),
        ...(data.description !== undefined && { description: data.description || null }),
        ...(data.isActive !== undefined && { isActive: data.isActive }),
        ...(data.requiresApproval !== undefined && { requiresApproval: data.requiresApproval }),
        ...(data.sortOrder !== undefined && { sortOrder: data.sortOrder }),
        ...(data.quantity !== undefined && { quantity: data.quantity }),
        ...(data.requiresDocument !== undefined && { requiresDocument: data.requiresDocument }),
        ...(data.requiresMemberId !== undefined && { requiresMemberId: data.requiresMemberId }),
        ...(data.requiresStudentId !== undefined && { requiresStudentId: data.requiresStudentId }),
        // Never store an expiry requirement without the ID it belongs
        // to. Reads the incoming student flag when present, else the
        // stored one, so a partial PATCH cannot create the bad pair.
        ...(data.requiresStudentIdExpiry !== undefined && {
          requiresStudentIdExpiry:
            (data.requiresStudentId ?? existing.requiresStudentId) && data.requiresStudentIdExpiry,
        }),
        ...(data.documentRequired !== undefined && { documentRequired: data.documentRequired }),
        // Empty string clears the organizer's text rather than storing "".
        ...(data.documentLabel !== undefined && { documentLabel: data.documentLabel.trim() || null }),
        ...(data.documentInstructions !== undefined && {
          documentInstructions: data.documentInstructions.trim() || null,
        }),
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
    });
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
    const orgGuard = requireOrgId(session, { route: "events/[eventId]/tickets/[ticketId]:DELETE" });
    if ("error" in orgGuard) return orgGuard.error;

    const denied = denyReviewer(session, { allow: WEBINAR_STAFF_ALLOW, route: "events/[eventId]/tickets/[ticketId]:DELETE" });
    if (denied) return denied;

    // Tenancy sweep (B1 fix): wrap opens BEFORE the swept ticketType read.
    return await runWithTenant(orgGuard.orgId, async () => {
    const [event, ticketType] = await Promise.all([
      db.event.findFirst({
        where: buildEventAccessWhere(session.user, eventId),
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
    await db.ticketType.delete({ where: { id: ticketId, eventId } });

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
    });
  } catch (error) {
    apiLogger.error({ err: error, msg: "Error deleting registration type" });
    return NextResponse.json(
      { error: "Failed to delete registration type" },
      { status: 500 }
    );
  }
}
