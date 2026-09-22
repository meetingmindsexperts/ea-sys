/**
 * Budget & Procurement visibility predicates (Phase 1, Sep 14 2026).
 *
 * Lives in CORE, not in src/procurement/, for the reason hr-visibility.ts
 * records: the sidebar, the Settings → Users screen and the dashboard layout
 * all need these, and each would otherwise be an eslint exemption on the
 * one-way import boundary. Client-safe: no db, no Node imports.
 *
 * Capabilities are GRANTS on top of the primary role, never a new role (spec
 * §4). Reading is wide (org staff), writing is narrow (grants), and the
 * approver's authority is an AED ceiling checked at decision time. Every
 * predicate fails CLOSED on an unknown role or a missing grant.
 */

import type { PermissionKey } from "@/lib/permissions/catalogue";

export interface ProcurementUserLike {
  role?: string | null;
  procurementRequest?: boolean | null;
  procurementApproveCeilingAed?: number | null;
  procurementApproveUnlimited?: boolean | null;
  procurementSettle?: boolean | null;
  /**
   * Permission keys from the person's custom roles, the UNION across all of
   * them (docs/PROCUREMENT_ROLES_PLAN.md D2). OPTIONAL and additive: absent
   * means "not resolved here", never "holds nothing", so every caller that has
   * not been taught to load them keeps behaving exactly as it did.
   *
   * Every predicate below reads `permission OR today's rule`. That is the
   * transition shape on purpose: nobody's access changes when this ships, and
   * dropping the legacy arm is the separate, deliberate flip that §10a says
   * must come AFTER people have been assigned roles.
   */
  procurementPermissions?: readonly string[] | null;
}

/** Does this person hold `key` through one of their custom roles? */
function holds(user: ProcurementUserLike | null | undefined, key: PermissionKey): boolean {
  const keys = user?.procurementPermissions;
  return Array.isArray(keys) && keys.includes(key);
}

/** Org staff who read procurement data without any grant (spec §4: MEMBER is read-only). */
const PROCUREMENT_READ_ROLES = new Set(["SUPER_ADMIN", "ADMIN", "ORGANIZER", "MEMBER"]);
/** Event-scoped budget authoring: create, edit, submit, reallocate, close (spec §4). */
const BUDGET_AUTHOR_ROLES = new Set(["SUPER_ADMIN", "ADMIN", "ORGANIZER"]);
/** Module administration: templates, categories, workflow, reopening closed budgets. */
const PROCUREMENT_ADMIN_ROLES = new Set(["SUPER_ADMIN", "ADMIN"]);

export function hasAnyProcurementGrant(user: ProcurementUserLike | null | undefined): boolean {
  if (!user) return false;
  return (
    user.procurementRequest === true ||
    user.procurementSettle === true ||
    user.procurementApproveUnlimited === true ||
    (typeof user.procurementApproveCeilingAed === "number" && user.procurementApproveCeilingAed > 0)
  );
}

export function canViewProcurement(user: ProcurementUserLike | null | undefined): boolean {
  // Any procurement permission at all is enough to enter the module: the
  // per-screen keys decide what is visible once inside.
  if (Array.isArray(user?.procurementPermissions) && user.procurementPermissions.length > 0) return true;
  if (!user?.role) return false;
  if (PROCUREMENT_READ_ROLES.has(user.role)) return true;
  return hasAnyProcurementGrant(user);
}

export function canAuthorBudgets(user: ProcurementUserLike | null | undefined): boolean {
  // The gap this whole feature exists to close: every project manager is a
  // MEMBER, and a MEMBER authors nothing by role.
  if (holds(user, "procurement.budgets.create") || holds(user, "procurement.budgets.edit")) return true;
  return !!user?.role && BUDGET_AUTHOR_ROLES.has(user.role);
}

/**
 * MAY THIS PERSON ACT ON SOMEBODY ELSE'S SPEND REQUEST? That is the only thing
 * the name means at its eight call sites (edit, submit, amend, transition and
 * the quote writes all pass it as `isAdmin` to the service), so the permission
 * arm is `requests.manage` rather than a general "is an admin" key.
 *
 * The CATALOGUE is deliberately NOT this predicate. `denyNonProcurement`'s
 * `admin` need is the catalogue's alone and maps to `catalogue.manage` (D16);
 * reopening and unfreezing a budget went to `budgets.edit` (D15). One old
 * predicate, three meanings, now three keys.
 */
export function canAdminProcurement(user: ProcurementUserLike | null | undefined): boolean {
  if (holds(user, "procurement.requests.manage")) return true;
  return !!user?.role && PROCUREMENT_ADMIN_ROLES.has(user.role);
}

