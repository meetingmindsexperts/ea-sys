/**
 * The organisation's session roles (Nov 18, 2026; docs/SESSION_ROLES_PLAN.md):
 * read the list, or save it as a whole in its new order.
 *
 * Rules (owner decisions D2 and D3 of the plan):
 * - The four built-ins are always on the list: renamed and hidden, never
 *   removed, and their duty never changes.
 * - An added role with a `key` is an existing one: its name, hiding and order
 *   change, and so may its duty, but only while nobody holds it (changing it
 *   would move people between the two email blocks without a word).
 * - An entry without a key is new and gets one from its name.
 * - An added role left out is deleted, unless somebody holds it: then the
 *   whole save is refused, with who holds what, and the role can be hidden.
 *
 * Read, plan, the in-use count and the write happen in ONE transaction holding
 * the organisation row lock (the sponsor tiers' review of b5ce5414): planned
 * from an unlocked read, two people saving at once could drop a role the other
 * had just added and assigned. A key anyone still holds is never handed to a
 * new role. The caller runs this inside the organisation's tenant lane.
 */
import type { Prisma } from "@prisma/client";
import { db, tenantTransaction } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import {
  MAX_SESSION_ROLE_LABEL,
  MAX_SESSION_ROLES,
  newSessionRoleKey,
  readSessionRoles,
  SESSION_ROLES_SETTING,
  BUILT_IN_SESSION_ROLES,
  type SessionRoleDef,
  type SessionRoleDuty,
} from "@/lib/session-roles";

export type SaveSessionRolesErrorCode =
  | "ORGANIZATION_NOT_FOUND"
  | "TOO_MANY"
  | "INVALID_LABEL"
  | "DUPLICATE_LABEL"
  | "UNKNOWN_ROLE"
  | "BUILT_IN_REQUIRED"
  | "BUILT_IN_DUTY_FIXED"
  | "ROLE_IN_USE"
  | "UNKNOWN";

export interface SessionRoleInUse {
  key: string;
  label: string;
  /** How many session assignments hold it. */
  assignments: number;
}

export interface SessionRoleInput {
  key?: string | null;
  label: string;
  duty: SessionRoleDuty;
  hidden?: boolean;
}

export type SaveSessionRolesResult =
  | { ok: true; roles: SessionRoleDef[] }
  | { ok: false; code: SaveSessionRolesErrorCode; message: string; inUse?: SessionRoleInUse[] };

const fail = (code: SaveSessionRolesErrorCode, message: string, inUse?: SessionRoleInUse[]): SaveSessionRolesResult => ({
  ok: false,
  code,
  message,
  ...(inUse ? { inUse } : {}),
});

/** The organisation's list, built-ins included, in its order. */
export async function getSessionRoles(organizationId: string): Promise<SessionRoleDef[]> {
  const org = await db.organization.findUnique({ where: { id: organizationId }, select: { settings: true } });
  return readSessionRoles(org?.settings);
}

/**
 * The list for a page that only shows names (the public agenda, a session
 * page): a failure to read it is logged and the four built-in names are used,
 * so a role name can never take the page down.
 */
export async function getSessionRolesForDisplay(organizationId: string): Promise<SessionRoleDef[]> {
  try {
    return await getSessionRoles(organizationId);
  } catch (err) {
    apiLogger.warn({ err, organizationId, msg: "session-roles:read-failed-showing-built-ins" });
    return BUILT_IN_SESSION_ROLES.map((r) => ({ ...r }));
  }
}

/**
 * The list with how many session assignments hold each role, for Settings: a
 * held role can be hidden, not deleted, and keeps its duty. Built-ins are
 * counted by their enum among assignments that hold no added role. The caller
 * runs this inside the organisation's tenant lane (SessionSpeaker is policied).
 */
