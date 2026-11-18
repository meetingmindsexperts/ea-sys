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
import { SESSION_ROLE_LABELS, SESSION_ROLE_OPTIONS } from "@/lib/session-enums";

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

// ── The organisation's list (plan step 2) ────────────────────────────────────
//
// Kept in `Organization.settings.sessionRoles`, the sponsor-tier way: the
// whole list in order, the four built-ins (rename and hide only, duty fixed)
// and the roles the organisation added (key, name, duty, hidden). An
// assignment stores an added role's key in `SessionSpeaker.customRoleKey`,
// and its `role` enum column always holds the built-in of the role's duty
// (MODERATOR for running, SPEAKER for presenting). So `runsSession(role)`
// answers for added roles too, and an older image reading the enum still
// sends the right email block.

export const SESSION_ROLES_SETTING = "sessionRoles";
export const MAX_SESSION_ROLES = 30;
export const MAX_SESSION_ROLE_LABEL = 40;

export interface SessionRoleDef {
  /** A built-in's enum value, or an added role's lower-case key. */
  key: string;
  label: string;
  duty: SessionRoleDuty;
  builtIn: boolean;
  /** Hidden roles are kept by the people who hold them, but never offered. */
  hidden: boolean;
}

/** The built-ins in the picker order the agenda form has always used. */
export const BUILT_IN_SESSION_ROLES: SessionRoleDef[] = SESSION_ROLE_OPTIONS.map(({ value, label }) => ({
  key: value,
  label,
  duty: BUILT_IN_ROLE_DUTY[value],
  builtIn: true,
  hidden: false,
}));

function isBuiltInRoleKey(key: string): key is SessionRole {
  return Object.hasOwn(BUILT_IN_ROLE_DUTY, key);
}

function isDuty(value: unknown): value is SessionRoleDuty {
  return value === "RUNS" || value === "PRESENTS";
}

/**
 * The organisation's list, in order. Malformed entries are dropped, a built-in
 * keeps its own duty whatever was stored, and a built-in missing from the
 * stored list comes back at the end, so the four can never be lost.
 */
export function readSessionRoles(orgSettings: unknown): SessionRoleDef[] {
  const raw =
    orgSettings && typeof orgSettings === "object"
      ? (orgSettings as Record<string, unknown>)[SESSION_ROLES_SETTING]
      : undefined;
  if (!Array.isArray(raw)) return BUILT_IN_SESSION_ROLES.map((r) => ({ ...r }));
  const out: SessionRoleDef[] = [];
  const seen = new Set<string>();
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const { key, label, duty, hidden } = entry as Record<string, unknown>;
    if (typeof key !== "string" || !key || seen.has(key)) continue;
    const name = typeof label === "string" ? label.trim() : "";
    if (isBuiltInRoleKey(key)) {
      const base = BUILT_IN_SESSION_ROLES.find((r) => r.key === key)!;
      out.push({ ...base, label: name || base.label, hidden: hidden === true });
      seen.add(key);
      continue;
    }
    if (!name || !isDuty(duty)) continue;
    out.push({ key, label: name, duty, builtIn: false, hidden: hidden === true });
    seen.add(key);
  }
  for (const base of BUILT_IN_SESSION_ROLES) {
    if (!seen.has(base.key)) out.push({ ...base });
  }
  return out;
}

/** The role key an assignment holds: its added role's key, or its built-in. */
export function sessionRoleKeyOf(assignment: { role: string; customRoleKey?: string | null }): string {
  return assignment.customRoleKey || assignment.role;
}

/**
 * The name to show for an assignment. An added role that is no longer on the
 * list (it cannot be deleted while held, so only bad data) falls back to its
 * duty's built-in, which is what the enum column says.
 */
export function sessionRoleLabel(
  assignment: { role: string; customRoleKey?: string | null },
  roles: readonly SessionRoleDef[],
): string {
  const key = sessionRoleKeyOf(assignment);
  const found = roles.find((r) => r.key === key) ?? roles.find((r) => r.key === assignment.role);
  if (found) return found.label;
  return SESSION_ROLE_LABELS[assignment.role as SessionRole] ?? assignment.role;
}

/**
 * What a chosen role key writes: the enum (the built-in, or the built-in of
 * the added role's duty) and the added role's key. Null for a key that is not
 * on the list. A hidden role still resolves: someone who holds it keeps it
 * when the session is saved again.
 */
export function resolveSessionRoleKey(
  key: string,
  roles: readonly SessionRoleDef[],
): { role: SessionRole; customRoleKey: string | null } | null {
  if (isBuiltInRoleKey(key)) return { role: key, customRoleKey: null };
  const found = roles.find((r) => r.key === key && !r.builtIn);
  if (!found) return null;
  return { role: found.duty === "RUNS" ? "MODERATOR" : "SPEAKER", customRoleKey: found.key };
}

/** The key a new role gets: its name as a lower-case slug, unique against `taken`. */
export function newSessionRoleKey(label: string, taken: Iterable<string>): string {
  const used = new Set([...taken].map((k) => k.toLowerCase()));
  const base =
    label
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "role";
  if (!used.has(base)) return base;
  let n = 2;
  while (used.has(`${base}-${n}`)) n += 1;
  return `${base}-${n}`;
}
