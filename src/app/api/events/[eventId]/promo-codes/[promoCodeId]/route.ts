import { NextResponse } from "next/server";
import { can } from "@/lib/permissions/can";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { requireOrgId } from "@/lib/require-org";
import { db, tenantTransaction } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { requirePermission } from "@/lib/permissions/require-permission";
import { runWithTenant } from "@/lib/tenant-context";
import { sponsorExistsOnEvent } from "@/lib/sponsors";
import { redactFinancialFields } from "@/lib/finance-visibility";
import { sponsorCoverError } from "@/lib/promo-sponsor-cover";

const updatePromoCodeSchema = z
  .object({
    code: z
      .string()
      .min(1)
      .max(50)
      .transform((v) => v.toUpperCase().trim())
      .optional(),
    description: z.string().max(2000).nullable().optional(),
    discountType: z.enum(["PERCENTAGE", "FIXED_AMOUNT"]).optional(),
    discountValue: z.number().min(0.01).optional(),
    currency: z.string().max(10).nullable().optional(),
    maxUses: z.number().int().min(1).nullable().optional(),
    maxUsesPerEmail: z.number().int().min(1).nullable().optional(),
    validFrom: z.string().datetime().nullable().optional(),
    validUntil: z.string().datetime().nullable().optional(),
    isActive: z.boolean().optional(),
    ticketTypeIds: z.array(z.string()).optional(),
    // Attribute the code to a sponsor, by `Sponsor.id` on this event.
    //
    // This is the half of sponsor attribution the create path had and the edit
    // path did not, which meant an organiser could attribute a code only at the
    // moment they made it: every code that already existed was unattributable.
    // Blank or whitespace clears it, matching how a form Select reports "no
    // selection"; omitting the key leaves the current sponsor alone.
    sponsorId: z.string().max(100).nullable().optional(),
    // The sponsor pays for every registration made with this code (Sep 29,
    // 2026). Checked against the code AS IT WILL BE after this edit, so
    // removing the sponsor or lowering the discount cannot leave it claiming
    // that the sponsor pays.
    sponsorCoversFee: z.boolean().optional(),
  })
  .refine(
    (d) => !d.discountType || d.discountType !== "PERCENTAGE" || !d.discountValue || d.discountValue <= 100,
    { message: "Percentage discount cannot exceed 100%" }
  );

interface RouteParams {
  params: Promise<{ eventId: string; promoCodeId: string }>;
}

export async function GET(req: Request, { params }: RouteParams) {
  try {
    const [{ eventId, promoCodeId }, session] = await Promise.all([
      params,
      auth(),
    ]);

    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    const orgGuard = requireOrgId(session, { route: "events/[eventId]/promo-codes/[promoCodeId]:GET" });
    if ("error" in orgGuard) return orgGuard.error;

    const gate = requirePermission(session, "promo.read", { route: "events/[eventId]/promo-codes/[promoCodeId]:GET", eventId, onMissing: "hide" });
    if (!gate.ok) return gate.response;

    // Resolve the event through the role's own scope, exactly as the list
    // route beside this one does, before exposing the promo code and its
    // redemption PII. It was org-bound only until Oct 1, 2026, which the route
    // status matrix caught: ONSITE reached unassigned events, WEBINARS
    // conferences, and CRM_USER and HR_USER (confined to their modules) any
    // event, each seeing attendee names and emails given a promo code id.
    const event = await db.event.findFirst({
      where: gate.eventWhere,
      select: { id: true },
    });
    if (!event) {
      apiLogger.warn({ msg: "events/promo-codes:detail-event-not-found", eventId, role: session.user.role, userId: session.user.id });
      return NextResponse.json({ error: "Event not found" }, { status: 404 });
    }

    return await runWithTenant(orgGuard.orgId, async () => {
    const promoCode = await db.promoCode.findFirst({
      where: { id: promoCodeId, eventId },
      include: {
        ticketTypes: {
          include: { ticketType: { select: { id: true, name: true } } },
        },
        redemptions: {
          orderBy: { createdAt: "desc" },
          take: 50,
          select: {
            id: true,
            email: true,
            originalPrice: true,
            discountAmount: true,
            finalPrice: true,
            createdAt: true,
            registration: {
              select: {
                id: true,
                attendee: { select: { firstName: true, lastName: true } },
              },
            },
          },
        },
        _count: { select: { redemptions: true } },
      },
    });

    if (!promoCode) {
      return NextResponse.json(
        { error: "Promo code not found" },
        { status: 404 }
      );
    }

    // Redact for non-finance roles, matching the list sibling. Without this the
    // detail route hands back `discountValue`, `sponsorId` and every
    // redemption's prices to a role the list deliberately hides them from, and
    // a field readable one route over is not hidden at all.
    return NextResponse.json(
      can(gate.principal, "finance.view") ? promoCode : redactFinancialFields(promoCode),
    );
    });
  } catch (error) {
    apiLogger.error({ error, msg: "Failed to get promo code" });
    return NextResponse.json(
      { error: "Failed to get promo code" },
      { status: 500 }
    );
  }
}

