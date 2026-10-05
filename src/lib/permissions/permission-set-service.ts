/**
 * Custom roles: reading them, and seeding the starter set once per organisation.
 *
 * SERVER-ONLY. It sits beside the client-safe `catalogue.ts` on purpose — the
 * catalogue is imported by the role editor and the sidebar, this file is not.
 * Keep the split: one `db` import in the catalogue would pull Prisma into the
 * browser bundle, where it resolves to undefined and fails at click time rather
 * than at build time.
 *
 * Runs inside the CALLER'S tenant lane and never opens one itself, the rule
 * `ensureBudgetCategories` established. Under RLS a read outside a lane returns
 * zero rows, which here reads as "this organisation has no roles" and would
 * re-seed on every call, so the lane is load-bearing rather than hygiene.
 */
import { db, tenantTransaction } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import type { GrantScope } from "@prisma/client";
import { STARTER_ROLES, describePermission, isGrantableKey, type PermissionKey } from "./catalogue";
import { isCustomRolesEnabled } from "@/lib/module-flags";
import { breaksAdminTrio, firstGrantBeyondActor } from "./escalation";
import type { Principal } from "./can";
import { SYSTEM_ROLES, SYSTEM_ROLE_KEYS, type Grant } from "./system-roles";
import { separationConflicts, unionPermissions } from "./separation";

export const PERMISSION_SET_SELECT = {
  id: true,
  name: true,
  description: true,
  key: true,
  isSystem: true,
  version: true,
  archivedAt: true,
  permissions: { select: { permission: true, scope: true } },
} as const;

export interface PermissionSetView {
  id: string;
  name: string;
  description: string | null;
  /** Set on a system role only. */
  key: string | null;
  isSystem: boolean;
  version: number;
  archivedAt: Date | null;
  permissions: { permission: string; scope: GrantScope | null }[];
}

/**
 * One ticked permission as the routes send it: a bare key (every live key
 * today is organisation-wide, so a scope never applies), or a key with the
 * scope an event-bound key needs once Phase 2 makes one live.
 */
export type GrantInput = string | { permission: string; scope?: GrantScope | null };

/**
 * The custom roles of an organisation. System roles (`isSystem`) are rows for
 * identity and the foreign key, with their grants in code; they are never
 * listed, edited, archived or assigned here (Phase 1 slice 2).
 */
async function readAll(organizationId: string): Promise<PermissionSetView[]> {
  return db.permissionSet.findMany({
    where: { organizationId, isSystem: false },
    orderBy: [{ archivedAt: "asc" }, { name: "asc" }],
    select: PERMISSION_SET_SELECT,
  });
}

/**
 * Seeds the four starter roles ONCE per organisation (D11, narrowed by D14).
 *
 * "Once" means: an organisation holding ANY role is never re-seeded, archived
 * ones included. Archiving all four is a decision, and re-creating them behind
 * the admin's back would quietly undo it. Same rule as budget categories and
 * CRM pipeline stages.
 *
 * ALL FOUR OR NONE. The creates share one transaction because a role that
 * exists with no ticks grants nothing while looking like a role: the next call
 * would see rows and skip the seed, leaving the organisation permanently short
 * of whichever roles came after the failure.
 *
 * Idempotent under concurrency via `@@unique([organizationId, name])`: the
 * loser of a race fails, changes nothing, and re-reads the winner's rows.
 */
export async function ensureStarterPermissionSets(organizationId: string): Promise<PermissionSetView[]> {
  const existing = await readAll(organizationId);
  if (existing.length > 0) return existing;

  try {
    await tenantTransaction(async (tx) => {
      for (const role of STARTER_ROLES) {
        await tx.permissionSet.create({
          data: {
            organizationId,
            name: role.name,
            description: role.description,
            permissions: {
              // The child carries its own organizationId: a nested create does
              // not inherit it, and the RLS policy is flat on that column.
              create: role.permissions.map((permission) => ({ organizationId, permission })),
            },
          },
        });
      }
    });
    apiLogger.info({
      msg: "permissions:starter-roles-seeded",
      organizationId,
      count: STARTER_ROLES.length,
    });
  } catch (err) {
    // The expected loss is a concurrent seeder taking the unique name. Anything
    // else is worth the same line: the re-read below is the answer either way,
    // and returning an empty list would read as "no roles exist".
    apiLogger.warn({ msg: "permissions:starter-roles-seed-raced", organizationId, err });
  }

  return readAll(organizationId);
}