export async function getSessionRolesWithCounts(
  organizationId: string,
): Promise<(SessionRoleDef & { assignments: number })[]> {
  const where = { session: { event: { organizationId } } };
  const [roles, builtIn, added] = await Promise.all([
    getSessionRoles(organizationId),
    db.sessionSpeaker.groupBy({ by: ["role"], where: { ...where, customRoleKey: null }, _count: { _all: true } }),
    db.sessionSpeaker.groupBy({ by: ["customRoleKey"], where: { ...where, customRoleKey: { not: null } }, _count: { _all: true } }),
  ]);
  const counts = new Map<string, number>();
  for (const row of builtIn) counts.set(row.role, row._count._all);
  for (const row of added) if (row.customRoleKey) counts.set(row.customRoleKey, row._count._all);
  return roles.map((r) => ({ ...r, assignments: counts.get(r.key) ?? 0 }));
}

type Plan = { ok: true; next: SessionRoleDef[] } | { ok: false; result: SaveSessionRolesResult };

/** The next list, or why the input cannot become one. Pure; exported for tests. */
export function planSessionRoles(
  current: SessionRoleDef[],
  input: SessionRoleInput[],
  heldCount: ReadonlyMap<string, number>,
): Plan {
  if (input.length > MAX_SESSION_ROLES) {
    return { ok: false, result: fail("TOO_MANY", `At most ${MAX_SESSION_ROLES} roles.`) };
  }
  const byKey = new Map(current.map((r) => [r.key, r]));
  const labelsSeen = new Set<string>();
  const keysSeen = new Set<string>();
  const keysTaken = new Set<string>([...current.map((r) => r.key), ...heldCount.keys()]);
  const next: SessionRoleDef[] = [];
  for (const entry of input) {
    const label = entry.label.trim();
    if (!label || label.length > MAX_SESSION_ROLE_LABEL) {
      return { ok: false, result: fail("INVALID_LABEL", `A role name needs 1 to ${MAX_SESSION_ROLE_LABEL} characters.`) };
    }
    if (labelsSeen.has(label.toLowerCase())) {
      return { ok: false, result: fail("DUPLICATE_LABEL", `There is already a role called "${label}".`) };
    }
    labelsSeen.add(label.toLowerCase());
    // A built-in's code is how the agent and a CSV name it, so no other role may
    // be called that: "moderator" must never mean two roles (review LOW 3).
    const codeOf = BUILT_IN_SESSION_ROLES.find((b) => b.key.toLowerCase() === label.toLowerCase());
    if (codeOf && entry.key !== codeOf.key) {
      return { ok: false, result: fail("DUPLICATE_LABEL", `"${label}" is the built-in ${codeOf.label} role's own name. Choose another name.`) };
    }
    if (entry.key) {
      if (keysSeen.has(entry.key)) {
        return { ok: false, result: fail("UNKNOWN_ROLE", `"${label}" is listed twice. Reload and try again.`) };
      }
      keysSeen.add(entry.key);
    }
    const hidden = entry.hidden === true;

    if (!entry.key) {
      const key = newSessionRoleKey(label, keysTaken);
      keysTaken.add(key);
      next.push({ key, label, duty: entry.duty, builtIn: false, hidden });
      continue;
    }
    const existing = byKey.get(entry.key);
    if (!existing) {
      return { ok: false, result: fail("UNKNOWN_ROLE", `"${label}" refers to a role that does not exist. Reload and try again.`) };
    }
    if (existing.builtIn && entry.duty !== existing.duty) {
      return { ok: false, result: fail("BUILT_IN_DUTY_FIXED", `"${existing.label}" always ${dutyWords(existing.duty)}.`) };
    }
    const held = heldCount.get(existing.key) ?? 0;
    if (!existing.builtIn && entry.duty !== existing.duty && held > 0) {
      return {
        ok: false,
        result: fail(
          "ROLE_IN_USE",
          `"${existing.label}" is held in ${held} session${held === 1 ? "" : "s"}, so it still ${dutyWords(existing.duty)}. Changing that would move those people to the other part of their emails.`,
          [{ key: existing.key, label: existing.label, assignments: held }],
        ),
      };
    }
    next.push({ ...existing, label, duty: entry.duty, hidden });
  }

  const kept = new Set(next.map((r) => r.key));
  const missingBuiltIn = BUILT_IN_SESSION_ROLES.filter((r) => !kept.has(r.key));
  if (missingBuiltIn.length > 0) {
    const names = missingBuiltIn.map((r) => byKey.get(r.key)?.label ?? r.label).join(", ");
    return { ok: false, result: fail("BUILT_IN_REQUIRED", `The built-in roles can be renamed or hidden, not deleted: ${names}.`) };
  }
  const inUse = current.flatMap((r) => {
    if (kept.has(r.key)) return [];
    const assignments = heldCount.get(r.key) ?? 0;
    return assignments > 0 ? [{ key: r.key, label: r.label, assignments }] : [];
  });
  if (inUse.length > 0) {
    const names = inUse.map((r) => `${r.label} (${r.assignments})`).join(", ");
    return {
      ok: false,
      result: fail("ROLE_IN_USE", `These roles are held, so hide them instead of deleting them: ${names}.`, inUse),
    };
  }
  return { ok: true, next };
}

