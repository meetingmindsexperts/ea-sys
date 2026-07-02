/**
 * Pure mappers between the registration detail-sheet's edit-form state
 * and a Registration row / the PUT request body.
 *
 * Why extracted: the same shape appeared THREE times inside the sheet —
 * the initial useState defaults, the `startEditing()` populate that
 * mirrors a Registration into the form, and the inverse mapping in
 * `saveEdits()` that assembles the server payload (with `.trim() ||
 * null` repeated for every billing field + a subtle null-vs-undefined
 * split between attendee and billing fields). Extracting them as pure
 * functions:
 *   1. lets us unit-test the field-by-field translation in isolation,
 *   2. removes ~80 lines of repetition from the 2k-line sheet,
 *   3. documents the normalization decisions in ONE place so the next
 *      audit doesn't have to re-discover them.
 *
 * NORMALIZATION DECISIONS (preserved exactly from the prior inline
 * implementation — this extraction must not change behavior):
 *   - Billing / tax / payer text fields → `.trim() || null` on save.
 *     Server treats null as "clear this column".
 *   - Attendee text fields → `... || undefined` on save (NOT null) so
 *     the PUT route's conditional spread sees the field as absent
 *     ("don't touch") rather than as a deliberate clear.
 *   - association / memberId / studentId / studentIdExpiry → explicit
 *     null on empty so the PUT route CAN clear them.
 *   - photo → `?? null` (uploading writes a URL; clearing sends null).
 *   - Payer triplet (billingAccountId / payerReference /
 *     attendeeIsGuarantor): when `billingAccountId === ""` we force
 *     payerReference = null and attendeeIsGuarantor = false, so
 *     reverting to self-pay atomically clears the related fields.
 *   - `expectedUpdatedAt` is the optimistic-lock token (W2-F8) the
 *     route uses to return 409 STALE_WRITE on concurrent edits.
 */

import type { Registration } from "./types";

export interface RegistrationEditData {
  title: string;
  /** AttendeeRole profession category ("" = unset). */
  role: string;
  firstName: string;
  lastName: string;
  /**
   * Secondary inbox typed by the registrant during public signup,
   * editable from the detail sheet so admins can correct typos. Empty
   * string clears the column to null on save (matches the ID/member
   * fields' explicit-clear convention, not the "leave untouched"
   * undefined convention used for plain attendee text fields).
   */
  additionalEmail: string;
  phone: string;
  organization: string;
  jobTitle: string;
  photo: string | null;
  city: string;
  country: string;
  bio: string;
  specialty: string;
  tags: string[];
  dietaryReqs: string;
  notes: string;
  associationName: string;
  memberId: string;
  studentId: string;
  studentIdExpiry: string;
  dtcmBarcode: string;
  // Billing block
  taxNumber: string;
  billingFirstName: string;
  billingLastName: string;
  billingEmail: string;
  billingPhone: string;
  billingAddress: string;
  billingCity: string;
  billingState: string;
  billingZipCode: string;
  billingCountry: string;
  // "Charge to another account" — "" = self-pay.
  billingAccountId: string;
  payerReference: string;
  attendeeIsGuarantor: boolean;
}

/**
 * Blank defaults used as the initial useState value, so every input is
 * controlled from mount.
 */
export const EMPTY_REGISTRATION_EDIT_DATA: RegistrationEditData = {
  title: "",
  role: "",
  firstName: "",
  lastName: "",
  additionalEmail: "",
  phone: "",
  organization: "",
  jobTitle: "",
  photo: null,
  city: "",
  country: "",
  bio: "",
  specialty: "",
  tags: [],
  dietaryReqs: "",
  notes: "",
  associationName: "",
  memberId: "",
  studentId: "",
  studentIdExpiry: "",
  dtcmBarcode: "",
  taxNumber: "",
  billingFirstName: "",
  billingLastName: "",
  billingEmail: "",
  billingPhone: "",
  billingAddress: "",
  billingCity: "",
  billingState: "",
  billingZipCode: "",
  billingCountry: "",
  billingAccountId: "",
  payerReference: "",
  attendeeIsGuarantor: false,
};