/**
 * The permission keys a person holds, as the UNION of their roles (D2).
 *
 * Archived roles grant nothing: archiving is how access is withdrawn from
 * everyone holding a role at once, so it has to bite here rather than only in
 * the picker.
 *
 * Keys this build does not enforce are DROPPED, not returned. A row can outlive
 * the capability it names (a permission removed from the catalogue in a later
 * deploy), and passing it through would let a stale string satisfy a future
 * check that happens to reuse the name.
 */
export async function readUserPermissions(
  organizationId: string,
  userId: string,
): Promise<PermissionKey[]> {
  const held = await db.userPermissionSet.findMany({
    where: { organizationId, userId, permissionSet: { archivedAt: null } },
    select: { permissionSet: { select: { permissions: { select: { permission: true } } } } },
  });
  const keys = new Set<PermissionKey>();
  for (const row of held) {
    for (const { permission } of row.permissionSet.permissions) {
      if (isGrantableKey(permission, isCustomRolesEnabled())) keys.add(permission);
    }
  }
  return [...keys];
}

/**
 * The same union as (permission, scope) PAIRS, for `can()` (Phase 1 slice 3
 * reads this per request). Two roles holding one key at two scopes give two
 * pairs; the union is never collapsed to the wider scope (plan §7.3).
 */
export async function readUserGrants(organizationId: string, userId: string): Promise<Grant[]> {
  const held = await db.userPermissionSet.findMany({
    where: { organizationId, userId, permissionSet: { archivedAt: null } },
    select: { permissionSet: { select: { permissions: { select: { permission: true, scope: true } } } } },
  });
  const seen = new Set<string>();
  const grants: Grant[] = [];
  for (const row of held) {
    for (const { permission, scope } of row.permissionSet.permissions) {
      if (!isGrantableKey(permission, isCustomRolesEnabled())) continue;
      const pair = `${permission}@${scope ?? ""}`;
      if (seen.has(pair)) continue;
      seen.add(pair);
      grants.push(scope ? { permission, scope } : { permission });
    }
  }
  return grants;
}

/** The row key of a system role: "super_admin", "api_key". */
export function systemRoleRowKey(key: (typeof SYSTEM_ROLE_KEYS)[number]): string {
  return key.toLowerCase();
}

/**
 * One row per system role per organisation, for identity and the foreign key
 * (plan §3.3): no grants, those live in code. Idempotent: an upsert on the
 * (organisation, key) unique, so running it twice changes nothing, and a
 * renamed system role is renamed on the next run. NOT CALLED BY ANY ROUTE
 * YET (Phase 1 slice 2 ships it dark); the list, edit, archive and assign
 * paths all refuse a system row, so a seeded row changes nothing a user sees.
 */
export async function ensureSystemPermissionSets(organizationId: string): Promise<PermissionSetView[]> {
  return tenantTransaction(async (tx) => {
    const rows: PermissionSetView[] = [];
    for (const k of SYSTEM_ROLE_KEYS) {
      const role = SYSTEM_ROLES[k];
      const key = systemRoleRowKey(k);
      rows.push(
        await tx.permissionSet.upsert({
          where: { organizationId_key: { organizationId, key } },
          create: { organizationId, key, name: role.name, isSystem: true, description: "A built-in role. Its permissions are fixed by the application." },
          update: { name: role.name },
          select: PERMISSION_SET_SELECT,
        }),
      );
    }
    return rows;
  });
}

