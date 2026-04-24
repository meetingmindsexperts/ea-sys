import type { PaymentStatus, RegistrationStatus } from "@prisma/client";

export interface Attendee {
  id: string;
  title: string | null;
  email: string;
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

export interface TicketType {
  id: string;
  name: string;
  price: number;
  currency: string;
  quantity: number;
  soldCount: number;
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
  serialId: number | null;
  status: RegistrationStatus;
  paymentStatus: PaymentStatus;
  qrCode: string | null;
  dtcmBarcode: string | null;
  badgeType: string | null;
  referrer: string | null;
  utmSource: string | null;
  utmMedium: string | null;
  utmCampaign: string | null;
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
  createdAt: string;
  attendee: Attendee;
  ticketType: TicketType | null;
  pricingTier?: PricingTier | null;
  payments?: Payment[];
  accommodation?: Accommodation | null;
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