function dutyWords(duty: SessionRoleDuty): string {
  return duty === "RUNS" ? "runs the session" : "presents";
}

type SaveOutcome =
  | { saved: false; result: SaveSessionRolesResult }
  | { saved: true; before: SessionRoleDef[]; after: SessionRoleDef[] };

export async function saveSessionRoles(input: {
  organizationId: string;
  actorUserId: string;
  roles: SessionRoleInput[];
}): Promise<SaveSessionRolesResult> {
  try {
    const outcome = await tenantTransaction(async (tx): Promise<SaveOutcome> => {
      // The same row lock every organisation-settings writer takes.
      const rows = await tx.$queryRaw<{ settings: Prisma.JsonValue | null }[]>`SELECT "settings" FROM "Organization" WHERE "id" = ${input.organizationId} FOR UPDATE`;
      if (rows.length === 0) return { saved: false, result: fail("ORGANIZATION_NOT_FOUND", "Organisation not found") };
      const settings = (rows[0].settings ?? {}) as Record<string, unknown>;
      const current = readSessionRoles(settings);

      // Every added role anyone in this organisation holds, through the event
      // (older SessionSpeaker rows may lack their own organisation stamp).
      const held = await tx.sessionSpeaker.groupBy({
        by: ["customRoleKey"],
        where: { customRoleKey: { not: null }, session: { event: { organizationId: input.organizationId } } },
        _count: { _all: true },
      });
      const heldCount = new Map(
        held.flatMap((h) => (h.customRoleKey ? [[h.customRoleKey, h._count._all] as const] : [])),
      );

      const plan = planSessionRoles(current, input.roles, heldCount);
      if (!plan.ok) return { saved: false, result: plan.result };

      // Stored without `builtIn`: that is derived from the key on every read.
      const stored = plan.next.map(({ key, label, duty, hidden }) => ({ key, label, duty, hidden }));
      await tx.organization.update({
        where: { id: input.organizationId },
        data: { settings: { ...settings, [SESSION_ROLES_SETTING]: stored } as unknown as Prisma.InputJsonValue },
      });
      return { saved: true, before: current, after: plan.next };
    });

    if (!outcome.saved) {
      apiLogger.warn({ msg: "session-roles:save-rejected", organizationId: input.organizationId, code: outcome.result.ok ? null : outcome.result.code });
      return outcome.result;
    }
    db.auditLog
      .create({
        data: {
          userId: input.actorUserId,
          action: "UPDATE",
          entityType: "Organization",
          entityId: input.organizationId,
          changes: { sessionRoles: { before: outcome.before, after: outcome.after } } as unknown as Prisma.InputJsonValue,
        },
      })
      .catch((err) => apiLogger.warn({ err, organizationId: input.organizationId }, "session-roles:audit-failed"));
    apiLogger.info(
      { organizationId: input.organizationId, by: input.actorUserId, count: outcome.after.length },
      "session-roles:saved",
    );
    return { ok: true, roles: outcome.after };
  } catch (err) {
    apiLogger.error({ err, organizationId: input.organizationId }, "session-roles:save-failed");
    return fail("UNKNOWN", "Failed to save session roles");
  }
}
