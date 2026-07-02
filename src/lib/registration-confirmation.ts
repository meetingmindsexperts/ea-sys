import type { Prisma } from "@prisma/client";
import type { RegistrationConfirmationParams } from "@/lib/email";

/**
 * The event + organization/company + tax/bank/support block of a registration
 * confirmation email's params — the ~19 fields that are byte-identical across
 * every `sendRegistrationConfirmation` caller (public register, token-gated
 * complete-registration, registration-service, registrant resend). They're pure
 * event/org plumbing; the callers differ only in the accessor root.
 *
 * Deliberately EXCLUDES `eventSlug`: the public register route passes the route
 * param (which may be the event id, since it resolves `OR: [{slug},{id}]`),
 * while the other callers pass `event.slug`. Folding it in would silently change
 * register's behavior, so each caller keeps its own `eventSlug` line.
 *
 * Also excludes the price / discount / qrCode / attendanceMode / registrant /
 * billing fields — those genuinely diverge per caller (and are the
 * finance-sensitive part), so callers still pass them explicitly.
 */
export type EventConfirmationFields = Pick<
  RegistrationConfirmationParams,
  | "eventName"
  | "eventDate"
  | "eventVenue"
  | "eventCity"
  | "eventId"
  | "organizationId"
  | "taxRate"
  | "taxLabel"
  | "bankDetails"
  | "supportEmail"
  | "organizationName"
  | "companyName"
  | "companyAddress"
  | "companyCity"
  | "companyState"
  | "companyZipCode"
  | "companyCountry"
  | "taxId"
  | "logoPath"
>;

/**
 * Build the shared event/org confirmation-email fields from an event (with its
 * nested organization). Every mapping here is copied verbatim from what the four
 * call sites did inline — same transforms (`venue || ""`, `taxRate ? Number : null`,
 * `logo → logoPath`) — so adopting it is behavior-preserving.
 */
export function buildEventConfirmationFields(event: {
  name: string;
  startDate: Date;
  venue: string | null;
  city: string | null;
  id: string;
  organizationId: string;
  taxRate: Prisma.Decimal | null;
  taxLabel: string | null;
  bankDetails: string | null;
  supportEmail: string | null;
  organization: {
    name: string;
    companyName: string | null;
    companyAddress: string | null;
    companyCity: string | null;
    companyState: string | null;
    companyZipCode: string | null;
    companyCountry: string | null;
    taxId: string | null;
    logo: string | null;
  };
}): EventConfirmationFields {
  const org = event.organization;
  return {
    eventName: event.name,
    eventDate: event.startDate,
    eventVenue: event.venue || "",
    eventCity: event.city || "",
    eventId: event.id,
    organizationId: event.organizationId,
    taxRate: event.taxRate ? Number(event.taxRate) : null,
    taxLabel: event.taxLabel,
    bankDetails: event.bankDetails,
    supportEmail: event.supportEmail,
    organizationName: org.name,
    companyName: org.companyName,
    companyAddress: org.companyAddress,
    companyCity: org.companyCity,
    companyState: org.companyState,
    companyZipCode: org.companyZipCode,
    companyCountry: org.companyCountry,
    taxId: org.taxId,
    logoPath: org.logo,
  };
}