/**
 * Who links the organisation's accounting system (owner ruling, 22 September
 * 2026: "any admin can connect").
 *
 * ROLE ONLY, and deliberately narrower than `canAdminProcurement`: connecting
 * QuickBooks is platform administration, the same act as the Zoom, Stripe and
 * AI cards beside it on Settings → Integrations, which are all ADMIN and
 * SUPER_ADMIN. A custom role holding `procurement.requests.manage` manages
 * other people's requests; that says nothing about binding an accounting
 * system, so it does not admit here.
 *
 * Wider than the spec's "re-auth is a settle-grant button" (§8), on the
 * reasoning that a super admin can grant themselves the settle grant in two
 * clicks anyway, so excluding them bought no security and left a visible
 * Connect button that refused.
 */
export function canManageAccountingIntegration(user: ProcurementUserLike | null | undefined): boolean {
  return !!user?.role && PROCUREMENT_ADMIN_ROLES.has(user.role);
}

export function canRequestProcurement(user: ProcurementUserLike | null | undefined): boolean {
  if (holds(user, "procurement.requests.create")) return true;
  return user?.procurementRequest === true;
}

export function canSettleProcurement(user: ProcurementUserLike | null | undefined): boolean {
  if (holds(user, "procurement.budgets.signoff")) return true;
  return user?.procurementSettle === true;
}

/**
 * Who approves or rejects a proposed supplier: the settle holder, a super admin,
 * or the final approver (owner ruling, 15 September 2026). Wider than the settle
 * grant and narrower than admin: an ordinary admin or a banded approver does not
 * decide suppliers. Editing a supplier stays the settle holder's.
 */
export function canDecideSuppliers(user: ProcurementUserLike | null | undefined): boolean {
  if (!user) return false;
  if (holds(user, "procurement.suppliers.decide")) return true;
  return user.procurementSettle === true || user.role === "SUPER_ADMIN" || user.procurementApproveUnlimited === true;
}

const SUPPLIER_FINANCIALS_ROLES = new Set(["SUPER_ADMIN", "ADMIN", "ORGANIZER"]);

/**
 * Supplier tax numbers and bank details are classified (spec §2.9): they follow
 * the reimbursement boundary (SUPER_ADMIN, ADMIN, ORGANIZER) plus the settle
 * grant, whose holder approves suppliers on exactly those fields. Everyone
 * else reads the supplier with the two fields redacted. Fails closed.
 */
export function canViewSupplierFinancials(user: ProcurementUserLike | null | undefined): boolean {
  if (!user) return false;
  if (holds(user, "procurement.suppliers.financials.view")) return true;
  if (user.procurementSettle === true) return true;
  return !!user.role && SUPPLIER_FINANCIALS_ROLES.has(user.role);
}

/**
 * The AED ceiling this person may decide up to: `Infinity` for the final
 * approver, a positive number for a banded approver, `null` for no authority.
 * A ceiling of zero or below is no authority, not "approve nothing above zero".
 */
export function approvalCeilingAed(user: ProcurementUserLike | null | undefined): number | null {
  if (!user) return null;
  if (user.procurementApproveUnlimited === true) return Number.POSITIVE_INFINITY;
  const c = user.procurementApproveCeilingAed;
  return typeof c === "number" && Number.isFinite(c) && c > 0 ? c : null;
}

/**
 * May this person decide a subject worth `amountAed`? Inclusive at the ceiling.
 *
 * DELIBERATELY NO PERMISSION ARM, and this is a decision rather than an
 * oversight. `approvals.decide` says WHETHER somebody decides; the AED ceiling
 * says HOW MUCH, and D3 keeps the amount on the PERSON because two holders of
 * "PO Approver" approve to different limits. A permission arm here would read
 * as unlimited authority for anyone holding the key, which is exactly the
 * separation spec §4 forbids. The key is checked where the route asks for the
 * `approve` need; the ceiling is checked here.
 */
export function canApproveProcurement(
  user: ProcurementUserLike | null | undefined,
  amountAed: number,
): boolean {
  const ceiling = approvalCeilingAed(user);
  if (ceiling === null) return false;
  if (!Number.isFinite(amountAed) || amountAed < 0) return false;
  return amountAed <= ceiling;
}

/** Spec §8.8: the final approver never requests, so requester != approver can never leave a request with no approver. */
export function isFinalApproverHoldingRequestGrant(user: ProcurementUserLike | null | undefined): boolean {
  return user?.procurementApproveUnlimited === true && user?.procurementRequest === true;
}

/**
 * The four grant columns as the JWT and session carry them. Accepts a Prisma
 * row (Decimal ceiling), a token, or a partial: anything absent reads as "no
 * grant", and the ceiling becomes a plain number so the predicates above and
 * the client never see a Decimal.
 */
export interface ProcurementGrants {
  procurementRequest: boolean;
  procurementApproveCeilingAed: number | null;
  procurementApproveUnlimited: boolean;
  procurementSettle: boolean;
  /** Undefined when the caller did not select the person's custom roles. */
  procurementPermissions?: string[];
}

