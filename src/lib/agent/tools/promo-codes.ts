import type { Tool } from "@anthropic-ai/sdk/resources/messages";
import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import type { ToolExecutor } from "./_shared";

const DISCOUNT_TYPES = new Set(["PERCENTAGE", "FIXED_AMOUNT"]);

const listPromoCodes: ToolExecutor = async (_input, ctx) => {
  try {
    const event = await db.event.findFirst({
      where: { id: ctx.eventId, organizationId: ctx.organizationId },
      select: { id: true },
    });
    if (!event) return { error: "Event not found or access denied" };

    const codes = await db.promoCode.findMany({
      where: { eventId: ctx.eventId },
      select: {
        id: true,
        code: true,
        description: true,
        discountType: true,
        discountValue: true,
        currency: true,
        maxUses: true,
        maxUsesPerEmail: true,
        usedCount: true,
        validFrom: true,
        validUntil: true,
        isActive: true,
        createdAt: true,
        ticketTypes: { select: { ticketTypeId: true } },
      },
      orderBy: { createdAt: "desc" },
    });

    return {
      promoCodes: codes.map((c) => ({
        ...c,
        ticketTypeIds: c.ticketTypes.map((t) => t.ticketTypeId),
      })),
      total: codes.length,
    };
  } catch (err) {
    apiLogger.error({ err }, "agent:list_promo_codes failed");
    return { error: "Failed to list promo codes" };
  }
};

const createPromoCode: ToolExecutor = async (input, ctx) => {
  try {
    const event = await db.event.findFirst({
      where: { id: ctx.eventId, organizationId: ctx.organizationId },
      select: { id: true },
    });
    if (!event) return { error: "Event not found or access denied" };

    const code = String(input.code ?? "").trim().toUpperCase();
    if (!code || code.length < 2 || code.length > 50) {
      return { error: "code is required (2-50 chars)" };
    }
    const discountType = String(input.discountType ?? "").trim();
    if (!DISCOUNT_TYPES.has(discountType)) {
      return { error: `discountType must be one of: ${[...DISCOUNT_TYPES].join(", ")}` };
    }
    const discountValue = Number(input.discountValue);
    if (isNaN(discountValue) || discountValue <= 0) {
      return { error: "discountValue must be a positive number" };
    }
    if (discountType === "PERCENTAGE" && discountValue > 100) {
      return { error: "PERCENTAGE discountValue must be <= 100" };
    }

    const existing = await db.promoCode.findFirst({
      where: { eventId: ctx.eventId, code },
      select: { id: true },
    });
    if (existing) return { error: `Promo code "${code}" already exists for this event` };

    const ticketTypeIds: string[] = Array.isArray(input.ticketTypeIds)
      ? (input.ticketTypeIds as unknown[]).map((t) => String(t))
      : [];
    if (ticketTypeIds.length > 0) {
      const valid = await db.ticketType.count({
        where: { id: { in: ticketTypeIds }, eventId: ctx.eventId },
      });
      if (valid !== ticketTypeIds.length) {
        return { error: "One or more ticketTypeIds not found in this event" };
      }
    }

    const promoCode = await db.promoCode.create({
      data: {
        eventId: ctx.eventId,
        code,
        description: input.description ? String(input.description).slice(0, 500) : null,
        discountType: discountType as never,
        discountValue,
        currency: input.currency ? String(input.currency).slice(0, 10) : null,
        maxUses: input.maxUses != null ? Math.max(1, Number(input.maxUses)) : null,
        maxUsesPerEmail: input.maxUsesPerEmail != null ? Math.max(1, Number(input.maxUsesPerEmail)) : 1,
        validFrom: input.validFrom ? new Date(String(input.validFrom)) : null,
        validUntil: input.validUntil ? new Date(String(input.validUntil)) : null,
        isActive: input.isActive != null ? Boolean(input.isActive) : true,
        ticketTypes: ticketTypeIds.length > 0
          ? { create: ticketTypeIds.map((tid) => ({ ticketTypeId: tid })) }
          : undefined,
      },
      select: {
        id: true,
        code: true,
        discountType: true,
        discountValue: true,
        isActive: true,
      },
    });

    return { success: true, promoCode };
  } catch (err) {
    apiLogger.error({ err }, "agent:create_promo_code failed");
    return { error: err instanceof Error ? err.message : "Failed to create promo code" };
  }
};

