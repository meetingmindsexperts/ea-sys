/**
 * Custom-role permissions at request time, without carrying them in the
 * cookie (docs/CUSTOM_ROLES_PLAN.md §3.5, Phase 1 slice 3; ROADMAP "Session
 * cookie size" options 2 and 4).
 *
 * Until Oct 1, 2026 the JWT carried every permission KEY a person held, so the
 * cookie grew with every role (INC-006: one 12-key role pushed `Set-Cookie`
 * past nginx's 4k buffer). The token now carries only the held roles as
 * `[id, version]` pairs, a few dozen bytes per role however many keys it
 * grants, and the keys are resolved here.
 *
 * THE CACHE IS KEYED ON `id:version`, so it never needs invalidating: every
 * edit or archive bumps `PermissionSet.version`, the next token refresh reads
 * the new version, and the old entry is simply never asked for again. A miss
 * costs one indexed read for the missing roles only. Per process, bounded.
 *
 * Reads run INSIDE the tenant lane borrowed from the token's organisation: the
 * grant tables are policied, the auth path has no lane of its own, and a read
 * outside one returns nothing under RLS (silently withheld access).
 *
 * Server only.
 */
import { db } from "@/lib/db";
import { authLogger } from "@/lib/logger";
import { runWithTenant } from "@/lib/tenant-context";
import { isLivePermissionKey, type PermissionKey } from "./catalogue";

/** One held role as the token carries it. */
export type HeldSet = readonly [id: string, version: number];

const CACHE_LIMIT = 2_000;
const keysBySetVersion = new Map<string, readonly PermissionKey[]>();

const cacheKey = ([id, version]: HeldSet) => `${id}:${version}`;

/** Test seam: the cache is per process, so a test that edits a role resets it. */
export function clearSessionPermissionCache(): void {
  keysBySetVersion.clear();
}

/**
 * The person's live custom roles as `[id, version]`, for the token. Archived
 * and system roles are excluded: archiving withdraws access, and a system role
 * grants nothing from the database. Throws on a database error; the caller
 * decides what a failure means (the auth path keeps the cached pairs).
 */
export async function readHeldSets(organizationId: string, userId: string): Promise<HeldSet[]> {
  const rows = await runWithTenant(organizationId, () =>
    db.userPermissionSet.findMany({
      where: { organizationId, userId, permissionSet: { archivedAt: null, isSystem: false } },
      select: { permissionSet: { select: { id: true, version: true } } },
      orderBy: { permissionSetId: "asc" },
    }),
  );
  return rows.map((r) => [r.permissionSet.id, r.permissionSet.version] as const);
}

/**
 * The union of live permission keys across the held roles. Never throws: on a
 * failure it logs and answers with what it could resolve, and an empty set
 * leaves every predicate on its legacy arm, which is the access the person had
 * before custom roles existed (the same fail-safe the token path always had).
 */
export async function permissionsForHeldSets(
  organizationId: string | null | undefined,
  held: readonly HeldSet[] | null | undefined,
): Promise<PermissionKey[]> {
  if (!organizationId || !held || held.length === 0) return [];

  const missing = held.filter((h) => !keysBySetVersion.has(cacheKey(h)));
  if (missing.length > 0) {
    try {
      const rows = await runWithTenant(organizationId, () =>
        db.permissionSet.findMany({
          where: { organizationId, id: { in: missing.map(([id]) => id) } },
          select: { id: true, version: true, archivedAt: true, permissions: { select: { permission: true } } },
        }),
      );
      if (keysBySetVersion.size + rows.length > CACHE_LIMIT) keysBySetVersion.clear();
      for (const row of rows) {
        // An archived role grants nothing, whatever the token still says.
        const keys = row.archivedAt ? [] : row.permissions.map((p) => p.permission).filter(isLivePermissionKey);
        keysBySetVersion.set(cacheKey([row.id, row.version]), keys);
      }
    } catch (err) {
      authLogger.warn({ err, msg: "auth:permissions-resolve-failed", organizationId, missing: missing.length });
    }
  }

  const union = new Set<PermissionKey>();
  for (const h of held) for (const key of keysBySetVersion.get(cacheKey(h)) ?? []) union.add(key);
  return [...union];
}

/** Rough size of the cookie a token encodes to: JSON, encrypted and base64-encoded, is about 1.4 times its JSON. */
export const COOKIE_WARN_BYTES = 3_000;
export function estimatedCookieBytes(token: object): number {
  return Math.ceil(JSON.stringify(token).length * 1.4);
}