/**
 * The nested shape the two decision-time reads select: a person's live custom
 * roles, already filtered to the un-archived ones by the query.
 */
interface HeldPermissionSets {
  permissionSets?: ReadonlyArray<{ permissionSet: { permissions: ReadonlyArray<{ permission: string }> } }> | null;
}

/**
 * Flattens the nested rows into the union of permission keys.
 *
 * Returns `undefined` when the caller did not select them, which is the whole
 * transition contract: absent means "not resolved here", never "holds
 * nothing", so a caller that has not been taught to load permissions keeps
 * deciding exactly as it did.
 */
function permissionsFromRow(row: HeldPermissionSets | null | undefined): string[] | undefined {
  const held = row?.permissionSets;
  if (!Array.isArray(held)) return undefined;
  const keys = new Set<string>();
  for (const h of held) for (const { permission } of h.permissionSet.permissions) keys.add(permission);
  return [...keys];
}

export function procurementGrantsFromRow(
  row:
    | ({
        procurementRequest?: boolean | null;
        procurementApproveCeilingAed?: unknown;
        procurementApproveUnlimited?: boolean | null;
        procurementSettle?: boolean | null;
      } & HeldPermissionSets)
    | null
    | undefined,
): ProcurementGrants {
  const raw = row?.procurementApproveCeilingAed;
  const ceiling =
    raw === null || raw === undefined || raw === ""
      ? null
      : Number(typeof raw === "object" && raw !== null && "toString" in raw ? (raw as { toString(): string }).toString() : raw);
  return {
    procurementRequest: row?.procurementRequest === true,
    procurementApproveCeilingAed: ceiling !== null && Number.isFinite(ceiling) ? ceiling : null,
    procurementApproveUnlimited: row?.procurementApproveUnlimited === true,
    procurementSettle: row?.procurementSettle === true,
    // THE ONE FUNNEL. Both decision-time reads (approvals-service and
    // commitment-service) already call this mapper, so flattening here is what
    // makes the `permissionSets` select they now carry actually decide
    // something. Extending the two call sites separately would have been two
    // chances to drift.
    procurementPermissions: permissionsFromRow(row),
  };
}

/**
 * The AuditLog `entityType` values the Budget & Procurement module writes.
 * Anything in this set is governed by `canViewProcurement`, wherever it is
 * read from.
 *
 * WHY THIS EXISTS (Sep 15, 2026, owner: "keep budget activity separate from
 * event activity"). The module's services write their audit rows into the
 * shared `AuditLog` like everything else, and the org Activity page's Changes
 * tab rendered them between registrations and speakers as raw "CREATE
 * EventBudget" rows. Money movements are a different subject from event
 * operations, read by a different population, and they name their subject by
 * id rather than by a person's name, so the general describer cannot make
 * them readable. The HR module solved the same problem on Sep 3 with
 * `HR_AUDIT_ENTITY_TYPES`; this is the same shape.
 *
 * The default Changes query EXCLUDES this set; the Budget tab's
 * `?scope=procurement` query INCLUDES only it, behind the module flag and
 * `canViewProcurement`. The exclusion is the load-bearing half.
 *
 * `ApprovalRequest` is written by the CORE approvals primitive
 * (`src/lib/approvals/`), not by the module, but every subject it carries
 * today is a procurement subject (BUDGET, BUDGET_REALLOCATION,
 * SPEND_REQUEST). When a second consumer of the primitive arrives (HR leave
 * is the planned one), the row will need a subject-based split rather than an
 * entity-type one; until then it belongs here.
 *
 * KEPT IN SYNC BY A TEST: a source-level guard reads every `entityType: "..."`
 * literal under the module's roots and `src/lib/approvals/` and fails if one
 * is missing here.
 */
export const PROCUREMENT_AUDIT_ENTITY_TYPES = [
  "EventBudget",
  "BudgetLine",
  "BudgetRevenueLine",
  "ApprovalRequest",
  "SpendRequest",
  "Commitment",
  "Supplier",
  "BudgetProduct",
  "BudgetCategory",
  "BudgetTemplate",
] as const;

export type ProcurementAuditEntityType = (typeof PROCUREMENT_AUDIT_ENTITY_TYPES)[number];

const PROCUREMENT_AUDIT_ENTITY_TYPE_SET: ReadonlySet<string> = new Set(PROCUREMENT_AUDIT_ENTITY_TYPES);

/** Is this AuditLog entityType one the procurement boundary governs? */
export function isProcurementAuditEntityType(entityType: string): entityType is ProcurementAuditEntityType {
  return PROCUREMENT_AUDIT_ENTITY_TYPE_SET.has(entityType);
}
