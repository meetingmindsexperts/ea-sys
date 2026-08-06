/**
 * Group-registration settings (docs/GROUP_REGISTRATION_PLAN.md, Phase 1) —
 * client-safe, pure. Lives in `Event.settings.groupRegistration` (settings
 * JSON, no migration):
 *
 *   { enabled: boolean, minMembers: number, maxMembers: number }
 *
 * Organizer-controlled bounds (owner decision July 30, 2026): the coordinator
 * may register any group size within [minMembers, maxMembers]. A HARD server
 * ceiling of 50 applies regardless of settings — a maxMembers above it is
 * clamped, never honored. Defaults: disabled, min 2, max 10.
 *
 * Defensive parse like the sibling settings helpers: a corrupt blob resolves
 * to the DISABLED default (fail closed for an opt-in feature — the opposite
 * polarity of the session-proposal deadline, which fails OPEN because it
 * closes an already-open door; here nothing should open by accident).
 */

export const GROUP_MEMBERS_HARD_CEILING = 50;

export interface GroupRegistrationSettings {
  enabled: boolean;
  minMembers: number;
  maxMembers: number;
}

export const DEFAULT_GROUP_REGISTRATION_SETTINGS: GroupRegistrationSettings = {
  enabled: false,
  minMembers: 2,
  maxMembers: 10,
};

function toBoundedInt(raw: unknown, fallback: number): number {
  const n = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(1, Math.min(GROUP_MEMBERS_HARD_CEILING, Math.trunc(n)));
}

/** The parsed + clamped settings from an Event.settings blob. */
export function readGroupRegistrationSettings(settings: unknown): GroupRegistrationSettings {
  if (!settings || typeof settings !== "object") return DEFAULT_GROUP_REGISTRATION_SETTINGS;
  const raw = (settings as Record<string, unknown>).groupRegistration;
  if (!raw || typeof raw !== "object") return DEFAULT_GROUP_REGISTRATION_SETTINGS;
  const rec = raw as Record<string, unknown>;

  const minMembers = toBoundedInt(rec.minMembers, DEFAULT_GROUP_REGISTRATION_SETTINGS.minMembers);
  const maxMembers = toBoundedInt(rec.maxMembers, DEFAULT_GROUP_REGISTRATION_SETTINGS.maxMembers);
  return {
    enabled: rec.enabled === true,
    // A min above the max collapses to the max (never an unsatisfiable range).
    minMembers: Math.min(minMembers, maxMembers),
    maxMembers,
  };
}

/** Bounds check for a proposed member count against the parsed settings. */
export function groupSizeOutOfBounds(
  count: number,
  s: GroupRegistrationSettings,
): { ok: true } | { ok: false; message: string } {
  if (count < s.minMembers) {
    return {
      ok: false,
      message: `A group needs at least ${s.minMembers} member${s.minMembers === 1 ? "" : "s"}.`,
    };
  }
  if (count > s.maxMembers) {
    return {
      ok: false,
      message: `A group can have at most ${s.maxMembers} members.`,
    };
  }
  return { ok: true };
}
