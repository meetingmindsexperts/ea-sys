import { PaymentStatus } from "@prisma/client";
import { db } from "@/lib/db";

/**
 * Shared "what does this ticket-type and/or pricing-tier change do to the
 * price?" resolver — the SINGLE source of truth for re-tier + type-change
 * repricing, used by BOTH the REST PUT (`/registrations/[id]`) and the MCP
 * `update_registration` tool so the two surfaces can't drift (they had: MCP
 * couldn't set a tier and never repriced on a type change).
 *
 * Given the existing registration + the requested `ticketTypeId` / `pricingTierId`,
 * it returns the tier to persist (`nextTierId`) and the `originalPrice` to
 * re-stamp (undefined = leave unchanged), or an errors-as-value rejection. It
 * does NOT validate that a NEW ticket type exists in the event — callers already
 * do that up front (for a clean 404 before any seat move) — but it DOES validate
 * a provided tier against the EFFECTIVE (possibly new) type.
 *
 * Rules (identical to the REST route the tests pin):
 *  - Setting a tier (an id, or null=base) reprices `originalPrice`. UNPAID-ONLY;
 *    blocked if a promo/discount is applied (re-stamping the base without
 *    recomputing the discount can over-discount).
 *  - When the type ALSO changes, the tier is validated against the NEW type.
 *  - A bare type change (no tier provided) on an unpaid reg reprices to the NEW
 *    type's base price (else the reg keeps the OLD type's price); the tier is
 *    nulled (tiers belong to a type). Paid regs are left untouched.
 */

export type RepricingResolution =
  | {
      ok: true;
      isChangingType: boolean;
      effectiveTypeId: string | null;
      /** Tier to persist: an id, `null` (base), or `undefined` (leave unchanged). */
      nextTierId: string | null | undefined;
      /** New originalPrice to stamp, or `undefined` to leave it unchanged. */
      originalPrice?: number;
    }
  | { ok: false; code: string; message: string; status: number };

const UNPAID_STATUSES: PaymentStatus[] = [
  PaymentStatus.UNASSIGNED,
  PaymentStatus.UNPAID,
  PaymentStatus.PENDING,
];

export async function resolveRepricing(input: {
  eventId: string;
  existing: {
    ticketTypeId: string | null;
    pricingTierId: string | null;
    paymentStatus: PaymentStatus;
    promoCodeId: string | null;
    discountAmount: unknown;
  };
  /** The requested new ticket type (caller has already validated it exists). */
  ticketTypeId?: string;
  /** Requested tier: an id, `null` (base), or `undefined` (not provided). */
  pricingTierId?: string | null;
}): Promise<RepricingResolution> {
  const { eventId, existing, ticketTypeId, pricingTierId } = input;

  const isChangingType = !!(ticketTypeId && ticketTypeId !== existing.ticketTypeId);
  const effectiveTypeId = ticketTypeId || existing.ticketTypeId;
  // (Re)setting the tier when it's provided (id or null=base) and it differs —
  // including the type-change case, where the old tier can't carry over.
  const isSettingTier =
    pricingTierId !== undefined &&
    (isChangingType || pricingTierId !== existing.pricingTierId);
  const unpaid = UNPAID_STATUSES.includes(existing.paymentStatus);

  // What to WRITE for pricingTierId: an id, null (base), or undefined = leave
  // unchanged (don't touch the column). For seat accounting the caller resolves
  // the effective next tier as `nextTierId ?? existing.pricingTierId` when it's
  // undefined.
  const nextTierId: string | null | undefined = isSettingTier
    ? pricingTierId ?? null
    : isChangingType
    ? null
    : undefined;

  let originalPrice: number | undefined;

  if (isSettingTier) {
    if (!unpaid) {
      const noBalance =
        existing.paymentStatus === PaymentStatus.COMPLIMENTARY ||
        existing.paymentStatus === PaymentStatus.INCLUSIVE;
      return {
        ok: false,
        code: "TIER_CHANGE_REQUIRES_UNPAID",
        status: 400,
        message: noBalance
          ? "This registration has no balance due (complimentary / sponsor-paid). Change its payment status before changing the price."
          : "The price (tier / type) can only be changed while the registration is unpaid. Refund the payment first.",
      };
    }
    if (existing.promoCodeId || Number(existing.discountAmount ?? 0) > 0) {
      return {
        ok: false,
        code: "TIER_CHANGE_HAS_DISCOUNT",
        status: 400,
        message:
          "Remove the applied promo code / discount before changing the tier or type, then re-apply it if needed.",
      };
    }
    if (pricingTierId === null) {
      // Base price of the effective (new or current) type.
      if (effectiveTypeId) {
        const baseTt = await db.ticketType.findFirst({
          where: { id: effectiveTypeId, eventId },
          select: { price: true },
        });
        originalPrice = baseTt ? Number(baseTt.price) : undefined;
      }
    } else {
      if (!effectiveTypeId) {
        return {
          ok: false,
          code: "NO_TICKET_TYPE",
          status: 400,
          message: "This registration has no ticket type, so it can't be assigned a pricing tier.",
        };
      }
      // Validate against the EFFECTIVE type — the new type when it's also changing.
      const tier = await db.pricingTier.findFirst({
        where: { id: pricingTierId, ticketTypeId: effectiveTypeId },
        select: { id: true, price: true },
      });
      if (!tier) {
        return {
          ok: false,
          code: "PRICING_TIER_NOT_FOUND",
          status: 404,
          message: "Pricing tier not found for the selected ticket type.",
        };
      }
      originalPrice = Number(tier.price);
    }
  } else if (isChangingType && unpaid && effectiveTypeId) {
    // M2: bare type change (no tier provided) on an unpaid reg reprices to the
    // NEW type's base — else it keeps the OLD type's price.
    const baseTt = await db.ticketType.findFirst({
      where: { id: effectiveTypeId, eventId },
      select: { price: true },
    });
    if (baseTt) originalPrice = Number(baseTt.price);
  }

  return { ok: true, isChangingType, effectiveTypeId, nextTierId, originalPrice };
}
