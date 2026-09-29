/**
 * Shared registration views (Sep 29, 2026; docs/REGISTRATION_SHARE_PLAN.md):
 * the ONE place the rules live, for the organiser dialog, the save routes and
 * the public route. Pure and client-safe.
 *
 * The owner's "safe set" (ruling R2) is enforced by ABSENCE: amounts, payment
 * status, billing, invoices, documents, barcodes, notes, dietary, custom
 * fields, UTM and the linked account are not in this catalogue, so no view can
 * be configured to show them. Contact details are in it, off by default, and
 * selected from the database only when switched on.
 */
import { displayRegistrationType } from "@/lib/faculty-filter";
import { formatSerialId } from "@/lib/registration-serial";
import { formatPersonName } from "@/lib/utils";
import type { FieldGroup, ShareField } from "@/lib/submission-share";

export const REGISTRATION_SHARE_FIELDS: ShareField[] = [
  { key: "organization", label: "Organisation", group: "people", defaultOn: true },
  { key: "jobTitle", label: "Job title", group: "people", defaultOn: false },
  { key: "country", label: "Country", group: "people", defaultOn: true },
  { key: "specialty", label: "Specialty", group: "people", defaultOn: false },
  { key: "registrationType", label: "Registration type", group: "submission", defaultOn: true },
  { key: "attendanceMode", label: "In person or virtual", group: "submission", defaultOn: false },
  { key: "status", label: "Status", group: "submission", defaultOn: false },
  { key: "checkedIn", label: "Checked in", group: "submission", defaultOn: false },
  { key: "registeredAt", label: "Registered date", group: "submission", defaultOn: false },
  { key: "promoCode", label: "Promo code used", group: "submission", defaultOn: false },
  { key: "sponsor", label: "Sponsor", group: "submission", defaultOn: false },
  { key: "email", label: "Email", group: "contact", defaultOn: false },
  { key: "additionalEmail", label: "Additional email", group: "contact", defaultOn: false },
  { key: "phone", label: "Phone", group: "contact", defaultOn: false },
];

/** The dialog's group headings for this kind ("submission" reads as Registration here). */
export const REGISTRATION_GROUP_TITLE: Record<FieldGroup, string> = {
  people: "Person",
  submission: "Registration",
  contact: "Contact details",
};

export const REGISTRATION_SHARE_STATUSES: { value: string; label: string; defaultOn: boolean }[] = [
  { value: "CONFIRMED", label: "Confirmed", defaultOn: true },
  { value: "CHECKED_IN", label: "Checked in", defaultOn: true },
  { value: "PENDING", label: "Pending", defaultOn: false },
  { value: "WAITLISTED", label: "Waitlisted", defaultOn: false },
  { value: "CANCELLED", label: "Cancelled", defaultOn: false },
];

export const REGISTRATION_STATUS_LABEL: Record<string, string> = Object.fromEntries(
  REGISTRATION_SHARE_STATUSES.map((s) => [s.value, s.label]),
);

/** Plan §3.3: ample for the owner's "3 to 4 links". */
export const MAX_REGISTRATION_VIEWS = 10;
/** Plan §2: short rows, so a larger cap than the abstracts page. */
export const REGISTRATION_ROW_CAP = 5000;
export const LABEL_MAX = 60;

export interface RegistrationViewPreset {
  key: string;
  label: string;
  description: string;
  fields: string[];
}

/** Starting points matching the owner's three staff groups; everything stays editable. */
export const REGISTRATION_VIEW_PRESETS: RegistrationViewPreset[] = [
  { key: "names", label: "Names and numbers", description: "Headcounts and a name list.", fields: [] },
  {
    key: "companies",
    label: "Companies and promo codes",
    description: "Organisation, sponsor, promo code and type.",
    fields: ["organization", "registrationType", "promoCode", "sponsor"],
  },
  {
    key: "contacts",
    label: "Contact list",
    description: "Email, phone and country. Asks you to confirm.",
    fields: ["organization", "country", "email", "phone"],
  },
];

export function defaultRegistrationView(): { statuses: string[]; fields: string[] } {
  return {
    statuses: REGISTRATION_SHARE_STATUSES.filter((s) => s.defaultOn).map((s) => s.value),
    fields: REGISTRATION_SHARE_FIELDS.filter((f) => f.defaultOn).map((f) => f.key),
  };
}