/* ------------------------------------------------------------------ *
 * Managing roles: the Settings screens' half of the service (step 4).
 *
 * Errors-as-values, like every other service here: the caller narrows on
 * `ok` and maps the code to its own status, so the service never imports
 * `next/server` and the same functions serve a future MCP tool unchanged.
 * ------------------------------------------------------------------ */

export type PermissionSetErrorCode =
  | "NAME_REQUIRED"
  | "NO_PERMISSIONS"
  | "UNKNOWN_PERMISSION"
  | "DUPLICATE_NAME"
  | "NOT_FOUND"
  | "ARCHIVED"
  | "STALE_WRITE"
  | "SEPARATION_CONFLICT"
  | "SCOPE_REQUIRED"
  | "SCOPE_NOT_ALLOWED"
  | "SYSTEM_ROLE"
  | "BEYOND_YOUR_ACCESS"
  | "ADMIN_TRIO"
  | "OWN_ROLE"
  | "UNKNOWN";

export interface PermissionSetFailure {
  ok: false;
  code: PermissionSetErrorCode;
  message: string;
  meta?: Record<string, unknown>;
}

export type PermissionSetResult = { ok: true; set: PermissionSetView } | PermissionSetFailure;

export interface PermissionSetListItem extends PermissionSetView {
  /** How many people hold this role. Shown in the list; the whole point of archiving. */
  holderCount: number;
}

/** Thrown INSIDE a transaction so the grant rewrite rolls back with the claim. */
class PermissionSetSentinel extends Error {
  constructor(readonly failure: PermissionSetFailure) {
    super(failure.code);
    this.name = "PermissionSetSentinel";
  }
}

function isUniqueNameViolation(err: unknown): boolean {
  return (err as { code?: string } | null)?.code === "P2002";
}

function fail(code: PermissionSetErrorCode, message: string, meta?: Record<string, unknown>): PermissionSetFailure {
  return { ok: false, code, message, ...(meta ? { meta } : {}) };
}

/** The name as it will be stored, or null when it is not a usable name. */
function cleanName(raw: string | undefined | null): string | null {
  const name = (raw ?? "").trim();
  return name.length === 0 || name.length > 100 ? null : name;
}

/**
 * Validates and deduplicates the ticked keys.
 *
 * An unknown key is REFUSED rather than dropped: silently discarding it would
 * store a role that grants less than the screen showed, which is the one
 * failure an administrator has no way to notice.
 */
interface CleanGrant {
  permission: PermissionKey;
  scope: GrantScope | null;
}

const SCOPES: ReadonlySet<string> = new Set(["ALL", "ASSIGNED", "WEBINAR"]);

function cleanGrants(raw: readonly GrantInput[]): { ok: true; grants: CleanGrant[]; keys: PermissionKey[] } | PermissionSetFailure {
  const grants: CleanGrant[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    const key = typeof item === "string" ? item : item.permission;
    const scope = typeof item === "string" ? null : (item.scope ?? null);
    // Grantable keys only: the procurement keys, and every other key once
    // custom roles are switched on (CUSTOM_ROLES_ENABLED).
    if (!isGrantableKey(key, isCustomRolesEnabled())) {
      return fail("UNKNOWN_PERMISSION", `This build does not have a permission called "${key}".`, { permission: key });
    }
    // The scope goes with the key's kind: an event-bound key without one
    // would grant nothing (`can()` fails closed on it), and a scope on an
    // organisation-wide key would read as a restriction that does not exist.
    const eventBound = describePermission(key)?.eventBound === true;
    if (eventBound && (scope === null || !SCOPES.has(scope))) {
      return fail("SCOPE_REQUIRED", `"${key}" applies to events, so it needs a scope: every event, assigned events, or webinars.`, { permission: key });
    }
    if (!eventBound && scope !== null) {
      return fail("SCOPE_NOT_ALLOWED", `"${key}" applies to the whole organisation and takes no scope.`, { permission: key, scope });
    }
    if (!seen.has(key)) {
      seen.add(key);
      grants.push({ permission: key, scope });
    }
  }
  if (grants.length === 0) {
    return fail("NO_PERMISSIONS", "A role has to grant at least one permission, or it grants nothing while looking like access.");
  }
  return { ok: true, grants, keys: grants.map((g) => g.permission) };
}

