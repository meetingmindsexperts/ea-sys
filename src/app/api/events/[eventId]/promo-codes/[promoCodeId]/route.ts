import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { requireOrgId } from "@/lib/require-org";
import { db, tenantTransaction } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { denyReviewer } from "@/lib/auth-guards";
import { runWithTenant } from "@/lib/tenant-context";
import { sponsorExistsOnEvent } from "@/lib/sponsors";
import { canViewFinance, redactFinancialFields } from "@/lib/finance-visibility";

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

    // Org-bind the event before exposing the promo code + its redemption PII
    // (mirrors the PUT/DELETE handlers). Without this, any authenticated user
    // could read another org's promo config + attendee names/emails/prices.
    const event = await db.event.findFirst({
      where: { id: eventId, organizationId: orgGuard.orgId },
      select: { id: true },
    });
    if (!event) {
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
      canViewFinance(session.user.role) ? promoCode : redactFinancialFields(promoCode),
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

    const denied = denyReviewer(session, { route: "events/[eventId]/promo-codes/[promoCodeId]:PUT" });
    if (denied) return denied;

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
        where: { id: eventId, organizationId: orgGuard.orgId },
        select: { id: true },
      }),
      db.promoCode.findFirst({
        where: { id: promoCodeId, eventId },
        select: { id: true },
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

    const denied = denyReviewer(session, { route: "events/[eventId]/promo-codes/[promoCodeId]:DELETE" });
    if (denied) return denied;

    // Tenancy sweep (B1 fix): wrap opens BEFORE the swept promoCode read.
    return await runWithTenant(orgGuard.orgId, async () => {
    const [event, promoCode] = await Promise.all([
      db.event.findFirst({
        where: { id: eventId, organizationId: orgGuard.orgId },
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
