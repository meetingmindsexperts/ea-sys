import { PaymentStatus, RegistrationStatus } from "@prisma/client";

// Prisma-generated enums are compile-time static objects — zero runtime cost,
// no DB calls. Everything in this module is derived at module load and cached.

// Dev + prod guard: if a new enum value lands in schema.prisma, the
// Record<Enum, ...> maps below will fail type-check. The DISPLAY_ORDER arrays
// are guarded at runtime so a silent omission cannot ship.
function assertCovers<T extends string>(order: readonly T[], all: readonly T[], name: string): void {
  if (order.length !== all.length || order.some((v) => !all.includes(v))) {
    const missing = all.filter((v) => !order.includes(v));
    throw new Error(
      `${name} display order out of sync with enum. Missing: ${missing.join(", ") || "(none)"}`,
    );
  }
}

// ── PaymentStatus ──────────────────────────────────────────────────────────

export const ALL_PAYMENT_STATUSES = Object.values(PaymentStatus);

export const PAYMENT_STATUS_LABELS: Record<PaymentStatus, string> = {
  UNASSIGNED: "Unassigned",
  UNPAID: "Unpaid",
  PENDING: "Pending",
  PAID: "Paid",
  COMPLIMENTARY: "Complimentary",
  INCLUSIVE: "Inclusive",
  REFUNDED: "Refunded",
  FAILED: "Failed",
};

export const PAYMENT_STATUS_COLORS: Record<PaymentStatus, string> = {
  UNASSIGNED: "bg-slate-100 text-slate-700",
  UNPAID: "bg-gray-100 text-gray-800",
  PENDING: "bg-yellow-100 text-yellow-800",
  PAID: "bg-green-100 text-green-800",
  COMPLIMENTARY: "bg-cyan-100 text-cyan-800",
  // Violet — distinct from COMPLIMENTARY cyan so report scanners can tell
  // sponsor-paid (INCLUSIVE) from no-charge-VIP (COMPLIMENTARY) at a glance.
  INCLUSIVE: "bg-violet-100 text-violet-800",
  REFUNDED: "bg-blue-100 text-blue-800",
  FAILED: "bg-red-100 text-red-800",
};

// Order used by full-status dropdowns (detail-sheet edit, list filter).
export const PAYMENT_STATUS_DISPLAY_ORDER: readonly PaymentStatus[] = [
  "UNASSIGNED",
  "UNPAID",
  "PENDING",
  "PAID",
  "COMPLIMENTARY",
  "INCLUSIVE",
  "REFUNDED",
  "FAILED",
];

// Admin-settable subset — Stripe-driven states (PENDING/REFUNDED/FAILED) are
// owned by the payment webhook and must not be set manually at creation time.
// INCLUSIVE is admin-settable (sponsor-paid registrations are created or
// flipped by an organizer, never by Stripe).
export const MANUAL_PAYMENT_STATUSES: readonly PaymentStatus[] = [
  "UNASSIGNED",
  "UNPAID",
  "PAID",
  "COMPLIMENTARY",
  "INCLUSIVE",
];

// Statuses that mean "no money chase needed" — used by bulk-email + reports
// to exclude legitimately-no-balance-due registrations from payment reminders.
export const NO_PAYMENT_DUE_STATUSES: readonly PaymentStatus[] = [
  "PAID",
  "COMPLIMENTARY",
  "INCLUSIVE",
  "REFUNDED",
];

export const MANUAL_PAYMENT_STATUS_HELPER_TEXT =
  "Stripe-driven statuses (Pending / Refunded / Failed) are set automatically by the payment webhook.";

// ── RegistrationStatus ─────────────────────────────────────────────────────

export const ALL_REGISTRATION_STATUSES = Object.values(RegistrationStatus);

export const REGISTRATION_STATUS_LABELS: Record<RegistrationStatus, string> = {
  PENDING: "Pending",
  CONFIRMED: "Confirmed",
  WAITLISTED: "Waitlisted",
  CANCELLED: "Cancelled",
  CHECKED_IN: "Checked In",
};

