/**
 * Submitter profile completeness (Aug 4, 2026) — client-safe, pure.
 *
 * A submitter whose Speaker row was minted via the sign-in shortcut (or by an
 * organizer) can be missing the details the full signup form requires. These
 * helpers back the "please complete your details" nudge on My Details and the
 * Abstracts / Session Proposals surfaces, so someone about to submit is
 * encouraged to fill them in first.
 *
 * The required set mirrors the PUBLIC signup form's required fields (minus
 * name/email, which always exist).
 */

export interface ProfileCompletenessInput {
  role: string | null;
  specialty: string | null;
  organization: string | null;
  jobTitle: string | null;
  phone: string | null;
  city: string | null;
  country: string | null;
}

const REQUIRED_FIELDS: Array<{ key: keyof ProfileCompletenessInput; label: string }> = [
  { key: "role", label: "Role" },
  { key: "specialty", label: "Specialty" },
  { key: "organization", label: "Organization" },
  { key: "jobTitle", label: "Job title" },
  { key: "phone", label: "Phone" },
  { key: "city", label: "City" },
  { key: "country", label: "Country" },
];

/** Human-readable labels of the required fields that are still empty. */
export function missingProfileFields(p: ProfileCompletenessInput): string[] {
  return REQUIRED_FIELDS.filter(({ key }) => !p[key]?.toString().trim()).map(({ label }) => label);
}

export function isProfileIncomplete(p: ProfileCompletenessInput): boolean {
  return missingProfileFields(p).length > 0;
}