export async function PUT(req: Request, { params }: RouteParams) {
  try {
    const [{ eventId, promoCodeId }, session, body] = await Promise.all([
      params,
      auth(),
      req.json(),
    ]);

    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    const orgGuard = requireOrgId(session, { route: "events/[eventId]/promo-codes/[promoCodeId]:PUT" });
    if ("error" in orgGuard) return orgGuard.error;

    const gate = requirePermission(session, "promo.write", { route: "events/[eventId]/promo-codes/[promoCodeId]:PUT", eventId });
    if (!gate.ok) return gate.response;

    const parsed = updatePromoCodeSchema.safeParse(body);
    if (!parsed.success) {
      apiLogger.warn({ msg: "events/promo-codes:invalid-input", errors: parsed.error.flatten() });
      return NextResponse.json(
        { error: "Validation failed", details: parsed.error.flatten() },
        { status: 400 }
      );
    }

    // Tenancy sweep (B1 fix): wrap opens BEFORE the swept promoCode read.
    return await runWithTenant(orgGuard.orgId, async () => {
    const [event, existing] = await Promise.all([
      db.event.findFirst({
        where: gate.eventWhere,
        select: { id: true },
      }),
      db.promoCode.findFirst({
        where: { id: promoCodeId, eventId },
        select: { id: true, sponsorId: true, sponsorCoversFee: true, discountType: true, discountValue: true, maxUses: true },
      }),
    ]);

    if (!event) {
      return NextResponse.json({ error: "Event not found" }, { status: 404 });
    }
    if (!existing) {
      return NextResponse.json(
        { error: "Promo code not found" },
        { status: 404 }
      );
    }

    const { ticketTypeIds, ...data } = parsed.data;

    // Normalise before validating: "" and "   " both mean "no sponsor", and
    // since phase 2 put a foreign key on this column an empty string is a
    // constraint violation rather than a harmless blank, so it has to be
    // turned into NULL here or it surfaces as an opaque 500.
    const sponsorIdProvided = data.sponsorId !== undefined;
    const sponsorId = sponsorIdProvided ? (data.sponsorId?.trim() || null) : undefined;

    // Checked rather than left to the FK for the same reason the create path
    // checks it: the FK refuses a bad id as a Prisma error the caller has to
    // interpret, where this names the fix.
    if (sponsorId && !(await sponsorExistsOnEvent(eventId, sponsorId))) {
      apiLogger.warn({
        msg: "events/promo-codes:sponsor-not-found",
        eventId,
        promoCodeId,
        userId: session.user.id,
      });
      return NextResponse.json(
        {
          error:
            "sponsorId does not match any sponsor on this event. Add the sponsor on the event's Sponsors page first, then reference its id.",
          code: "SPONSOR_NOT_FOUND",
        },
        { status: 400 },
      );
    }

    const coverError = sponsorCoverError({
      sponsorCoversFee: data.sponsorCoversFee ?? existing.sponsorCoversFee,
      sponsorId: sponsorId !== undefined ? sponsorId : existing.sponsorId,
      discountType: data.discountType ?? existing.discountType,
      discountValue: data.discountValue ?? Number(existing.discountValue),
      // `null` in the body clears the cap, so only an absent key keeps it.
      maxUses: data.maxUses !== undefined ? data.maxUses : existing.maxUses,
    });
    if (coverError) {
      apiLogger.warn({
        msg: "events/promo-codes:invalid-sponsor-cover",
        eventId,
        promoCodeId,
        userId: session.user.id,
        detail: coverError,
      });
      return NextResponse.json({ error: coverError, code: "INVALID_SPONSOR_COVER" }, { status: 400 });
    }

    // Check for duplicate code if code is being changed
    if (data.code) {
      const duplicate = await db.promoCode.findFirst({
        where: { eventId, code: data.code, id: { not: promoCodeId } },
        select: { id: true },
      });
      if (duplicate) {
        return NextResponse.json(
          { error: "A promo code with this code already exists" },
          { status: 409 }
        );
      }
    }

    const promoCode = await tenantTransaction(async (tx) => {
      // Update ticket type associations if provided
      if (ticketTypeIds !== undefined) {
        await tx.promoCodeTicketType.deleteMany({
          where: { promoCodeId },
        });
        if (ticketTypeIds.length > 0) {
          await tx.promoCodeTicketType.createMany({
            data: ticketTypeIds.map((ticketTypeId) => ({
              promoCodeId,
              ticketTypeId,
              organizationId: orgGuard.orgId,
            })),
          });
        }
      }

      return tx.promoCode.update({
        where: { id: promoCodeId },
        data: {
          ...(data.code !== undefined && { code: data.code }),
          ...(data.description !== undefined && { description: data.description }),
          ...(data.discountType !== undefined && { discountType: data.discountType }),
          ...(data.discountValue !== undefined && { discountValue: data.discountValue }),
          ...(data.currency !== undefined && { currency: data.currency }),
          ...(data.maxUses !== undefined && { maxUses: data.maxUses }),
          ...(data.maxUsesPerEmail !== undefined && { maxUsesPerEmail: data.maxUsesPerEmail }),
          ...(data.validFrom !== undefined && { validFrom: data.validFrom ? new Date(data.validFrom) : null }),
          ...(data.validUntil !== undefined && { validUntil: data.validUntil ? new Date(data.validUntil) : null }),
          ...(data.isActive !== undefined && { isActive: data.isActive }),
          ...(sponsorId !== undefined && { sponsorId }),
          ...(data.sponsorCoversFee !== undefined && { sponsorCoversFee: data.sponsorCoversFee }),
        },
        include: {
          ticketTypes: {
            include: { ticketType: { select: { id: true, name: true } } },
          },
          _count: { select: { redemptions: true } },
        },
      });
    });

    db.auditLog
      .create({
        data: {
          eventId,
          userId: session.user.id,
          action: "UPDATE_PROMO_CODE",
          entityType: "PromoCode",
          entityId: promoCode.id,
          changes: {
            code: promoCode.code,
            // Recorded explicitly: attribution decides whose report a
            // registration lands in, so "who changed it and when" has to be
            // answerable from the trail rather than inferred from the row.
            ...(sponsorId !== undefined && { sponsorId }),
          },
        },
      })
      .catch((err) => apiLogger.error({ err, msg: "Audit log failed" }));

    return NextResponse.json(promoCode);
    });
  } catch (error) {
    apiLogger.error({ error, msg: "Failed to update promo code" });
    return NextResponse.json(
      { error: "Failed to update promo code" },
      { status: 500 }
    );
  }
}