export function registrationContactKeys(): string[] {
  return REGISTRATION_SHARE_FIELDS.filter((f) => f.group === "contact").map((f) => f.key);
}

/** Unknown statuses or fields are refused, not dropped (same rule as abstracts). */
export function validateRegistrationView(input: { statuses: string[]; fields: string[] }):
  | { ok: true; statuses: string[]; fields: string[] }
  | { ok: false; code: "UNKNOWN_STATUS" | "UNKNOWN_FIELD" | "NO_STATUS"; message: string } {
  const allowedStatuses = new Set(REGISTRATION_SHARE_STATUSES.map((s) => s.value));
  const allowedFields = new Set(REGISTRATION_SHARE_FIELDS.map((f) => f.key));
  const badStatus = input.statuses.find((s) => !allowedStatuses.has(s));
  if (badStatus) return { ok: false, code: "UNKNOWN_STATUS", message: `"${badStatus}" is not a registration status that can be shown.` };
  const badField = input.fields.find((f) => !allowedFields.has(f));
  if (badField) return { ok: false, code: "UNKNOWN_FIELD", message: `"${badField}" is not a field that can be shared.` };
  const statuses = [...new Set(input.statuses)];
  if (statuses.length === 0) return { ok: false, code: "NO_STATUS", message: "Choose at least one status to show." };
  return { ok: true, statuses, fields: [...new Set(input.fields)] };
}

/** Read-time re-filters, so a stored row can never widen what is shown. */
export function effectiveRegistrationStatuses(stored: string[]): string[] {
  const allowed = new Set(REGISTRATION_SHARE_STATUSES.map((s) => s.value));
  return stored.filter((s) => allowed.has(s));
}

export function effectiveRegistrationFields(stored: string[]): Set<string> {
  const allowed = new Set(REGISTRATION_SHARE_FIELDS.map((f) => f.key));
  return new Set(stored.filter((f) => allowed.has(f)));
}

/** Expired = has an expiry and it has passed. A link with no expiry never expires. */
export function isViewExpired(expiresAt: Date | string | null | undefined, now: Date = new Date()): boolean {
  if (!expiresAt) return false;
  return new Date(expiresAt).getTime() <= now.getTime();
}

// ── Projection ───────────────────────────────────────────────────────────────

export interface RegistrationShareRow {
  serialId: number | null;
  status: string;
  attendanceMode: string;
  checkedInAt: Date | null;
  createdAt: Date;
  ticketType: { name: string; isFaculty: boolean } | null;
  promoCode: { code: string; sponsor: { name: string } | null } | null;
  sponsor: { name: string } | null;
  // A group registration carries its promo code on the GROUP; each member's
  // own promoCode is null. Needed for both the promo code and the sponsor.
  group: { promoCode: { code: string; sponsor: { name: string } | null } | null } | null;
  attendee: {
    title: string | null;
    firstName: string;
    lastName: string;
    organization: string | null;
    jobTitle: string | null;
    country: string | null;
    specialty: string | null;
    customSpecialty: string | null;
    registrationType: string | null;
    // Present only when the route selected them (a contact field is on).
    email?: string | null;
    additionalEmail?: string | null;
    phone?: string | null;
  };
}

/** Every key but number and name is optional, written only when switched on. */
export interface SharedRegistration {
  number: string;
  name: string;
  organization?: string | null;
  jobTitle?: string | null;
  country?: string | null;
  specialty?: string | null;
  registrationType?: string;
  attendanceMode?: string;
  status?: string;
  checkedInAt?: string | null;
  registeredAt?: string;
  promoCode?: string | null;
  sponsor?: string | null;
  email?: string | null;
  additionalEmail?: string | null;
  phone?: string | null;
}

export function typeLabel(row: Pick<RegistrationShareRow, "ticketType" | "attendee">): string {
  return displayRegistrationType({
    ticketTypeName: row.ticketType?.name,
    isFaculty: row.ticketType?.isFaculty,
    attendeeRegistrationType: row.attendee.registrationType,
  });
}