/** What the audit row records for a grant: the key, with its scope when it has one. */
function auditGrant(g: CleanGrant): string {
  return g.scope ? `${g.permission}@${g.scope}` : g.permission;
}

/** Rule 2 applied to one role on its own (rule 1 needs a person's AED authority). */
function refuseSelfConflict(keys: readonly string[]): PermissionSetFailure | null {
  const conflicts = separationConflicts({ permissions: keys });
  if (conflicts.length === 0) return null;
  return fail("SEPARATION_CONFLICT", conflicts[0].message, { conflicts });
}

export async function listPermissionSets(
  organizationId: string,
  opts: { includeArchived?: boolean } = {},
): Promise<PermissionSetListItem[]> {
  const rows = await db.permissionSet.findMany({
    where: { organizationId, ...(opts.includeArchived ? {} : { archivedAt: null }) },
    orderBy: [{ archivedAt: "asc" }, { name: "asc" }],
    select: { ...PERMISSION_SET_SELECT, _count: { select: { holders: true } } },
  });
  return rows.map(({ _count, ...set }) => ({ ...set, holderCount: _count.holders }));
}

/**
 * The editor's anti-escalation rules (plan §7.4): a role may grant only what
 * the person saving it holds, at no wider a scope, and the keys that make
 * admins only from someone holding all three.
 */
function refuseEscalation(actor: Principal, grants: readonly CleanGrant[]): PermissionSetFailure | null {
  const beyond = firstGrantBeyondActor(actor, grants);
  if (beyond) {
    return fail(
      "BEYOND_YOUR_ACCESS",
      `You can only give a role what you hold yourself: you do not hold "${beyond.permission}"${beyond.scope ? ` for ${beyond.scope.toLowerCase()} events` : ""}.`,
      { permission: beyond.permission, scope: beyond.scope },
    );
  }
  if (breaksAdminTrio(actor, grants)) {
    return fail(
      "ADMIN_TRIO",
      "Managing roles, managing users and organisation credentials can only be granted by someone who holds all three.",
    );
  }
  return null;
}

export async function createPermissionSet(input: {
  organizationId: string;
  actorUserId: string;
  /** The person saving it: a role may grant only what they hold (plan §7.4). */
  actor: Principal;
  name: string;
  description?: string | null;
  permissions: readonly GrantInput[];
  ip?: string | null;
}): Promise<PermissionSetResult> {
  const name = cleanName(input.name);
  if (!name) return fail("NAME_REQUIRED", "Give the role a name of up to 100 characters.");

  const cleaned = cleanGrants(input.permissions);
  if (!cleaned.ok) return cleaned;
  const selfConflict = refuseSelfConflict(cleaned.keys);
  if (selfConflict) return selfConflict;
  const escalation = refuseEscalation(input.actor, cleaned.grants);
  if (escalation) return escalation;

  try {
    const set = await db.permissionSet.create({
      data: {
        organizationId: input.organizationId,
        name,
        description: input.description?.trim() || null,
        // The child carries its own organizationId: a nested create does not
        // inherit it, and the RLS policy is flat on that column.
        permissions: {
          create: cleaned.grants.map((g) => ({ organizationId: input.organizationId, permission: g.permission, scope: g.scope })),
        },
      },
      select: PERMISSION_SET_SELECT,
    });
    await writeAudit({
      organizationId: input.organizationId,
      actorUserId: input.actorUserId,
      action: "CREATE",
      entityId: set.id,
      changes: { name, permissions: cleaned.grants.map(auditGrant), ip: input.ip ?? null },
    });
    apiLogger.info({ msg: "permissions:role-created", organizationId: input.organizationId, permissionSetId: set.id, name });
    return { ok: true, set };
  } catch (err) {
    if (isUniqueNameViolation(err)) {
      return fail("DUPLICATE_NAME", `There is already a role called "${name}".`);
    }
    apiLogger.error({ err, msg: "permissions:role-create-failed", organizationId: input.organizationId });
    return fail("UNKNOWN", "Could not create the role.");
  }
}

