/**
 * Shared SessionRole + SessionStatus display constants (M11, program/agenda
 * review).
 *
 * Single source of truth for the dashboard agenda (grid tooltip + list +
 * role picker), the session detail sheet, the public agenda, the public
 * session page, and the speaker-agreement email context — they previously
 * carried four hand-rolled re-implementations, and the dashboard tooltip
 * rendered the raw enum (`MODERATOR:`) where the public page rendered
 * `Moderator`. Importing the Prisma enums keeps these `Record`s exhaustive:
 * TypeScript fails the build if a new enum value lacks a label/colour (same
 * pattern as registration-enums.ts / abstract-enums.ts).
 *
 * Client-safe: Prisma enums are plain string objects, no runtime imports.
 */

import { SessionRole, SessionStatus } from "@prisma/client";

export const SESSION_ROLE_LABELS: Record<SessionRole, string> = {
  SPEAKER: "Speaker",
  MODERATOR: "Moderator",
  CHAIRPERSON: "Chairperson",
  PANELIST: "Panelist",
};

export const SESSION_ROLE_COLORS: Record<SessionRole, string> = {
  SPEAKER: "bg-blue-100 text-blue-700",
  MODERATOR: "bg-purple-100 text-purple-700",
  CHAIRPERSON: "bg-amber-100 text-amber-700",
  PANELIST: "bg-teal-100 text-teal-700",
};

/** Role-picker order: the leadership roles first (deliberate UX order the
 *  agenda form has always used), plain Speaker last. */
export const SESSION_ROLE_OPTIONS: { value: SessionRole; label: string }[] = [
  { value: "MODERATOR", label: SESSION_ROLE_LABELS.MODERATOR },
  { value: "CHAIRPERSON", label: SESSION_ROLE_LABELS.CHAIRPERSON },
  { value: "PANELIST", label: SESSION_ROLE_LABELS.PANELIST },
  { value: "SPEAKER", label: SESSION_ROLE_LABELS.SPEAKER },
];

export const SESSION_STATUS_LABELS: Record<SessionStatus, string> = {
  DRAFT: "Draft",
  SCHEDULED: "Scheduled",
  LIVE: "Live",
  COMPLETED: "Completed",
  CANCELLED: "Cancelled",
};

export const SESSION_STATUS_COLORS: Record<SessionStatus, string> = {
  DRAFT: "bg-gray-100 text-gray-700",
  SCHEDULED: "bg-blue-100 text-blue-700",
  LIVE: "bg-green-100 text-green-700",
  COMPLETED: "bg-purple-100 text-purple-700",
  CANCELLED: "bg-red-100 text-red-700",
};

/** Display label for a role coming off the wire (typed as string in most
 *  payload interfaces). Unknown values degrade to Title Case, never raw. */
export function formatSessionRole(role: string | null | undefined): string {
  if (!role) return "";
  return (
    SESSION_ROLE_LABELS[role as SessionRole] ??
    role.charAt(0).toUpperCase() + role.slice(1).toLowerCase()
  );
}

/** Display label for a session status coming off the wire. */
export function formatSessionStatus(status: string | null | undefined): string {
  if (!status) return "";
  return (
    SESSION_STATUS_LABELS[status as SessionStatus] ??
    status.charAt(0).toUpperCase() + status.slice(1).toLowerCase()
  );
}

/** Badge colour for a status coming off the wire, with a neutral fallback. */
export function sessionStatusColor(status: string | null | undefined): string {
  return SESSION_STATUS_COLORS[status as SessionStatus] ?? "bg-gray-100 text-gray-700";
}
