import { PaymentStatus, Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { readRegistrationBasePrice } from "@/lib/registration-financials";

/**
 * Promo-code application against an EXISTING registration.
 *
 * The register/checkout path already stores `Registration.discountAmount` +
 * `promoCodeId` and everything downstream (pay-later checkout amount, quote PDF,
 * invoice, computeRegistrationFinancials) reads it. This service is the missing
 * "apply/remove a promo to a registration that already exists" operation, shared
 * by the organizer dashboard and the registrant self-service portal.
 *
 * Rules (same for both callers — organizer does NOT bypass promo limits):
 *  - only OUTSTANDING (unpaid) registrations with a chargeable base price
 *  - active + within the validity window + applicable to the ticket type
 *  - maxUses (atomic increment guard) + maxUsesPerEmail (excluding this reg's own
 *    prior redemption so re-apply/replace doesn't count against itself)
 *  - replace-not-stack: applying a different code releases the current one first
 *  - all-or-nothing: a sentinel throw rolls back the whole transaction so a
 *    release can never commit without the replacement landing.
 */

export type PromoServiceSource = "rest" | "registrant" | "mcp" | "public";

const OUTSTANDING_PAYMENT_STATUSES: ReadonlySet<PaymentStatus> = new Set([
  PaymentStatus.UNASSIGNED,
  PaymentStatus.UNPAID,
  PaymentStatus.PENDING,
]);

export type ApplyPromoErrorCode =
  | "REGISTRATION_NOT_FOUND"
  | "ALREADY_SETTLED"
  | "FREE_REGISTRATION"
  | "INVALID_CODE"
  | "NOT_APPLICABLE"
  | "EXHAUSTED"
  | "EMAIL_LIMIT"
  | "UNKNOWN";

export interface PromoFinancials {
  code: string;
  originalPrice: number;
  discountAmount: number;
  finalPrice: number;
  currency: string;
}

export interface ApplyPromoInput {
  registrationId: string;
  /** Caller has already resolved + authorized this event scope. */
  eventId: string;
  code: string;
  source: PromoServiceSource;
}

export type ApplyPromoResult =
  | { ok: true; financials: PromoFinancials; replaced: boolean }
  | { ok: false; code: ApplyPromoErrorCode; message: string; meta?: Record<string, unknown> };

export type RemovePromoResult =
  | { ok: true; removed: boolean }
  | { ok: false; code: "REGISTRATION_NOT_FOUND" | "ALREADY_SETTLED" | "UNKNOWN"; message: string };

/** In-transaction sentinel so any failure rolls back release + increment writes. */
class PromoSentinel extends Error {
  constructor(
    public readonly errorCode: ApplyPromoErrorCode,
    public readonly reason: string,
    public readonly meta?: Record<string, unknown>,
  ) {
    super(reason);
    this.name = "PromoSentinel";
  }
}

/** Delete a registration's redemption row + decrement the promo's usedCount (guarded ≥0). */
async function releaseExistingRedemption(
  tx: Prisma.TransactionClient,
  registrationId: string,
  promoCodeId: string,
): Promise<void> {
  await tx.promoCodeRedemption.deleteMany({ where: { registrationId } });
  // Never drive usedCount below 0 (defensive against a prior manual edit).
  await tx.promoCode.updateMany({
    where: { id: promoCodeId, usedCount: { gt: 0 } },
    data: { usedCount: { decrement: 1 } },
  });
}

export async function applyPromoCodeToRegistration(input: ApplyPromoInput): Promise<ApplyPromoResult> {
  const code = input.code.toUpperCase().trim();
  if (!code) return { ok: false, code: "INVALID_CODE", message: "Invalid promo code" };

  try {
    const out = await db.$transaction(async (tx) => {
      const reg = await tx.registration.findFirst({
        where: { id: input.registrationId, eventId: input.eventId },
        include: {
          attendee: { select: { email: true } },
          ticketType: { select: { id: true, price: true, currency: true } },
          pricingTier: { select: { id: true, price: true, currency: true } },
        },
      });
      if (!reg) throw new PromoSentinel("REGISTRATION_NOT_FOUND", "Registration not found");
      if (!OUTSTANDING_PAYMENT_STATUSES.has(reg.paymentStatus)) {
        throw new PromoSentinel(
          "ALREADY_SETTLED",
          "A promo code can only be applied while payment is still outstanding.",
        );
      }

      const basePrice = readRegistrationBasePrice(reg);
      const currency = reg.pricingTier?.currency ?? reg.ticketType?.currency ?? "USD";
      if (basePrice <= 0) {
        throw new PromoSentinel("FREE_REGISTRATION", "This registration has no charge to discount.");
      }

      const email = reg.attendee.email.toLowerCase();

      const promo = await tx.promoCode.findUnique({
        where: { eventId_code: { eventId: input.eventId, code } },
        include: { ticketTypes: { select: { ticketTypeId: true } } },
      });
      if (!promo || !promo.isActive) throw new PromoSentinel("INVALID_CODE", "Invalid promo code");

      // Serialize concurrent applies of THIS promo code so the per-email
      // count→insert below can't race two applications past a maxUsesPerEmail
      // cap (two registrations sharing an email applying at the same instant —
      // e.g. the pay-later-then-re-register flow). A transaction-scoped row lock
      // (auto-released at commit; safe across the pgbouncer transaction pooler
      // since the whole $transaction runs on one backend). Scoped to this promo
      // row only, so different codes / events never block each other. Preferred
      // over a @@unique([promoCodeId, email]) constraint, which would break
      // maxUsesPerEmail > 1 and risk failing the migration on existing data.
      await tx.$queryRaw`SELECT id FROM "PromoCode" WHERE id = ${promo.id} FOR UPDATE`;

      const now = new Date();
      if (promo.validFrom && now < promo.validFrom) {
        throw new PromoSentinel("INVALID_CODE", "This promo code is not yet active.");
      }
      if (promo.validUntil && now > promo.validUntil) {
        throw new PromoSentinel("INVALID_CODE", "This promo code has expired.");
      }
      if (
        promo.ticketTypes.length > 0 &&
        !promo.ticketTypes.some((t) => t.ticketTypeId === reg.ticketTypeId)
      ) {
        throw new PromoSentinel("NOT_APPLICABLE", "This promo code is not valid for this registration type.");
      }

      const sameCodeAlreadyApplied = reg.promoCodeId === promo.id;

      // Per-email limit — exclude THIS registration's own prior redemption so a
      // re-apply / replace on the same row doesn't count against itself.
      if (promo.maxUsesPerEmail !== null) {
        const emailUses = await tx.promoCodeRedemption.count({
          where: { promoCodeId: promo.id, email, NOT: { registrationId: reg.id } },
        });
        if (emailUses >= promo.maxUsesPerEmail) {
          throw new PromoSentinel("EMAIL_LIMIT", "This promo code has already been used with this email.");
        }
      }

      // Defensive clamp (July-1 review LOW): bad admin/MCP data — a negative
      // discountValue or a percentage above 100 — must never produce a
      // negative discount (a surcharge) or a discount above the base price.
      // The write paths validate too; this is the last line of defense.
      const rawValue = Number(promo.discountValue);
      const discountAmount = Math.max(
        0,
        Math.round(
          (promo.discountType === "PERCENTAGE"
            ? (basePrice * Math.min(100, Math.max(0, rawValue))) / 100
            : Math.min(Math.max(0, rawValue), basePrice)) * 100,
        ) / 100,
      );
      const finalPrice = Math.max(0, Math.round((basePrice - discountAmount) * 100) / 100);

      // Each branch owns its own `replaced` value (July-1 review MED): deriving
      // it after the fact from the pre-apply snapshot was correct but fragile —
      // a future branch edit could silently desync the flag from what the
      // branch actually did.
      let replaced = false;
      if (sameCodeAlreadyApplied) {
        // Idempotent refresh — the base price may have changed (tier/type edit);
        // keep the same redemption + usedCount, just re-sync the numbers.
        await tx.registration.update({ where: { id: reg.id }, data: { discountAmount } });
        await tx.promoCodeRedemption.updateMany({
          where: { registrationId: reg.id },
          data: { promoCodeId: promo.id, email, originalPrice: basePrice, discountAmount, finalPrice },
        });
      } else {
        // Replace-not-stack: release any DIFFERENT existing promo first.
        if (reg.promoCodeId) {
          await releaseExistingRedemption(tx, reg.id, reg.promoCodeId);
          replaced = true;
        }
        // Atomic usedCount increment (maxUses guard — same pattern as soldCount).
        if (promo.maxUses !== null) {
          const bumped = await tx.promoCode.updateMany({
            where: { id: promo.id, usedCount: { lt: promo.maxUses } },
            data: { usedCount: { increment: 1 } },
          });
          if (bumped.count === 0) {
            throw new PromoSentinel("EXHAUSTED", "This promo code has reached its usage limit.");
          }
        } else {
          await tx.promoCode.update({
            where: { id: promo.id },
            data: { usedCount: { increment: 1 } },
          });
        }
        await tx.registration.update({
          where: { id: reg.id },
          data: { promoCodeId: promo.id, discountAmount },
        });
        // registrationId is @unique on the redemption; deleteMany above cleared
        // any prior row, so create is safe.
        await tx.promoCodeRedemption.create({
          data: {
            promoCodeId: promo.id,
            registrationId: reg.id,
            email,
            originalPrice: basePrice,
            discountAmount,
            finalPrice,
          },
        });
      }

      return {
        code: promo.code,
        replaced,
        financials: { code: promo.code, originalPrice: basePrice, discountAmount, finalPrice, currency },
      };
    });

    apiLogger.info({
      msg: "promo:applied",
      registrationId: input.registrationId,
      eventId: input.eventId,
      code: out.code,
      source: input.source,
      discountAmount: out.financials.discountAmount,
      replaced: out.replaced,
    });

    // Fire-and-forget audit — a log failure must not undo a committed application.
    db.auditLog
      .create({
        data: {
          eventId: input.eventId,
          action: "PROMO_APPLIED",
          entityType: "Registration",
          entityId: input.registrationId,
          changes: {
            source: input.source,
            code: out.code,
            originalPrice: out.financials.originalPrice,
            discountAmount: out.financials.discountAmount,
            finalPrice: out.financials.finalPrice,
            replaced: out.replaced,
          },
        },
      })
      .catch((err) => apiLogger.warn({ msg: "promo:apply-audit-failed", registrationId: input.registrationId, err }));

    return { ok: true, financials: out.financials, replaced: out.replaced };
  } catch (err) {
    if (err instanceof PromoSentinel) {
      apiLogger.warn({
        msg: "promo:apply-rejected",
        registrationId: input.registrationId,
        eventId: input.eventId,
        code: input.code,
        source: input.source,
        errorCode: err.errorCode,
      });
      return { ok: false, code: err.errorCode, message: err.reason, meta: err.meta };
    }
    apiLogger.error({ err, msg: "promo:apply-unknown", registrationId: input.registrationId });
    return { ok: false, code: "UNKNOWN", message: "Failed to apply promo code" };
  }
}

export async function removePromoCodeFromRegistration(input: {
  registrationId: string;
  eventId: string;
  source: PromoServiceSource;
}): Promise<RemovePromoResult> {
  try {
    const removed = await db.$transaction(async (tx) => {
      const reg = await tx.registration.findFirst({
        where: { id: input.registrationId, eventId: input.eventId },
        select: { id: true, status: true, paymentStatus: true, promoCodeId: true },
      });
      if (!reg) throw new PromoSentinel("REGISTRATION_NOT_FOUND", "Registration not found");
      if (!OUTSTANDING_PAYMENT_STATUSES.has(reg.paymentStatus)) {
        throw new PromoSentinel("ALREADY_SETTLED", "This registration is already settled.");
      }
      if (!reg.promoCodeId) return false; // nothing applied — idempotent success

      if (reg.status === "CANCELLED") {
        // The cancel transition already released usedCount (review H6) — a
        // second decrement here would double-release. Clear the redemption
        // artifacts only; reactivation then sees promoCodeId null and won't
        // re-claim.
        await tx.promoCodeRedemption.deleteMany({ where: { registrationId: reg.id } });
      } else {
        await releaseExistingRedemption(tx, reg.id, reg.promoCodeId);
      }
      await tx.registration.update({
        where: { id: reg.id },
        data: { promoCodeId: null, discountAmount: null },
      });
      return true;
    });

    if (removed) {
      apiLogger.info({ msg: "promo:removed", registrationId: input.registrationId, eventId: input.eventId, source: input.source });
      db.auditLog
        .create({
          data: {
            eventId: input.eventId,
            action: "PROMO_REMOVED",
            entityType: "Registration",
            entityId: input.registrationId,
            changes: { source: input.source },
          },
        })
        .catch((err) => apiLogger.warn({ msg: "promo:remove-audit-failed", registrationId: input.registrationId, err }));
    }

    return { ok: true, removed };
  } catch (err) {
    if (err instanceof PromoSentinel) {
      const code = err.errorCode === "ALREADY_SETTLED" ? "ALREADY_SETTLED" : "REGISTRATION_NOT_FOUND";
      apiLogger.warn({ msg: "promo:remove-rejected", registrationId: input.registrationId, errorCode: code });
      return { ok: false, code, message: err.reason };
    }
    apiLogger.error({ err, msg: "promo:remove-unknown", registrationId: input.registrationId });
    return { ok: false, code: "UNKNOWN", message: "Failed to remove promo code" };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Promo-code CREATION (duplication-audit finding 2, July 21, 2026).
//
// The REST POST /api/events/[eventId]/promo-codes and MCP `create_promo_code`
// used to mint codes with two separately-maintained inline implementations that
// had drifted: the MCP path wrote NO audit log (an agent-minted discount code
// was untracked), REST never validated ticketTypeIds belong to the event, and
// MCP never enforced FIXED_AMOUNT-requires-currency. This service is now the
// ONE create path; both callers delegate and keep only parsing + response
// shaping.
// ─────────────────────────────────────────────────────────────────────────────

export type CreatePromoCodeErrorCode =
  | "EVENT_NOT_FOUND"
  | "INVALID_CODE"
  | "INVALID_DISCOUNT"
  | "INVALID_TICKET_TYPES"
  | "DUPLICATE_CODE"
  | "UNKNOWN";

export interface CreatePromoCodeInput {
  eventId: string;
  organizationId: string;
  /** null for API-key MCP callers with no user context. */
  actorUserId: string | null;
  source: PromoServiceSource;
  code: string;
  description?: string | null;
  discountType: "PERCENTAGE" | "FIXED_AMOUNT";
  discountValue: number;
  currency?: string | null;
  maxUses?: number | null;
  maxUsesPerEmail?: number | null;
  validFrom?: Date | null;
  validUntil?: Date | null;
  isActive?: boolean;
  ticketTypeIds?: string[];
}

const PROMO_CREATE_INCLUDE = {
  ticketTypes: {
    include: { ticketType: { select: { id: true, name: true } } },
  },
  _count: { select: { redemptions: true } },
} satisfies Prisma.PromoCodeInclude;

export type CreatedPromoCode = Prisma.PromoCodeGetPayload<{ include: typeof PROMO_CREATE_INCLUDE }>;

export type CreatePromoCodeResult =
  | { ok: true; promoCode: CreatedPromoCode }
  | { ok: false; code: CreatePromoCodeErrorCode; message: string };

export async function createPromoCode(input: CreatePromoCodeInput): Promise<CreatePromoCodeResult> {
  try {
    const code = input.code.toUpperCase().trim();
    if (!code || code.length > 50) {
      return { ok: false, code: "INVALID_CODE", message: "code is required (1-50 chars)" };
    }
    if (!Number.isFinite(input.discountValue) || input.discountValue <= 0) {
      return { ok: false, code: "INVALID_DISCOUNT", message: "discountValue must be a positive number" };
    }
    if (input.discountType === "PERCENTAGE" && input.discountValue > 100) {
      return { ok: false, code: "INVALID_DISCOUNT", message: "Percentage discount cannot exceed 100%" };
    }
    if (input.discountType === "FIXED_AMOUNT" && !input.currency) {
      return { ok: false, code: "INVALID_DISCOUNT", message: "Currency is required for fixed amount discounts" };
    }

    const event = await db.event.findFirst({
      where: { id: input.eventId, organizationId: input.organizationId },
      select: { id: true },
    });
    if (!event) {
      return { ok: false, code: "EVENT_NOT_FOUND", message: "Event not found or access denied" };
    }

    const ticketTypeIds = input.ticketTypeIds ?? [];
    if (ticketTypeIds.length > 0) {
      // Applicability links must stay inside this event (the MCP path always
      // checked this; REST used to link foreign ticket types silently).
      const valid = await db.ticketType.count({
        where: { id: { in: ticketTypeIds }, eventId: input.eventId },
      });
      if (valid !== ticketTypeIds.length) {
        return { ok: false, code: "INVALID_TICKET_TYPES", message: "One or more ticketTypeIds not found in this event" };
      }
    }

    const existing = await db.promoCode.findUnique({
      where: { eventId_code: { eventId: input.eventId, code } },
      select: { id: true },
    });
    if (existing) {
      return { ok: false, code: "DUPLICATE_CODE", message: "A promo code with this code already exists" };
    }

    const promoCode = await db.promoCode.create({
      data: {
        eventId: input.eventId,
        code,
        description: input.description ?? null,
        discountType: input.discountType,
        discountValue: input.discountValue,
        currency: input.currency ?? null,
        maxUses: input.maxUses != null ? Math.max(1, input.maxUses) : null,
        maxUsesPerEmail: input.maxUsesPerEmail != null ? Math.max(1, input.maxUsesPerEmail) : 1,
        validFrom: input.validFrom ?? null,
        validUntil: input.validUntil ?? null,
        isActive: input.isActive ?? true,
        ...(ticketTypeIds.length > 0
          ? { ticketTypes: { create: ticketTypeIds.map((ticketTypeId) => ({ ticketTypeId })) } }
          : {}),
      },
      include: PROMO_CREATE_INCLUDE,
    });

    // Service-owned audit — this is exactly what the MCP path used to skip.
    db.auditLog
      .create({
        data: {
          eventId: input.eventId,
          userId: input.actorUserId,
          action: "CREATE_PROMO_CODE",
          entityType: "PromoCode",
          entityId: promoCode.id,
          changes: {
            source: input.source,
            code: promoCode.code,
            discountType: promoCode.discountType,
            discountValue: Number(promoCode.discountValue),
          },
        },
      })
      .catch((err) => apiLogger.warn({ msg: "promo:create-audit-failed", promoCodeId: promoCode.id, err }));

    apiLogger.info({
      msg: "promo:created",
      promoCodeId: promoCode.id,
      eventId: input.eventId,
      code: promoCode.code,
      source: input.source,
    });
    return { ok: true, promoCode };
  } catch (err) {
    // Race between the dup check and the create — the composite unique wins.
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      apiLogger.warn({ msg: "promo:create-duplicate-race", eventId: input.eventId });
      return { ok: false, code: "DUPLICATE_CODE", message: "A promo code with this code already exists" };
    }
    apiLogger.error({ err, msg: "promo:create-unknown", eventId: input.eventId });
    return { ok: false, code: "UNKNOWN", message: "Failed to create promo code" };
  }
}