/**
 * Edits a role, under an optimistic lock.
 *
 * WHY EDITING RE-CHECKS EVERY HOLDER (plan §4). A role is shared, so adding a
 * tick here changes what every person holding it can do. Ticking "Approve" on a
 * role that a sign-off holder also carries would break the separation for that
 * person without anyone touching their account, so the save is refused and
 * names them. Checking only the role in isolation would let the combination in
 * through the side door.
 */
export async function updatePermissionSet(input: {
  organizationId: string;
  actorUserId: string;
  permissionSetId: string;
  expectedVersion: number;
  /** The person saving it: a role may grant only what they hold (plan §7.4). */
  actor: Principal;
  name?: string;
  description?: string | null;
  permissions?: readonly GrantInput[];
  ip?: string | null;
}): Promise<PermissionSetResult> {
  const current = await db.permissionSet.findFirst({
    where: { id: input.permissionSetId, organizationId: input.organizationId },
    select: PERMISSION_SET_SELECT,
  });
  if (!current) return fail("NOT_FOUND", "That role no longer exists.");
  if (current.isSystem) return fail("SYSTEM_ROLE", "A system role cannot be edited. Clone it into a custom role instead.");
  if (current.version !== input.expectedVersion) {
    return fail("STALE_WRITE", "Somebody else changed this role while you were editing it. Reload and try again.", {
      currentVersion: current.version,
    });
  }

  let name = current.name;
  if (input.name !== undefined) {
    const cleanedName = cleanName(input.name);
    if (!cleanedName) return fail("NAME_REQUIRED", "Give the role a name of up to 100 characters.");
    name = cleanedName;
  }

  const before = current.permissions.map((p) => auditGrant({ permission: p.permission as PermissionKey, scope: p.scope }));
  let nextGrants: CleanGrant[] = current.permissions.map((p) => ({ permission: p.permission as PermissionKey, scope: p.scope }));
  let nextKeys: string[] = current.permissions.map((p) => p.permission);
  const permissionsChanged = input.permissions !== undefined;
  if (input.permissions !== undefined) {
    const cleaned = cleanGrants(input.permissions);
    if (!cleaned.ok) return cleaned;
    const selfConflict = refuseSelfConflict(cleaned.keys);
    if (selfConflict) return selfConflict;
    const escalation = refuseEscalation(input.actor, cleaned.grants);
    if (escalation) return escalation;
    // You cannot widen the role you hold: that is granting yourself.
    const holdsIt = await db.userPermissionSet.findFirst({
      where: { organizationId: input.organizationId, userId: input.actorUserId, permissionSetId: input.permissionSetId },
      select: { userId: true },
    });
    if (holdsIt) return fail("OWN_ROLE", "You hold this role, so you cannot change what it grants. Ask another administrator.");
    nextGrants = cleaned.grants;
    nextKeys = [...cleaned.keys];
  }

  if (permissionsChanged) {
    const broken = await holdersBrokenBy(input.organizationId, input.permissionSetId, nextKeys);
    if (broken.length > 0) {
      return fail(
        "SEPARATION_CONFLICT",
        `${broken[0].conflict} This change would break that for ${broken.map((b) => b.name).join(", ")}.`,
        { holders: broken },
      );
    }
  }

  try {
    const set = await tenantTransaction(async (tx) => {
      // Conditional claim: the version is the lock, so two admins editing the
      // same role cannot both commit and leave one edit invisible.
      const claimed = await tx.permissionSet.updateMany({
        where: { id: input.permissionSetId, organizationId: input.organizationId, version: input.expectedVersion },
        data: {
          name,
          ...(input.description !== undefined ? { description: input.description?.trim() || null } : {}),
          version: { increment: 1 },
        },
      });
      if (claimed.count === 0) {
        throw new PermissionSetSentinel(
          fail("STALE_WRITE", "Somebody else changed this role while you were editing it. Reload and try again."),
        );
      }
      if (permissionsChanged) {
        await tx.permissionSetGrant.deleteMany({ where: { permissionSetId: input.permissionSetId } });
        await tx.permissionSetGrant.createMany({
          data: nextGrants.map((g) => ({
            organizationId: input.organizationId,
            permissionSetId: input.permissionSetId,
            permission: g.permission,
            scope: g.scope,
          })),
        });
      }
      return tx.permissionSet.findFirstOrThrow({
        where: { id: input.permissionSetId, organizationId: input.organizationId },
        select: PERMISSION_SET_SELECT,
      });
    });

    await writeAudit({
      organizationId: input.organizationId,
      actorUserId: input.actorUserId,
      action: "UPDATE",
      entityId: input.permissionSetId,
      changes: {
        name,
        ...(permissionsChanged ? { permissionsBefore: before, permissionsAfter: nextGrants.map(auditGrant) } : {}),
        ip: input.ip ?? null,
      },
    });
    apiLogger.info({
      msg: "permissions:role-updated",
      organizationId: input.organizationId,
      permissionSetId: input.permissionSetId,
      permissionsChanged,
    });
    return { ok: true, set };
  } catch (err) {
    if (err instanceof PermissionSetSentinel) return err.failure;
    if (isUniqueNameViolation(err)) return fail("DUPLICATE_NAME", `There is already a role called "${name}".`);
    apiLogger.error({ err, msg: "permissions:role-update-failed", permissionSetId: input.permissionSetId });
    return fail("UNKNOWN", "Could not save the role.");
  }
}

