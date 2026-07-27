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
