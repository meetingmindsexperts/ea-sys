import { z } from "zod";

/** Shared Zod enum for Title field — matches Prisma Title enum.
 *  Accepts empty string and transforms to undefined (for clearing). */
export const titleEnum = z.enum(["DR", "MR", "MRS", "MS", "PROF"]).or(z.literal("").transform(() => undefined));

/** Shared Zod enum for AttendeeRole field — matches Prisma AttendeeRole enum */
export const attendeeRoleEnum = z.enum([
  "ACADEMIA",
  "ALLIED_HEALTH",
  "MEDICAL_DEVICES",
  "PHARMA",
  "PHYSICIAN",
  "RESIDENT",
  "SPEAKER",
  "STUDENT",
  "OTHERS",
]);

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

/** Format an AttendeeRole value for display; falls back to a dash when empty.
 *  Unknown values pass through unchanged (defensive against enum drift). */
export function formatAttendeeRole(
  role: string | null | undefined,
  fallback = "—",
): string {
  if (!role) return fallback;
  return ATTENDEE_ROLE_LABELS[role as AttendeeRoleValue] ?? role;
}

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

const ATTENDEE_ROLE_SET = new Set<string>(ATTENDEE_ROLE_ORDER);

/**
 * Parse a free-text CSV cell into an AttendeeRole, or null when it's empty or
 * unrecognized.
 *
 * Accepts the human labels operators actually type — case-insensitive, with
 * spaces or hyphens where the enum has underscores, so "Allied Health",
 * "allied-health" and "ALLIED_HEALTH" all resolve.
 *
 * ONE implementation for every CSV import (registrations / speakers /
 * contacts). It previously existed only inside the registrations importer,
 * which is why the other two silently dropped the column.
 *
 * An unrecognized value returns null (the field is optional and a typo must
 * not fail the whole row) — the caller decides whether to surface that.
 */
export function parseAttendeeRole(raw: string | null | undefined): AttendeeRoleValue | null {
  if (!raw) return null;
  const normalized = raw.trim().toUpperCase().replace(/[\s-]/g, "_");
  return ATTENDEE_ROLE_SET.has(normalized) ? (normalized as AttendeeRoleValue) : null;
}

/**
 * A presenter's contact details, as BOTH public abstract doors collect them:
 * the new-account `/submitter` and the existing-account `/abstract-start`
 * (Sep 29, 2026). One definition so the two doors cannot require different
 * things; before this, a signed-in presenter became a speaker with only a name
 * (organisation, phone, country and specialty blank) and the payable
 * registration was minted from those blanks.
 *
 * Kept as a plain object (no refine) so each door can `.extend()` it; apply
 * `refinePresenterSpecialty` to the final schema.
 */
export const presenterDetailsSchema = z.object({
  title: titleEnum,
  role: attendeeRoleEnum,
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
  specialty: z.string().min(1, "Specialty is required").max(255),
  customSpecialty: z.string().max(255).optional(),
});

/** "Others" as a specialty needs the free-text one. Shared by both doors. */
export function refinePresenterSpecialty<T extends z.ZodTypeAny>(schema: T) {
  return schema.refine(
    (data) => {
      const d = data as { specialty?: string; customSpecialty?: string };
      return d.specialty !== "Others" || (d.customSpecialty?.trim().length ?? 0) > 0;
    },
    { message: "Please specify your specialty", path: ["customSpecialty"] },
  );
}