/**
 * Archive or restore. Archiving is how access is withdrawn from EVERYONE
 * holding the role at once, so it is deliberately allowed while people hold it
 * — the count comes back so the screen can say how many were just affected.
 * Roles are never deleted: an assignment that existed has to stay explicable.
 */
export async function setPermissionSetArchived(input: {
  organizationId: string;
  actorUserId: string;
  permissionSetId: string;
  archived: boolean;
  ip?: string | null;
}): Promise<PermissionSetResult & { holderCount?: number }> {
  const current = await db.permissionSet.findFirst({
    where: { id: input.permissionSetId, organizationId: input.organizationId },
    select: { id: true, name: true, isSystem: true, archivedAt: true, _count: { select: { holders: true } } },
  });
  if (!current) return fail("NOT_FOUND", "That role no longer exists.");
  if (current.isSystem) return fail("SYSTEM_ROLE", "A system role cannot be archived.");

  try {
    const claimed = await db.permissionSet.updateMany({
      where: { id: input.permissionSetId, organizationId: input.organizationId },
      data: { archivedAt: input.archived ? new Date() : null, version: { increment: 1 } },
    });
    if (claimed.count === 0) return fail("NOT_FOUND", "That role no longer exists.");
    const set = await db.permissionSet.findFirstOrThrow({
      where: { id: input.permissionSetId, organizationId: input.organizationId },
      select: PERMISSION_SET_SELECT,
    });
    await writeAudit({
      organizationId: input.organizationId,
      actorUserId: input.actorUserId,
      action: "UPDATE",
      entityId: input.permissionSetId,
      changes: { name: current.name, archived: input.archived, holderCount: current._count.holders, ip: input.ip ?? null },
    });
    apiLogger.info({
      msg: input.archived ? "permissions:role-archived" : "permissions:role-restored",
      organizationId: input.organizationId,
      permissionSetId: input.permissionSetId,
      holderCount: current._count.holders,
    });
    return { ok: true, set, holderCount: current._count.holders };
  } catch (err) {
    apiLogger.error({ err, msg: "permissions:role-archive-failed", permissionSetId: input.permissionSetId });
    return fail("UNKNOWN", "Could not change the role.");
  }
}