export function projectRegistration(row: RegistrationShareRow, on: Set<string>): SharedRegistration {
  const a = row.attendee;
  const out: SharedRegistration = { number: formatSerialId(row.serialId), name: formatPersonName(a.title, a.firstName, a.lastName) };
  if (on.has("organization")) out.organization = a.organization;
  if (on.has("jobTitle")) out.jobTitle = a.jobTitle;
  if (on.has("country")) out.country = a.country;
  if (on.has("specialty")) out.specialty = a.customSpecialty || a.specialty;
  if (on.has("registrationType")) out.registrationType = typeLabel(row);
  if (on.has("attendanceMode")) out.attendanceMode = row.attendanceMode === "VIRTUAL" ? "Virtual" : "In person";
  if (on.has("status")) out.status = row.status;
  if (on.has("checkedIn")) out.checkedInAt = row.checkedInAt ? row.checkedInAt.toISOString() : null;
  if (on.has("registeredAt")) out.registeredAt = row.createdAt.toISOString();
  if (on.has("promoCode")) out.promoCode = row.promoCode?.code ?? row.group?.promoCode?.code ?? null;
  if (on.has("sponsor")) out.sponsor = attributedSponsor(row);
  if (on.has("email")) out.email = a.email ?? null;
  if (on.has("additionalEmail")) out.additionalEmail = a.additionalEmail ?? null;
  if (on.has("phone")) out.phone = a.phone ?? null;
  return out;
}

/**
 * The sponsor a registration is attributed to, by the same three routes as
 * the Registrations page's sponsor filter: tagged directly, the sponsor's
 * promo code, or a group that used that code.
 */
export function attributedSponsor(row: Pick<RegistrationShareRow, "sponsor" | "promoCode" | "group">): string | null {
  return row.sponsor?.name ?? row.promoCode?.sponsor?.name ?? row.group?.promoCode?.sponsor?.name ?? null;
}

/**
 * "Everyone these sponsors brought": the THREE-arm union. DUPLICATION: the
 * single-sponsor form is inline in api/events/[eventId]/registrations/route.ts,
 * where sponsor-attribution.test.ts pins its literal source; keep the arms in
 * step with it. A missing arm silently drops a sponsor's delegation.
 */
export function sponsorAttributionWhere(sponsorIds: string[]) {
  return {
    OR: [
      { sponsorId: { in: sponsorIds } },
      { promoCode: { sponsorId: { in: sponsorIds } } },
      { group: { promoCode: { sponsorId: { in: sponsorIds } } } },
    ],
  };
}

/** A promo code was used by the registration itself or by its group. */
export function promoCodeUseWhere(promoCodeIds: string[]) {
  return { OR: [{ promoCodeId: { in: promoCodeIds } }, { group: { promoCodeId: { in: promoCodeIds } } }] };
}

/** The attendee select; contact columns named ONLY when their field is on. */
export function attendeeSelect(on: Set<string>) {
  return {
    title: true,
    firstName: true,
    lastName: true,
    organization: true,
    jobTitle: true,
    country: true,
    specialty: true,
    customSpecialty: true,
    registrationType: true,
    ...(on.has("email") && { email: true }),
    ...(on.has("additionalEmail") && { additionalEmail: true }),
    ...(on.has("phone") && { phone: true }),
  } as const;
}

export interface RegistrationViewSummary {
  total: number;
  checkedIn: number;
  byType: { label: string; count: number }[];
  byStatus: { status: string; count: number }[];
}

/**
 * The counts strip, over every row the view can see (not only the page shown).
 * Aggregates only, so it is shown whatever fields are switched on.
 */
export function summarise(rows: Pick<RegistrationShareRow, "status" | "checkedInAt" | "ticketType" | "attendee">[]): RegistrationViewSummary {
  const byType = new Map<string, number>();
  const byStatus = new Map<string, number>();
  let checkedIn = 0;
  for (const r of rows) {
    const t = typeLabel(r);
    byType.set(t, (byType.get(t) ?? 0) + 1);
    byStatus.set(r.status, (byStatus.get(r.status) ?? 0) + 1);
    if (r.checkedInAt || r.status === "CHECKED_IN") checkedIn += 1;
  }
  return {
    total: rows.length,
    checkedIn,
    byType: [...byType].map(([label, count]) => ({ label, count })).sort((x, y) => y.count - x.count || x.label.localeCompare(y.label)),
    byStatus: REGISTRATION_SHARE_STATUSES.filter((s) => byStatus.has(s.value)).map((s) => ({ status: s.value, count: byStatus.get(s.value)! })),
  };
}