const updatePromoCode: ToolExecutor = async (input, ctx) => {
  try {
    const promoCodeId = String(input.promoCodeId ?? "").trim();
    if (!promoCodeId) return { error: "promoCodeId is required" };

    const existing = await db.promoCode.findFirst({
      where: { id: promoCodeId, event: { organizationId: ctx.organizationId } },
      select: { id: true, eventId: true },
    });
    if (!existing) return { error: `Promo code ${promoCodeId} not found or access denied` };

    const updates: Prisma.PromoCodeUpdateInput = {};
    if (input.description !== undefined) {
      updates.description = input.description == null ? null : String(input.description).slice(0, 500);
    }
    if (input.discountType != null) {
      const dt = String(input.discountType);
      if (!DISCOUNT_TYPES.has(dt)) {
        return { error: `discountType must be one of: ${[...DISCOUNT_TYPES].join(", ")}` };
      }
      updates.discountType = dt as never;
    }
    if (input.discountValue != null) {
      const dv = Number(input.discountValue);
      if (isNaN(dv) || dv <= 0) return { error: "discountValue must be positive" };
      updates.discountValue = dv;
    }
    if (input.maxUses !== undefined) {
      updates.maxUses = input.maxUses == null ? null : Math.max(1, Number(input.maxUses));
    }
    if (input.validFrom !== undefined) {
      updates.validFrom = input.validFrom == null ? null : new Date(String(input.validFrom));
    }
    if (input.validUntil !== undefined) {
      updates.validUntil = input.validUntil == null ? null : new Date(String(input.validUntil));
    }
    if (input.isActive != null) updates.isActive = Boolean(input.isActive);

    if (Object.keys(updates).length === 0) {
      return { error: "No fields provided to update" };
    }

    const updated = await db.promoCode.update({
      where: { id: promoCodeId },
      data: updates,
      select: {
        id: true,
        code: true,
        discountType: true,
        discountValue: true,
        isActive: true,
        usedCount: true,
      },
    });

    return { success: true, promoCode: updated };
  } catch (err) {
    apiLogger.error({ err }, "agent:update_promo_code failed");
    return { error: err instanceof Error ? err.message : "Failed to update promo code" };
  }
};

const deletePromoCode: ToolExecutor = async (input, ctx) => {
  try {
    const promoCodeId = String(input.promoCodeId ?? "").trim();
    if (!promoCodeId) return { error: "promoCodeId is required" };

    const existing = await db.promoCode.findFirst({
      where: { id: promoCodeId, event: { organizationId: ctx.organizationId } },
      select: { id: true, isActive: true, usedCount: true },
    });
    if (!existing) return { error: `Promo code ${promoCodeId} not found or access denied` };

    // Soft delete: flip isActive to false, preserve usage history
    const updated = await db.promoCode.update({
      where: { id: promoCodeId },
      data: { isActive: false },
      select: { id: true, code: true, isActive: true, usedCount: true },
    });

    return {
      success: true,
      promoCode: updated,
      note: "Promo code soft-deleted (isActive: false). Usage history preserved. To hard-delete, use the dashboard.",
    };
  } catch (err) {
    apiLogger.error({ err }, "agent:delete_promo_code failed");
    return { error: err instanceof Error ? err.message : "Failed to delete promo code" };
  }
};

export const PROMO_CODE_TOOL_DEFINITIONS: Tool[] = [];

export const PROMO_CODE_EXECUTORS: Record<string, ToolExecutor> = {
  list_promo_codes: listPromoCodes,
  create_promo_code: createPromoCode,
  update_promo_code: updatePromoCode,
  delete_promo_code: deletePromoCode,
};
