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
