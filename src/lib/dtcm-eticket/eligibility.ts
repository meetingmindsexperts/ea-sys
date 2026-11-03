/**
 * Whether a registration can have a DTCM ticket bought from DET, and the
 * customer DET will be sent (docs/DTCM_ETICKET_PLAN.md §5.1). ONE function,
 * used by the desk purchase now and by the bulk run's preflight and worker in
 * step 4, so the three can never disagree about who is eligible.
 *
 * Pure: no database, no DET. Client-safe.
 */
import { resolveCountryCode } from "@/lib/travel-grant/eligibility";
import { isMappingCurrent, readDtcmEventSettings, type DtcmSectionMapping } from "./sections";
import type { DetCustomerInput, DetEnvironment } from "./types";

export interface EligibilityEvent {
  requiresDtcmBarcode: boolean;
  dtcmPerformanceCode: string | null;
  settings: unknown;
}

export interface EligibilityRegistration {
  id: string;
  status: string;
  attendanceMode: string;
  dtcmBarcode: string | null;
  ticketTypeId: string | null;
  attendee: {
    title: string | null;
    firstName: string;
    lastName: string;
    email: string;
    phone: string | null;
    country: string | null;
  };
}

export type IneligibleReason =
  | "DTCM_OFF"
  | "CANCELLED"
  | "WAITLISTED"
  | "VIRTUAL"
  | "ALREADY_HAS_CODE"
  | "TYPE_NOT_MAPPED"
  | "MAPPING_STALE"
  | "MISSING_NAME"
  | "MISSING_EMAIL"
  | "MISSING_PHONE"
  | "MISSING_COUNTRY";

export type Eligibility =
  | { ok: true; mapping: DtcmSectionMapping; performanceCode: string; customer: DetCustomerInput }
  | { ok: false; reason: IneligibleReason; message: string };

const TITLE_LABEL: Record<string, string> = { DR: "Dr", MR: "Mr", MRS: "Mrs", MS: "Ms", PROF: "Prof" };

/** What a desk or a preflight tells the organiser to fix, per reason. */
export const INELIGIBLE_MESSAGES: Record<IneligibleReason, string> = {
  DTCM_OFF: "DTCM barcodes are not on for this event, or it has no DET performance code",
  CANCELLED: "The registration is cancelled",
  WAITLISTED: "The registration is on the waitlist",
  VIRTUAL: "Virtual attendees do not get a DTCM barcode",
  ALREADY_HAS_CODE: "The registration already has a DTCM barcode",
  TYPE_NOT_MAPPED: "The registration type has no DET section (Settings, Registration, DET sections)",
  MAPPING_STALE:
    "The DET sections were checked against another DET environment or performance code. Check them and save again (Settings, Registration)",
  MISSING_NAME: "The attendee has no first or last name",
  MISSING_EMAIL: "The attendee has no email address",
  MISSING_PHONE: "DET needs a phone number, and the attendee has none",
  MISSING_COUNTRY: "DET needs the attendee's country, and it is missing or not recognised",
};

const refuse = (reason: IneligibleReason): Eligibility => ({ ok: false, reason, message: INELIGIBLE_MESSAGES[reason] });

/**
 * `activeEnvironment` is the DET environment a purchase would use now. A
 * mapping checked in the other one names the other one's sections, so it is
 * refused as stale rather than used.
 */
export function dtcmEligibility(
  event: EligibilityEvent,
  registration: EligibilityRegistration,
  activeEnvironment: DetEnvironment,
): Eligibility {
  if (!event.requiresDtcmBarcode || !event.dtcmPerformanceCode) return refuse("DTCM_OFF");
  if (registration.status === "CANCELLED") return refuse("CANCELLED");
  // Not yet a place at the event, so not yet a ticket (review of step 4, M5).
  if (registration.status === "WAITLISTED") return refuse("WAITLISTED");
  if (registration.attendanceMode === "VIRTUAL") return refuse("VIRTUAL");
  if (registration.dtcmBarcode) return refuse("ALREADY_HAS_CODE");

  const stored = readDtcmEventSettings(event.settings);
  const mapping = registration.ticketTypeId ? stored.sections?.[registration.ticketTypeId] : undefined;
  if (!mapping) return refuse("TYPE_NOT_MAPPED");
  if (!isMappingCurrent(stored, activeEnvironment, event.dtcmPerformanceCode)) return refuse("MAPPING_STALE");

  const a = registration.attendee;
  const firstName = a.firstName.trim();
  const lastName = a.lastName.trim();
  if (!firstName || !lastName) return refuse("MISSING_NAME");
  const email = a.email.trim();
  if (!email) return refuse("MISSING_EMAIL");
  const phoneNumber = normalisePhone(a.phone);
  if (!phoneNumber) return refuse("MISSING_PHONE");
  const country = resolveCountryCode(a.country);
  if (!country) return refuse("MISSING_COUNTRY");

  return {
    ok: true,
    mapping,
    performanceCode: event.dtcmPerformanceCode,
    customer: {
      // DET's `eventsairid`: any string (UAT, Nov 3 2026). The registration id
      // ties DET's customer back to this row.
      externalId: registration.id,
      title: a.title ? (TITLE_LABEL[a.title] ?? null) : null,
      firstName,
      lastName,
      email,
      nationality: country,
      phoneNumber,
      // The attendee's country, as the Laravel barcode app sent it: EA-SYS
      // stores no separate dialling country for the phone.
      countryCode: country,
    },
  };
}

/** Digits with an optional leading +; spaces, dashes, dots and brackets dropped. Null when nothing usable is left. */
export function normalisePhone(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  const plus = trimmed.startsWith("+") ? "+" : "";
  const digits = trimmed.replace(/\D/g, "");
  return digits.length >= 6 ? `${plus}${digits}` : null;
}