/**
 * Populate the edit-form state from a Registration row. Coerces null
 * scalars to "" (so inputs stay controlled) and parses the ISO date
 * for `studentIdExpiry` into a yyyy-MM-dd string for the date input.
 */
export function toEditData(reg: Registration): RegistrationEditData {
  const att = reg.attendee;
  return {
    title: att.title || "",
    role: att.role || "",
    firstName: att.firstName,
    lastName: att.lastName,
    additionalEmail: att.additionalEmail || "",
    phone: att.phone || "",
    organization: att.organization || "",
    jobTitle: att.jobTitle || "",
    photo: att.photo || null,
    city: att.city || "",
    country: att.country || "",
    bio: att.bio || "",
    specialty: att.specialty || "",
    tags: att.tags || [],
    dietaryReqs: att.dietaryReqs || "",
    notes: reg.notes || "",
    associationName: att.associationName || "",
    memberId: att.memberId || "",
    studentId: att.studentId || "",
    studentIdExpiry: att.studentIdExpiry
      ? new Date(att.studentIdExpiry).toISOString().split("T")[0]
      : "",
    dtcmBarcode: reg.dtcmBarcode || "",
    taxNumber: reg.taxNumber || "",
    billingFirstName: reg.billingFirstName || "",
    billingLastName: reg.billingLastName || "",
    billingEmail: reg.billingEmail || "",
    billingPhone: reg.billingPhone || "",
    billingAddress: reg.billingAddress || "",
    billingCity: reg.billingCity || "",
    billingState: reg.billingState || "",
    billingZipCode: reg.billingZipCode || "",
    billingCountry: reg.billingCountry || "",
    billingAccountId: reg.billingAccountId || "",
    payerReference: reg.payerReference || "",
    attendeeIsGuarantor: reg.attendeeIsGuarantor ?? false,
  };
}

/**
 * Assemble the PUT body for `/api/events/[eventId]/registrations/[id]`.
 * See module-level header for the null-vs-undefined and payer-triplet
 * normalization decisions this function encodes.
 */
export function toServerPayload(
  d: RegistrationEditData,
  expectedUpdatedAt: string,
): Record<string, unknown> {
  return {
    expectedUpdatedAt,
    notes: d.notes || undefined,
    dtcmBarcode: d.dtcmBarcode.trim() || null,
    taxNumber: d.taxNumber.trim() || null,
    billingFirstName: d.billingFirstName.trim() || null,
    billingLastName: d.billingLastName.trim() || null,
    billingEmail: d.billingEmail.trim() || null,
    billingPhone: d.billingPhone.trim() || null,
    billingAddress: d.billingAddress.trim() || null,
    billingCity: d.billingCity.trim() || null,
    billingState: d.billingState.trim() || null,
    billingZipCode: d.billingZipCode.trim() || null,
    billingCountry: d.billingCountry.trim() || null,
    billingAccountId: d.billingAccountId || null,
    payerReference: d.billingAccountId
      ? d.payerReference.trim() || null
      : null,
    attendeeIsGuarantor: d.billingAccountId ? d.attendeeIsGuarantor : false,
    attendee: {
      title: d.title || undefined,
      role: d.role || undefined,
      firstName: d.firstName,
      lastName: d.lastName,
      // additionalEmail uses the explicit-clear convention (null on
      // empty, like associationName / memberId / studentId), not the
      // "leave untouched" undefined convention used for plain text
      // fields. Admins legitimately need to remove a typo'd secondary
      // inbox, which the undefined path would silently no-op.
      additionalEmail: d.additionalEmail.trim() || null,
      phone: d.phone || undefined,
      organization: d.organization || undefined,
      jobTitle: d.jobTitle || undefined,
      photo: d.photo ?? null,
      city: d.city || undefined,
      country: d.country || undefined,
      bio: d.bio || undefined,
      specialty: d.specialty || undefined,
      tags: d.tags,
      dietaryReqs: d.dietaryReqs || undefined,
      associationName: d.associationName || null,
      memberId: d.memberId || null,
      studentId: d.studentId || null,
      studentIdExpiry: d.studentIdExpiry || null,
    },
  };
}