export const REGISTRATION_STATUS_COLORS: Record<RegistrationStatus, string> = {
  PENDING: "bg-yellow-100 text-yellow-800",
  CONFIRMED: "bg-green-100 text-green-800",
  CANCELLED: "bg-red-100 text-red-800",
  WAITLISTED: "bg-blue-100 text-blue-800",
  CHECKED_IN: "bg-purple-100 text-purple-800",
};

export const REGISTRATION_STATUS_DISPLAY_ORDER: readonly RegistrationStatus[] = [
  "PENDING",
  "CONFIRMED",
  "WAITLISTED",
  "CANCELLED",
  "CHECKED_IN",
];

assertCovers(PAYMENT_STATUS_DISPLAY_ORDER, ALL_PAYMENT_STATUSES, "PaymentStatus");
assertCovers(REGISTRATION_STATUS_DISPLAY_ORDER, ALL_REGISTRATION_STATUSES, "RegistrationStatus");

// Re-export enum values + types for convenience. `PaymentStatus.UNASSIGNED`
// (value access) is preferred over `"UNASSIGNED"` (string literal) when the
// target type is the enum — Prisma's generated type doesn't always widen
// the plain string literal correctly at assignment sites.
// ── Badge type ─────────────────────────────────────────────────────────────
//
// Not a Prisma enum: `Registration.badgeType` is free text, because the label
// on the card is whatever an event decides to print ("Faculty", "Chairman",
// "Industry Partner"). These are the presets the picker offers, not a closed
// set.

export const BADGE_TYPE_PRESETS: readonly string[] = [
  "Delegate",
  "Faculty",
  "Exhibitor",
  "Committee",
  "Chairman",
  "Co-Chairman",
];

/** Sentinel the Select carries when the value is not one of the presets. */
export const CUSTOM_BADGE_TYPE = "Custom";

/**
 * What the badge renderer prints when `badgeType` is null, so the picker shows
 * the same thing rather than an empty control that implies nothing prints.
 */
export const BADGE_TYPE_FALLBACK = "Delegate";

export interface BadgeTypeField {
  /** Value for the Select. A preset, or `CUSTOM_BADGE_TYPE`. */
  selectValue: string;
  /** Whether the free-text input should render at all. */
  isCustom: boolean;
  /** What that input shows. Empty unless `isCustom`. */
  customValue: string;
}

/**
 * Resolve how the Badge Type control should render.
 *
 * WHY THIS IS A FUNCTION AND NOT AN INLINE TERNARY. It used to be inline, and
 * it had a bug that read to the organiser as "the custom badge type is not
 * saving". The value saved fine; the control hid it. `isCustom` was derived in
 * VIEW mode too, so a saved "VIP Guest" made the Select carry the sentinel and
 * the trigger rendered the literal word "Custom..." — while the free-text
 * input holding the actual text was gated on `isEditing` and therefore did not
 * render. You typed a value, saved, dropped out of edit mode, and the field
 * showed a dropdown label with your text nowhere on screen.
 *
 * So: `customValue` is returned for BOTH modes and the caller renders the
 * input disabled rather than hidden, which is how the Select beside it already
 * behaves in view mode.
 *
 * `customOpen` is the one genuinely stateful bit — picking "Custom…" sets the
 * value to "", which is indistinguishable from "nothing set", so the caller
 * has to remember that the user chose it. It is honoured ONLY while editing,
 * so a stale flag can never make view mode claim a value it does not have.
 */
export function resolveBadgeTypeField(args: {
  stored: string | null | undefined;
  isEditing: boolean;
  customOpen: boolean;
}): BadgeTypeField {
  const value = args.stored ?? "";
  const isPreset = BADGE_TYPE_PRESETS.includes(value);
  const isCustom = (args.isEditing && args.customOpen) || (value !== "" && !isPreset);

  return {
    isCustom,
    selectValue: isCustom
      ? CUSTOM_BADGE_TYPE
      : isPreset
        ? value
        : BADGE_TYPE_FALLBACK,
    customValue: isCustom ? value : "",
  };
}

export { PaymentStatus, RegistrationStatus };
