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
  REFUNDED: "Refunded",
  FAILED: "Failed",
};

export const PAYMENT_STATUS_COLORS: Record<PaymentStatus, string> = {
  UNASSIGNED: "bg-slate-100 text-slate-700",
  UNPAID: "bg-gray-100 text-gray-800",
  PENDING: "bg-yellow-100 text-yellow-800",
  PAID: "bg-green-100 text-green-800",
  COMPLIMENTARY: "bg-cyan-100 text-cyan-800",
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
  "REFUNDED",
  "FAILED",
];

// Admin-settable subset — Stripe-driven states (PENDING/REFUNDED/FAILED) are
// owned by the payment webhook and must not be set manually at creation time.
export const MANUAL_PAYMENT_STATUSES: readonly PaymentStatus[] = [
  "UNASSIGNED",
  "UNPAID",
  "PAID",
  "COMPLIMENTARY",
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
export { PaymentStatus, RegistrationStatus };
