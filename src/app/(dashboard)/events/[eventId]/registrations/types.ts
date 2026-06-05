import type { PaymentStatus, RegistrationStatus } from "@prisma/client";

export interface Attendee {
  id: string;
  title: string | null;
  email: string;
  /**
   * Optional secondary inbox the registrant typed during public signup.
   * Auto-CC'd on every outgoing email about this registration via
   * `brandingCc()` in src/lib/email.ts. Admins can view + edit it from
   * the detail sheet.
   */
  additionalEmail: string | null;
  firstName: string;
  lastName: string;
  organization: string | null;
  jobTitle: string | null;
  phone: string | null;
  photo: string | null;
  city: string | null;
  state: string | null;
  zipCode: string | null;
  country: string | null;
  bio: string | null;
  specialty: string | null;
  registrationType: string | null;
  tags: string[];
  dietaryReqs: string | null;
  associationName: string | null;
  memberId: string | null;
  studentId: string | null;
  studentIdExpiry: string | null;
  customFields?: Record<string, unknown>;
}

export interface PricingTier {
  id: string;
  name: string;
  price: number;
  currency: string;
}

export interface TicketTypePricingTier {
  id: string;
  name: string;
  price: number;
  currency: string;
  isActive: boolean;
  salesStart?: string | null;
  salesEnd?: string | null;
  sortOrder: number;
}

export interface TicketType {
  id: string;
  name: string;
  price: number;
  currency: string;
  quantity: number;
  soldCount: number;
  // /api/events/[eventId]/tickets returns the active pricing tiers nested
  // under each ticket type so admin forms can render a tier picker without
  // a second fetch. Tiers are ordered by sortOrder + createdAt.
  pricingTiers?: TicketTypePricingTier[];
}

export interface Payment {
  id: string;
  amount: number;
  currency: string;
  status: string;
  createdAt: string;
  cardBrand?: string | null;
  cardLast4?: string | null;
  paymentMethodType?: string | null;
  paidAt?: string | null;
  // For manual payments (bank_transfer / card_onsite / cash) `receiptUrl`
  // is the URL of the organizer-uploaded proof artifact. For Stripe
  // payments it's Stripe's hosted receipt URL. Same column, two
  // semantics — context comes from `paymentMethodType`.
  receiptUrl?: string | null;
  // Additional reconciliation fields surfaced from `Payment.metadata`
  // when the payment was recorded manually (bank reference, cash
  // recipient, free-form notes). Stripe-driven payments have these
  // unset.
  metadata?: {
    method?: string;
    recordedManually?: boolean;
    bankReference?: string;
    cashReceivedBy?: string;
    notes?: string;
  } | null;
}

export interface Accommodation {
  id: string;
  checkIn: string;
  checkOut: string;
  status: string;
  roomType: {
    name: string;
    hotel: {
      name: string;
    };
  };
}

export interface Registration {
  id: string;
  /**
   * Linked User account id, set once the registrant signs up + completes
   * their own details. NULL when the row was created by an admin (CSV
   * import / dashboard / MCP / import-from-contacts) and the registrant
   * hasn't yet logged in. The "Send registration form" action is gated
   * on this — we only show it for unlinked rows.
   */
  userId: string | null;
  serialId: number | null;
  status: RegistrationStatus;
  paymentStatus: PaymentStatus;
  // Sponsor attribution — set when paymentStatus = INCLUSIVE. References
  // an entry in Event.settings.sponsors[].id (JSON, not a foreign-key
  // relation).
  sponsorId: string | null;
  qrCode: string | null;
  dtcmBarcode: string | null;
  badgeType: string | null;
  referrer: string | null;
  utmSource: string | null;
  utmMedium: string | null;
  utmCampaign: string | null;
  /**
   * Which entry path created this row (PUBLIC_REGISTER /
   * ADMIN_DASHBOARD / CSV_IMPORT / MCP_AGENT / ...). NULL on rows
   * that pre-date the column. Rendered in the Source / Tracking
   * section of the detail sheet.
   */
  createdSource: string | null;
  checkedInAt: string | null;
  notes: string | null;
  // Billing block — optional overrides of the attendee's personal address.
  // All null when the registrant left "billing same as personal" checked.
  taxNumber: string | null;
  billingFirstName: string | null;
  billingLastName: string | null;
  billingEmail: string | null;
  billingPhone: string | null;
  billingAddress: string | null;
  billingCity: string | null;
  billingState: string | null;
  billingZipCode: string | null;
  billingCountry: string | null;
  // "Charge to another account" — third-party payer. null = self-pay.
  // Orthogonal to paymentStatus (money still owed until the payer settles).
  billingAccountId: string | null;
  payerReference: string | null;
  attendeeIsGuarantor: boolean;
  billingAccount?: {
    id: string;
    name: string;
    type: string;
    email: string | null;
    taxNumber: string | null;
  } | null;
  createdAt: string;
  updatedAt: string;
  attendee: Attendee;
  ticketType: TicketType | null;
  pricingTier?: PricingTier | null;
  payments?: Payment[];
  accommodation?: Accommodation | null;
  // Computed money breakdown from the detail GET. Absent for the MEMBER
  // role (redacted server-side) — UI must treat it as optional.
  financials?: {
    currency: string;
    subtotal: number;
    discount: number;
    taxableBase: number;
    taxRate: number;
    taxLabel: string;
    taxAmount: number;
    total: number;
    totalPaid: number;
    balanceDue: number;
    isPaidInFull: boolean;
    hasOutstandingBalance: boolean;
  } | null;
}

/**
 * True when the registration has a billing block meaningfully different from
 * the attendee's personal info. Used to hide the Billing Details section on
 * the detail sheet when "billing same as personal" was left checked at signup
 * (all billing* fields either null or exact copies of attendee fields).
 * A non-empty taxNumber counts as "different" on its own — VAT number is
 * billing-only context with no personal equivalent.
 */
export function hasCustomBilling(r: Registration): boolean {
  if (r.taxNumber) return true;
  if (r.billingAddress) return true;
  const pairs: [string | null, string | null | undefined][] = [
    [r.billingFirstName, r.attendee.firstName],
    [r.billingLastName, r.attendee.lastName],
    [r.billingEmail, r.attendee.email],
    [r.billingPhone, r.attendee.phone],
    [r.billingCity, r.attendee.city],
    [r.billingState, r.attendee.state],
    [r.billingZipCode, r.attendee.zipCode],
    [r.billingCountry, r.attendee.country],
  ];
  return pairs.some(([billing, personal]) => {
    if (!billing) return false;
    return (billing || "").trim() !== (personal || "").trim();
  });
}

export { PAYMENT_STATUS_COLORS, REGISTRATION_STATUS_COLORS } from "./registration-enums";
