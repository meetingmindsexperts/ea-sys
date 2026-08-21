/**
 * Tenant-aware user-by-email lookup (multi-tenancy item 6, the code half).
 *
 * WHY THIS EXISTS
 * ---------------
 * `User.email` is globally unique on master and per-tenant on the platform:
 * [prisma/platform/010-user-identity.sql](../../../prisma/platform/010-user-identity.sql)
 * drops `User_email_key` and creates `UNIQUE (organizationId, email)
 * NULLS NOT DISTINCT`, so the same address can be two independent accounts in
 * two tenants (docs/PLATFORM_DECISIONS.md §6).
 *
 * **Dropping an index cannot make application code fail loudly.** Prisma's
 * generated client still believes `email` is `@unique`, so every
 * `user.findUnique({ where: { email } })` in the codebase keeps compiling and
 * keeps running once the index is gone — it simply becomes ambiguous, returning
 * whichever tenant's row the planner reaches first. On the sign-in path that is
 * a cross-tenant login; on a collision check it is a phantom "email already in
 * use" caused by a different tenant; in `registrant-account.ts` it links a
 * registration to another tenant's account. Routing every by-email lookup
 * through here is what turns a silent ambiguity into a decision someone made.
 *
 * THE RULE, AND WHY THERE IS NO ENVIRONMENT FLAG
 * ----------------------------------------------
 * A tenant-scoped lookup matches **this tenant's row, or a tenant-less one,
 * preferring this tenant's**. That single rule is correct on both deployments
 * without a fork, because what differs between them is the DATA, not the code:
 *
 *   - **Master**: 113 of 126 accounts are org-null by design (the Aug 6 ruling
 *     in docs/IDENTITY_AND_ROLES.md §1 — external logins never inherit an org).
 *     They are served by the org-less branch. Team accounts are served by the
 *     org branch. Behaviour is identical to the previous global lookup, because
 *     email is still globally unique there, so exactly one branch can match.
 *   - **Platform**: every account carries an org, so the org branch does the
 *     work and the org-less branch is inert.
 *
 * A `PLATFORM_ORG_ID`-style fork was considered and rejected: it would make
 * identity semantics depend on a fifth env var, and forgetting it on the
 * platform fails OPEN — global lookups against a database that no longer
 * guarantees global uniqueness. That is the same shape as the `x-org-id` defect
 * the Aug 21 sweep found. This version cannot be misconfigured because there is
 * nothing to configure.
 *
 * A strict `{ organizationId, email }` was also rejected, and the reason is
 * worth stating because it looks like the obvious implementation: on master it
 * would miss every org-null row, i.e. **90% of accounts could no longer sign
 * in**. The org-less branch is not a convenience; it is what makes one rule
 * serve both deployments.
 *
 * THE ORDERING IS LOAD-BEARING
 * ----------------------------
 * At most two rows can match: one for this org (the composite unique) and one
 * org-less (`NULLS NOT DISTINCT` gives org-less rows global uniqueness among
 * themselves). `nulls: "last"` makes "the tenant's own wins" a property of the
 * query rather than of whichever row the planner happened to return first.
 * Without it the fallback would silently outrank the real account.
 *
 * `findFirst`, not `findUnique`, is deliberate: `findUnique` cannot express the
 * OR, so a call site that tries to keep the old shape does not compile.
 */

import type { Prisma, PrismaClient } from "@prisma/client";
import { db } from "@/lib/db";
import { normalizeHost, resolveTenantOrg } from "@/lib/tenant/resolver";

/**
 * Which accounts a by-email lookup may see.
 *
 * A discriminated union rather than a nullable org id, so "I know the tenant"
 * and "I am deliberately looking across tenants" cannot be confused — and the
 * second carries a `reason`, making every cross-tenant lookup greppable and
 * reviewable instead of being an omission nobody notices. Same shape as
 * `denyNonOperator`'s required `{ route }`.
 */
export type UserEmailScope =
  /** This tenant's account, falling back to a tenant-less one. */
  | { organizationId: string }
  /** Every tenant. Legitimate in a few places; each must say why. */
  | { unscoped: true; reason: string }
  /**
   * NO account, deliberately. The request could not be attributed to a tenant
   * on a deployment that says an unattributable request resolves nothing
   * (`TENANCY_ENFORCE_HOST=1`). Distinct from `unscoped`, and the distinction
   * is the whole point — see `scopeFromRequestHost`.
   */
  | { none: true; reason: string };

/**
 * Build a scope from a possibly-unresolved org id (e.g. the host resolver's
 * `{ orgId: string | null }`).
 *
 * `null` means the request could not be attributed to a tenant, which on master
 * is the ordinary unscoped case and on the platform only happens when
 * `TENANCY_ENFORCE_HOST` already rejected the host. Either way the honest
 * answer is a cross-tenant lookup with a stated reason, NOT a strict lookup for
 * org-less rows — those are different questions and conflating them is how a
 * team account stops being able to sign in.
 */