export async function DELETE(req: Request, { params }: RouteParams) {
  try {
    const [{ eventId, promoCodeId }, session] = await Promise.all([
      params,
      auth(),
    ]);

    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    const orgGuard = requireOrgId(session, { route: "events/[eventId]/promo-codes/[promoCodeId]:DELETE" });
    if ("error" in orgGuard) return orgGuard.error;

    const gate = requirePermission(session, "promo.delete", { route: "events/[eventId]/promo-codes/[promoCodeId]:DELETE", eventId });
    if (!gate.ok) return gate.response;

    // Tenancy sweep (B1 fix): wrap opens BEFORE the swept promoCode read.
    return await runWithTenant(orgGuard.orgId, async () => {
    const [event, promoCode] = await Promise.all([
      db.event.findFirst({
        where: gate.eventWhere,
        select: { id: true },
      }),
      db.promoCode.findFirst({
        where: { id: promoCodeId, eventId },
        select: { id: true, code: true, _count: { select: { redemptions: true } } },
      }),
    ]);

    if (!event) {
      return NextResponse.json({ error: "Event not found" }, { status: 404 });
    }
    if (!promoCode) {
      return NextResponse.json(
        { error: "Promo code not found" },
        { status: 404 }
      );
    }

    // If code has been used, soft-delete (deactivate). Otherwise hard-delete.
    if (promoCode._count.redemptions > 0) {
      await db.promoCode.update({
        where: { id: promoCodeId },
        data: { isActive: false },
      });
    } else {
      await db.promoCode.delete({ where: { id: promoCodeId } });
    }

    db.auditLog
      .create({
        data: {
          eventId,
          userId: session.user.id,
          action: "DELETE_PROMO_CODE",
          entityType: "PromoCode",
          entityId: promoCodeId,
          changes: { code: promoCode.code },
        },
      })
      .catch((err) => apiLogger.error({ err, msg: "Audit log failed" }));

    return NextResponse.json({ success: true });
    });
  } catch (error) {
    apiLogger.error({ error, msg: "Failed to delete promo code" });
    return NextResponse.json(
      { error: "Failed to delete promo code" },
      { status: 500 }
    );
  }
}