/** The ids of the un-archived roles this person holds, for the assignment picker. */
export async function readUserPermissionSetIds(organizationId: string, userId: string): Promise<string[]> {
  const held = await db.userPermissionSet.findMany({
    where: { organizationId, userId, permissionSet: { archivedAt: null } },
    select: { permissionSetId: true },
  });
  return held.map((h) => h.permissionSetId);
}

/**
 * Replaces the set of roles tagged on a person (D1, D2).
 *
 * REPLACE-ALL, not add-and-remove: the screen shows every role with a tick box,
 * so what it sends IS the answer, and a diff-based API would let a stale tab
 * re-add a role the admin had just removed.
 */
export async function setUserPermissionSets(input: {
  organizationId: string;
  actorUserId: string;
  userId: string;
  permissionSetIds: readonly string[];
  /** The person assigning: never themselves, never a role wider than their own (plan §7.4). */
  actor: Principal;
  ip?: string | null;
}): Promise<{ ok: true; permissionSetIds: string[]; permissions: string[] } | PermissionSetFailure> {
  const wanted = [...new Set(input.permissionSetIds)];
  if (input.userId === input.actorUserId) {
    return fail("OWN_ROLE", "You cannot change your own roles. Ask another administrator.");
  }

  const sets = wanted.length
    ? await db.permissionSet.findMany({
        where: { organizationId: input.organizationId, id: { in: wanted } },
        select: { id: true, name: true, isSystem: true, archivedAt: true, permissions: { select: { permission: true, scope: true } } },
      })
    : [];
  if (sets.length !== wanted.length) {
    return fail("NOT_FOUND", "One of those roles no longer exists. Reload and try again.");
  }
  const system = sets.find((s) => s.isSystem);
  if (system) {
    return fail("SYSTEM_ROLE", `"${system.name}" is a system role: it is held through a person's base role, not assigned.`, {
      permissionSetId: system.id,
    });
  }
  // Assigning a role is granting it: bounded by the assigner's own access.
  for (const set of sets) {
    const escalation = refuseEscalation(
      input.actor,
      set.permissions.map((p) => ({ permission: p.permission as PermissionKey, scope: p.scope })),
    );
    if (escalation) return { ...escalation, meta: { ...(escalation.meta ?? {}), permissionSetId: set.id, role: set.name } };
  }
  const archived = sets.find((s) => s.archivedAt !== null);
  if (archived) {
    return fail("ARCHIVED", `"${archived.name}" is archived and cannot be given to anyone. Restore it first.`, {
      permissionSetId: archived.id,
    });
  }

  // The person's own authority, which rule 1 is about. `User` is read to
  // establish identity and carries no policy, so this read needs no lane.
  const person = await db.user.findFirst({
    where: { id: input.userId, organizationId: input.organizationId },
    select: {
      firstName: true,
      lastName: true,
      email: true,
      procurementApproveUnlimited: true,
      procurementRequest: true,
      procurementSettle: true,
    },
  });
  if (!person) return fail("NOT_FOUND", "That team member no longer exists.");

  const permissions = unionPermissions(sets);
  const conflicts = separationConflicts({
    permissions,
    approvalUnlimited: person.procurementApproveUnlimited,
    legacyRequest: person.procurementRequest,
    legacySettle: person.procurementSettle,
  });
  if (conflicts.length > 0) {
    return fail("SEPARATION_CONFLICT", conflicts[0].message, { conflicts });
  }

  const before = await readUserPermissionSetIds(input.organizationId, input.userId);

  try {
    await tenantTransaction(async (tx) => {
      await tx.userPermissionSet.deleteMany({ where: { organizationId: input.organizationId, userId: input.userId } });
      if (wanted.length > 0) {
        await tx.userPermissionSet.createMany({
          data: wanted.map((permissionSetId) => ({
            organizationId: input.organizationId,
            userId: input.userId,
            permissionSetId,
            assignedById: input.actorUserId,
          })),
        });
      }
    });
  } catch (err) {
    apiLogger.error({ err, msg: "permissions:assignment-failed", targetUserId: input.userId });
    return fail("UNKNOWN", "Could not save the roles for this person.");
  }

  const added = wanted.filter((id) => !before.includes(id));
  const removed = before.filter((id) => !wanted.includes(id));
  // On the PERSON, because "what can this colleague do" is answered from their
  // trail, not from the role's.
  await writeAudit({
    organizationId: input.organizationId,
    actorUserId: input.actorUserId,
    action: "UPDATE",
    entityType: "User",
    entityId: input.userId,
    changes: {
      permissionSetsBefore: before,
      permissionSetsAfter: wanted,
      permissionSetsAdded: added,
      permissionSetsRemoved: removed,
      ip: input.ip ?? null,
    },
  });
  apiLogger.info({
    msg: "permissions:roles-assigned",
    organizationId: input.organizationId,
    targetUserId: input.userId,
    added: added.length,
    removed: removed.length,
  });

  return { ok: true, permissionSetIds: wanted, permissions };
}

