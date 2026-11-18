/**
 * THE rule for what a session role DOES (Nov 18, 2026; plan:
 * docs/SESSION_ROLES_PLAN.md). Every role has one of two duties: it RUNS the
 * session (Moderator, Chairperson) or it PRESENTS in it (Speaker, Panelist).
 * The duty is what the system acts on: a running role gets the "Your
 * Moderation Details" run-sheet (`{{moderatorDetails}}`), a presenting role
 * the "Your Presentation Details" block. The name is only what people read.
 *
 * Step 1 of the plan: the four built-in roles only, read from the
 * `SessionSpeaker.role` enum. Roles an organisation adds (a Host that runs, a
 * Keynote that presents) come in step 2 and are answered here too, so no
 * caller changes again.
 *
 * **Never compare a role to "MODERATOR" or "CHAIRPERSON" to decide what it
 * does**: ask `runsSession`. `session-roles-ratchet.test.ts` lists the files
 * allowed to name those values.
 *
 * Pure and client-safe.
 */
import type { SessionRole } from "@prisma/client";

export type SessionRoleDuty = "RUNS" | "PRESENTS";

/** The duty of each built-in role. Exhaustive: a new enum value fails the build until classed. */
export const BUILT_IN_ROLE_DUTY: Record<SessionRole, SessionRoleDuty> = {
  SPEAKER: "PRESENTS",
  MODERATOR: "RUNS",
  CHAIRPERSON: "RUNS",
  PANELIST: "PRESENTS",
};

/**
 * The built-in roles that run a session, for a database filter
 * (`role: { in: RUNNING_BUILT_IN_ROLES }`).
 */
export const RUNNING_BUILT_IN_ROLES = (Object.keys(BUILT_IN_ROLE_DUTY) as SessionRole[]).filter(
  (role) => BUILT_IN_ROLE_DUTY[role] === "RUNS",
);

/**
 * The duty of an assignment's role. An unknown value (bad data, or a value an
 * older image does not know) presents: the person still appears in the
 * Presentation Details block rather than vanishing from both.
 */
export function roleDuty(role: string | null | undefined): SessionRoleDuty {
  if (!role || !Object.hasOwn(BUILT_IN_ROLE_DUTY, role)) return "PRESENTS";
  return BUILT_IN_ROLE_DUTY[role as SessionRole];
}

/** True when the role runs the session: the person gets the moderation run-sheet. */
export function runsSession(role: string | null | undefined): boolean {
  return roleDuty(role) === "RUNS";
}
