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

export interface ProcurementUserLike {
  role?: string | null;
  procurementRequest?: boolean | null;
  procurementApproveCeilingAed?: number | null;
  procurementApproveUnlimited?: boolean | null;
  procurementSettle?: boolean | null;
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
  if (!user?.role) return false;
  if (PROCUREMENT_READ_ROLES.has(user.role)) return true;
  return hasAnyProcurementGrant(user);
}

export function canAuthorBudgets(user: ProcurementUserLike | null | undefined): boolean {
  return !!user?.role && BUDGET_AUTHOR_ROLES.has(user.role);
}

export function canAdminProcurement(user: ProcurementUserLike | null | undefined): boolean {
  return !!user?.role && PROCUREMENT_ADMIN_ROLES.has(user.role);
}

export function canRequestProcurement(user: ProcurementUserLike | null | undefined): boolean {
  return user?.procurementRequest === true;
}

export function canSettleProcurement(user: ProcurementUserLike | null | undefined): boolean {
  return user?.procurementSettle === true;
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

/** May this person decide a subject worth `amountAed`? Inclusive at the ceiling. */
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
}

export function procurementGrantsFromRow(
  row: {
    procurementRequest?: boolean | null;
    procurementApproveCeilingAed?: unknown;
    procurementApproveUnlimited?: boolean | null;
    procurementSettle?: boolean | null;
  } | null | undefined,
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
  };
}