/**
 * The people who would break a separation rule if this role carried `nextKeys`.
 *
 * Each holder is judged on the union they would END UP with: their other
 * un-archived roles, plus the proposed set, plus the legacy columns.
 */
async function holdersBrokenBy(
  organizationId: string,
  permissionSetId: string,
  nextKeys: readonly string[],
): Promise<{ name: string; conflict: string }[]> {
  const holders = await db.userPermissionSet.findMany({
    where: { organizationId, permissionSetId },
    select: {
      user: {
        select: {
          firstName: true,
          lastName: true,
          email: true,
          procurementApproveUnlimited: true,
          procurementRequest: true,
          procurementSettle: true,
          permissionSets: {
            where: { permissionSet: { archivedAt: null } },
            select: { permissionSetId: true, permissionSet: { select: { permissions: { select: { permission: true } } } } },
          },
        },
      },
    },
  });

  const broken: { name: string; conflict: string }[] = [];
  for (const { user } of holders) {
    const others = user.permissionSets
      .filter((held) => held.permissionSetId !== permissionSetId)
      .map((held) => held.permissionSet);
    const conflicts = separationConflicts({
      permissions: [...new Set([...unionPermissions(others), ...nextKeys])],
      approvalUnlimited: user.procurementApproveUnlimited,
      legacyRequest: user.procurementRequest,
      legacySettle: user.procurementSettle,
    });
    if (conflicts.length > 0) {
      broken.push({ name: `${user.firstName} ${user.lastName}`.trim() || user.email, conflict: conflicts[0].message });
    }
  }
  return broken;
}

/** One audit shape for every role change, so the Activity page reads consistently. */
async function writeAudit(input: {
  organizationId: string;
  actorUserId: string;
  action: string;
  entityId: string;
  entityType?: string;
  changes: Record<string, unknown>;
}): Promise<void> {
  // Fire-and-forget with a logged catch: the change it describes has already
  // committed, so an audit blip must not turn a successful save into a 500.
  try {
    await db.auditLog.create({
      data: {
        userId: input.actorUserId,
        organizationId: input.organizationId,
        action: input.action,
        entityType: input.entityType ?? "PermissionSet",
        entityId: input.entityId,
        changes: input.changes as never,
      },
    });
  } catch (err) {
    apiLogger.error({ err, msg: "permissions:audit-write-failed", entityId: input.entityId });
  }
}

/**
 * How many LIVE roles each person in the organisation holds, keyed by user id.
 *
 * Archived roles are excluded: archiving is how an administrator takes a role
 * out of use, so counting one would keep its former holders looking granted.
 * Somebody holding none is ABSENT from the map rather than present as 0, so the
 * caller's `?? 0` is the single place that default lives.
 *
 * Runs inside the caller's lane like every read in this file.
 */
export async function readPermissionSetHolderCounts(
  organizationId: string,
): Promise<Record<string, number>> {
  const rows = await db.userPermissionSet.groupBy({
    by: ["userId"],
    where: { organizationId, permissionSet: { archivedAt: null } },
    _count: { _all: true },
  });
  return Object.fromEntries(rows.map((row) => [row.userId, row._count._all]));
}
