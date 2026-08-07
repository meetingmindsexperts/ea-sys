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
 * name/email, which always exist), plus `bio` (owner, Aug 7, 2026): the
 * speaker's biography is printed in the programme and read out when they are
 * introduced, so chasing it after acceptance is the expensive moment to
 * discover it is missing.
 */

export interface ProfileCompletenessInput {
  role: string | null;
  specialty: string | null;
  organization: string | null;
  jobTitle: string | null;
  phone: string | null;
  city: string | null;
  country: string | null;
  bio: string | null;
}

const REQUIRED_FIELDS: Array<{ key: keyof ProfileCompletenessInput; label: string }> = [
  { key: "role", label: "Role" },
  { key: "specialty", label: "Specialty" },
  { key: "organization", label: "Organization" },
  { key: "jobTitle", label: "Job title" },
  { key: "phone", label: "Phone" },
  { key: "city", label: "City" },
  { key: "country", label: "Country" },
  { key: "bio", label: "Bio" },
];

/** Human-readable labels of the required fields that are still empty. */
export function missingProfileFields(p: ProfileCompletenessInput): string[] {
  return REQUIRED_FIELDS.filter(({ key }) => !p[key]?.toString().trim()).map(({ label }) => label);
}

export function isProfileIncomplete(p: ProfileCompletenessInput): boolean {
  return missingProfileFields(p).length > 0;
}

/**
 * Prisma `select` fragment for exactly the Speaker columns the completeness
 * check reads — spread it into a speaker lookup so the row can be passed to
 * `missingProfileFields` directly.
 */
export const PROFILE_COMPLETENESS_SELECT = {
  role: true,
  specialty: true,
  organization: true,
  jobTitle: true,
  phone: true,
  city: true,
  country: true,
  bio: true,
} as const;

/**
 * 403 payload for the hard gate (Aug 5, 2026): a SUBMITTER may not create or
 * submit an abstract / session proposal until their profile is complete. The
 * forms redirect to My Details before this ever fires — the server refusal
 * exists so a direct API call can't bypass the gate.
 */
export function profileIncompletePayload(missing: string[]) {
  return {
    error: `Please complete your details before submitting (missing: ${missing.join(", ")}). Open My Details to fill them in.`,
    code: "PROFILE_INCOMPLETE" as const,
    missingFields: missing,
  };
}