export function userEmailScope(
  organizationId: string | null | undefined,
  reasonIfUnresolved: string,
): UserEmailScope {
  return organizationId
    ? { organizationId }
    : { unscoped: true, reason: reasonIfUnresolved };
}

/**
 * The `where` fragment, exported for the few call sites that need to compose it
 * with other filters. Prefer `findUserByEmail` — it also carries the ordering,
 * which this fragment cannot.
 */
export function userEmailWhere(
  scope: UserEmailScope,
  email: string,
): Prisma.UserWhereInput {
  // Matches nothing, by construction — safe to compose with any other filter.
  if ("none" in scope) return { id: { in: [] } };
  if ("unscoped" in scope) return { email };
  return {
    email,
    OR: [{ organizationId: scope.organizationId }, { organizationId: null }],
  };
}

/**
 * Tenant-preferring order: this tenant's row before a tenant-less one.
 * Exported so a composing call site cannot silently drop it.
 */
export const USER_EMAIL_ORDER_BY: Prisma.UserOrderByWithRelationInput = {
  organizationId: { sort: "asc", nulls: "last" },
};

/** Accepts the singleton, the operator lane, or a transaction client. */
type UserLookupClient = Pick<PrismaClient, "user"> | Prisma.TransactionClient;

/**
 * Find one user by email within a scope.
 *
 * ```ts
 * const { orgId } = await resolveTenantOrg(normalizeHost(req.headers.get("host")));
 * const user = await findUserByEmail(
 *   userEmailScope(orgId, "sign-in: host did not resolve to a tenant"),
 *   email,
 *   { select: { id: true, passwordHash: true } },
 * );
 * ```
 */
export async function findUserByEmail<S extends Prisma.UserSelect>(
  scope: UserEmailScope,
  email: string,
  args: { select: S; client?: UserLookupClient },
): Promise<Prisma.UserGetPayload<{ select: S }> | null> {
  // No tenant, on a deployment that says that means no account: answer without
  // touching the database. `userEmailWhere` returns a match-nothing filter for
  // the same case, so a composing call site is safe too.
  if ("none" in scope) return null;

  const client = args.client ?? db;
  return client.user.findFirst({
    where: userEmailWhere(scope, email),
    select: args.select,
    orderBy: USER_EMAIL_ORDER_BY,
  }) as Promise<Prisma.UserGetPayload<{ select: S }> | null>;
}

/**
 * The scope for a request whose tenant can only come from the front door.
 *
 * Sign-in and every token flow (password reset, email verification, invitation
 * acceptance) share one property: the thing the caller presents — a password, a
 * mailbox token — proves *who*, and cannot say *which tenant*. On the platform
 * the same address may be two accounts, so the tenant has to come from the host
 * the request arrived on. A reset link is clicked on the tenant's own domain,
 * which is exactly the signal needed.
 *
 * A helper rather than two lines at each call site, because the two lines
 * include `normalizeHost` — and a raw `Host` header carries a port, casing and
 * a possible trailing dot, so skipping it silently resolves nothing and falls
 * back to a cross-tenant lookup.
 */
export async function scopeFromRequestHost(
  req: Request | undefined,
  reasonIfUnresolved: string,
): Promise<UserEmailScope> {
  const { orgId, source } = await resolveTenantOrg(normalizeHost(req?.headers.get("host")));
  if (orgId) return { organizationId: orgId };

  // THE BRANCH THAT MATTERS, and it is not `orgId ? … : …`.
  //
  // The resolver returns a null org for two opposite reasons, and collapsing
  // them was a real defect — caught by driving the sandbox with a forged Host,
  // not by any test:
  //
  //   - `unscoped`      → master, no DEFAULT_ORG_ID. Legacy, org-unscoped
  //                       behaviour is CORRECT: 90% of its accounts carry no
  //                       org and must still sign in.
  //   - `unknown-enforced` → the platform, where an unrecognised Host is
  //                       defined to resolve NOTHING (404 semantics). Falling
  //                       back to a global lookup turns the one endpoint that
  //                       must be tenant-bound into a universal one: `Host:
  //                       evil.example` signed in fine against any tenant, so
  //                       removing a tenant's TenantDomain would not have
  //                       closed its front door. Not a privilege escalation —
  //                       the session still carries the caller's own org — but
  //                       it defeats the binding this whole change exists for.
  //
  // Host is attacker-controlled, so the enforcing deployment must fail CLOSED.
  if (source === "unknown-enforced") {
    return { none: true, reason: reasonIfUnresolved };
  }
  return { unscoped: true, reason: reasonIfUnresolved };
}

/**
 * Is this a unique-constraint violation (Prisma P2002)?
 *
 * Pairs with the scoped lookups above at every site that READS to decide
 * whether an address is taken and then WRITES. The read is not a guarantee —
 * two concurrent requests both pass it — so the constraint has to be allowed to
 * have the last word, and its refusal must come back as the same answer the
 * read would have given. Structural, not defensive: it is also what keeps the
 * response right when the deployment's uniqueness rule is narrower than the
 * scope the pre-check used.
 */
export function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    (err as { code?: unknown }).code === "P2002"
  );
}

