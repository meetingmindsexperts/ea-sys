import { z } from "zod";

/** Shared Zod enum for Title field — matches Prisma Title enum.
 *  Accepts empty string and transforms to undefined (for clearing). */
export const titleEnum = z.enum(["DR", "MR", "MRS", "MS", "PROF"]).or(z.literal("").transform(() => undefined));

/**
 * A Role answer's KEY, as a door takes it (step 1c of docs/ORG_FIELDS_PLAN.md):
 * text, not the fixed list of nine. WHICH answers are accepted is the
 * organisation's list, checked by the door with `roleAnswerProblem`
 * (person-field-check.ts) once it knows the organisation: a newly chosen answer
 * the organisation does not offer is refused, one the record already holds is
 * kept. 100 is MAX_PERSON_FIELD_ANSWER in person-fields.ts (that module imports
 * this one, so the number is written here).
 */
export const roleAnswer = z.string().trim().min(1).max(100);

/**
 * Role where a form may leave it out: an answer key, or nothing ("" is
 * nothing). Whether it is DEMANDED is the organisation's rule, added per
 * request by `withPersonFieldRules` (src/lib/person-field-check.ts).
 */
export const optionalRoleAnswer = roleAnswer.optional().or(z.literal("").transform(() => undefined));

/**
 * Specialty where a form may leave it out. Demanded, or not, by the
 * organisation's rule (as above). A blank answer is NO answer: the forms send
 * "" for a field left empty or switched off, and that must never be stored as
 * an empty text beside the rows that hold null.
 */
export const optionalSpecialty = z
  .string()
  .max(255)
  .optional()
  .transform((value) => (value && value.trim() ? value : undefined));

/**
 * Title where a form may leave it out, key and all. `titleEnum` alone refuses
 * a request with no `title` key, which is what a form sends once the
 * organisation has switched Title off (review of f0899baf).
 */
export const optionalTitle = titleEnum.optional();

/** AttendeeRole enum key type (matches Prisma AttendeeRole). */
export type AttendeeRoleValue =
  | "ACADEMIA"
  | "ALLIED_HEALTH"
  | "MEDICAL_DEVICES"
  | "PHARMA"
  | "PHYSICIAN"
  | "RESIDENT"
  | "SPEAKER"
  | "STUDENT"
  | "OTHERS";

/** Display order for the AttendeeRole ("Role"/profession category) picker. */
export const ATTENDEE_ROLE_ORDER: AttendeeRoleValue[] = [
  "ACADEMIA",
  "ALLIED_HEALTH",
  "MEDICAL_DEVICES",
  "PHARMA",
  "PHYSICIAN",
  "RESIDENT",
  "SPEAKER",
  "STUDENT",
  "OTHERS",
];

/** Human labels for the AttendeeRole enum. Pure map — safe to import from
 *  both server (API/CSV) and client (forms/tables) code. */
export const ATTENDEE_ROLE_LABELS: Record<AttendeeRoleValue, string> = {
  ACADEMIA: "Academia",
  ALLIED_HEALTH: "Allied Health",
  MEDICAL_DEVICES: "Medical Devices",
  PHARMA: "Pharma",
  PHYSICIAN: "Physician",
  RESIDENT: "Resident",
  SPEAKER: "Speaker",
  STUDENT: "Student",
  OTHERS: "Others (Spouse)",
};

/** The Prisma `Title` enum values, as a CSV-parseable set. */
export type TitleValue = "DR" | "MR" | "MRS" | "MS" | "PROF";
const TITLE_SET = new Set<string>(["DR", "MR", "MRS", "MS", "PROF"]);

/**
 * Parse a free-text CSV cell into a Title, or null when empty/unrecognized.
 *
 * Accepts what operators type — case-insensitive and tolerant of the trailing
 * period the UI labels carry ("Dr." → DR).
 *
 * ONE implementation for every CSV import; the registrations and speakers
 * importers each carried their own hardcoded `TITLE_VALUES` set before this.
 */
export function parseTitle(raw: string | null | undefined): TitleValue | null {
  if (!raw) return null;
  const normalized = raw.trim().toUpperCase().replace(/\.$/, "");
  return TITLE_SET.has(normalized) ? (normalized as TitleValue) : null;
}

// A written Role answer is read with `answerKeyFor` in src/lib/person-fields.ts,
// against the ORGANISATION's answers (step 1c of docs/ORG_FIELDS_PLAN.md). The
// fixed-list parser that stood here (parseAttendeeRole) is gone: it could only
// read the nine, and could not read "Others (Spouse)".

/**
 * A presenter's contact details, as BOTH public abstract doors collect them:
 * the new-account `/submitter` and the existing-account `/abstract-start`
 * (Sep 29, 2026). One definition so the two doors cannot require different
 * things; before this, a signed-in presenter became a speaker with only a name
 * (organisation, phone, country and specialty blank) and the payable
 * registration was minted from those blanks.
 *
 * Kept as a plain object (no refine) so each door can `.extend()` it. Role and
 * Specialty are taken leniently here: each door wraps its final schema in
 * `withPersonFieldRules` with its organisation's rules, which also holds the
 * "Others needs the typed specialty" rule (Nov 13, 2026).
 */
export const presenterDetailsSchema = z.object({
  title: optionalTitle,
  role: optionalRoleAnswer,
  firstName: z.string().min(1, "First name is required").max(100),
  lastName: z.string().min(1, "Last name is required").max(100),
  additionalEmail: z.string().email().max(255).optional().or(z.literal("")),
  state: z.string().max(255).optional(),
  zipCode: z.string().max(20).optional(),
  organization: z.string().min(1, "Organization is required").max(255),
  jobTitle: z.string().min(1, "Position is required").max(255),
  phone: z.string().min(1, "Mobile number is required").max(50),
  city: z.string().min(1, "City is required").max(255),
  country: z.string().min(1, "Country is required").max(255),
  specialty: optionalSpecialty,
  customSpecialty: z.string().max(255).optional(),
});

/**
 * The personal fields the public registration form asks, with its own rules
 * and messages: ONE definition for the register route, account sign-up and My
 * Details (Nov 9, 2026), so an account made at /signup always holds what a
 * registration would need, and the three can never ask different things.
 * Email is not here: each caller treats it differently (sign-up takes it, My
 * Details never changes it).
 */
export const personalDetailsFields = {
  title: optionalTitle,
  role: optionalRoleAnswer,
  firstName: z.string().min(1, "First name is required").max(100),
  lastName: z.string().min(1, "Last name is required").max(100),
  organization: z.string().min(1, "Organization is required").max(255),
  jobTitle: z.string().min(1, "Position is required").max(255),
  phone: z.string().min(1, "Mobile number is required").max(50),
  city: z.string().min(1, "City is required").max(255),
  state: z.string().max(255).optional(),
  zipCode: z.string().max(20).optional(),
  country: z.string().min(1, "Country is required").max(255),
  specialty: optionalSpecialty,
  customSpecialty: z.string().max(255).optional(),
};
