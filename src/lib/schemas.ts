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
