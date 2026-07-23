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

import { SessionRole, SessionStatus, SessionType } from "@prisma/client";

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

// ── Session type ─────────────────────────────────────────────────────────────
//
// Two kinds of type: PROGRAM types (SESSION, WORKSHOP, SYMPOSIUM) carry
// speakers/topics/track/Zoom, render inside their assigned track's column,
// and count as program content; BREAK types (registration desk, coffee break,
// lunch, networking) are plain time blocks with none of that, rendered as
// full-width muted bands. The label is a default: the item's own `name` is
// what renders on the agenda ("Morning Coffee Break"), the type drives
// styling + which form sections apply.

export const SESSION_TYPE_LABELS: Record<SessionType, string> = {
  SESSION: "Session",
  WORKSHOP: "Workshop",
  SYMPOSIUM: "Symposium",
  REGISTRATION: "Registration",
  BREAK: "Coffee Break",
  LUNCH: "Lunch Break",
  NETWORKING: "Networking",
};

/** Program-vs-break classification. Exhaustive over the Prisma enum on
 *  purpose — a future SessionType value fails the BUILD until someone
 *  decides which kind it is, instead of silently inheriting one (the old
 *  "everything except SESSION is a break" rule would have made Workshop a
 *  break item). */
export const SESSION_TYPE_KIND: Record<SessionType, "program" | "break"> = {
  SESSION: "program",
  WORKSHOP: "program",
  SYMPOSIUM: "program",
  REGISTRATION: "break",
  BREAK: "break",
  LUNCH: "break",
  NETWORKING: "break",
};

/** The break-item values, for Prisma `notIn` filters (counts must exclude
 *  breaks, not require exactly SESSION — Workshop/Symposium count). */
export const BREAK_SESSION_TYPES = (
  Object.keys(SESSION_TYPE_KIND) as SessionType[]
).filter((t) => SESSION_TYPE_KIND[t] === "break");

/** Type-picker order: program types first, then break items in a typical
 *  conference-day order. */
export const SESSION_TYPE_OPTIONS: { value: SessionType; label: string }[] = [
  { value: "SESSION", label: SESSION_TYPE_LABELS.SESSION },
  { value: "WORKSHOP", label: SESSION_TYPE_LABELS.WORKSHOP },
  { value: "SYMPOSIUM", label: SESSION_TYPE_LABELS.SYMPOSIUM },
  { value: "REGISTRATION", label: SESSION_TYPE_LABELS.REGISTRATION },
  { value: "BREAK", label: SESSION_TYPE_LABELS.BREAK },
  { value: "LUNCH", label: SESSION_TYPE_LABELS.LUNCH },
  { value: "NETWORKING", label: SESSION_TYPE_LABELS.NETWORKING },
];

/** True only for the explicit break-item types. Null/undefined (rows read
 *  before the column existed, or payloads that omit it) and unknown values
 *  count as a real program session — fails OPEN, pinned by tests. */
export function isBreakSessionType(type: string | null | undefined): boolean {
  return type != null && SESSION_TYPE_KIND[type as SessionType] === "break";
}

/** Display label for a session type coming off the wire. */
export function formatSessionType(type: string | null | undefined): string {
  if (!type) return SESSION_TYPE_LABELS.SESSION;
  return (
    SESSION_TYPE_LABELS[type as SessionType] ??
    type.charAt(0).toUpperCase() + type.slice(1).toLowerCase()
  );
}

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
