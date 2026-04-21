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
  createdAt: string;
  attendee: Attendee;
  ticketType: TicketType | null;
  pricingTier?: PricingTier | null;
  payments?: Payment[];
  accommodation?: Accommodation | null;
}

export { PAYMENT_STATUS_COLORS, REGISTRATION_STATUS_COLORS } from "./registration-enums";
