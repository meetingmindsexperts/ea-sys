/**
 * CRM visibility — who may read the pipeline, who may own a deal, and who sees
 * the money on it.
 *
 * WHY THIS IS ITS OWN BOUNDARY (again).
 * The AGENTS.md rule says: if you're reaching for an existing predicate because
 * it's "close enough", that is the signal to write a new one. Four of this
 * codebase's visibility files exist precisely because "close enough" leaked
 * something. So, explicitly:
 *
 *   - `canViewContacts` is the closest cousin (staff + MEMBER, no ONSITE) — but
 *     it says nothing about DEAL OWNERSHIP or about redacting deal VALUES, both
 *     of which the CRM needs.
 *   - `FINANCE_ROLES` includes ONSITE and MEMBER. Reusing it for the board would
 *     hand a desk temp the sponsorship pipeline.
 *   - `denyReviewer` is a WRITE guard that blocks MEMBER — but MEMBER is exactly
 *     who we want READING the board (leadership).
 *
 * Owner decisions (CRM_MODULE_PLAN.md §9, locked July 14, 2026):
 *
 *   READ the board:   SUPER_ADMIN / ADMIN / ORGANIZER / MEMBER + API keys.
 *   OWN a deal:       SUPER_ADMIN / ADMIN / ORGANIZER only.
 *                     (MEMBER is read-only; ONSITE et al. can't see the CRM.)
 *   SEE deal VALUES:  everyone who can read the board EXCEPT MEMBER.
 *
 * That last one is the subtle one and is deliberate. MEMBER *is* finance-capable
 * elsewhere in EA-SYS (`FINANCE_ROLES` includes it, since desk staff record
 * payments). But MEMBER is also the role we hand to sponsor-side stakeholders —
 * and a sponsor holding a MEMBER account must not be able to read every RIVAL
 * sponsor's deal value off the board. This is the one place the existing finance
 * boundary is too generous, so the CRM narrows it rather than inheriting it.
 *
 * All three predicates fail closed: an unknown or absent role gets nothing.
 */
import { NextResponse } from "next/server";
import { apiLogger } from "@/lib/logger";

/** Roles that may READ the CRM (companies, deals board, tasks, notes). */
const CRM_READ_ROLES = new Set(["SUPER_ADMIN", "ADMIN", "ORGANIZER", "MEMBER"]);

/** Roles that may OWN a deal / be assigned a task — i.e. act, not just look. */
const CRM_STAFF_ROLES = new Set(["SUPER_ADMIN", "ADMIN", "ORGANIZER"]);

/**
 * True when the role may read the CRM at all.
 * `isApiKey` callers are admin-equivalent (org-scoped, admin-minted).
 */
export function canViewCrm(role: string | null | undefined, isApiKey = false): boolean {
  if (isApiKey) return true;
  return !!role && CRM_READ_ROLES.has(role);
}

/**
 * True when the role may own deals / be assigned tasks, and may write.
 * NOTE this excludes MEMBER — who can see the board but never act on it.
 */
export function canOwnDeals(role: string | null | undefined, isApiKey = false): boolean {
  if (isApiKey) return true;
  return !!role && CRM_STAFF_ROLES.has(role);
}

/**
 * True when the caller may see deal VALUES (money).
 *
 * Deliberately NOT `canViewFinance()` — see the header. MEMBER reads the board
 * with values redacted; `CrmDeal.value` is in FINANCIAL_KEYS so the existing
 * `redactFinancialFields()` machinery does the stripping unchanged.
 */
export function canViewDealValues(
  role: string | null | undefined,
  isApiKey = false,
): boolean {
  if (isApiKey) return true;
  return !!role && CRM_STAFF_ROLES.has(role);
}

/**
 * Returns a 403 if the caller may not read the CRM, else null.
 *
 * Logged HERE, not at the call site, so no route can forget to log its own
 * refusal (the payments-review M12 lesson). A restricted role probing the
 * sponsorship pipeline is exactly the line you want in /logs.
 *
 * Usage (after the `getOrgContext` null check):
 *   const denied = denyCrmAccess(ctx);
 *   if (denied) return denied;
 */
export function denyCrmAccess(ctx: {
  role: string | null;
  userId: string | null;
  fromApiKey: boolean;
}) {
  if (canViewCrm(ctx.role, ctx.fromApiKey)) return null;

  apiLogger.warn({
    msg: "auth-guard:crm-read-denied",
    role: ctx.role,
    userId: ctx.userId,
  });
  return NextResponse.json(
    { error: "The CRM is not available to your role", code: "CRM_FORBIDDEN" },
    { status: 403 },
  );
}

/**
 * Returns a 403 if the caller may not WRITE to the CRM (own deals, edit
 * companies, complete tasks), else null. MEMBER hits this — it can read the
 * board but never move a card.
 */
export function denyCrmWrite(ctx: {
  role: string | null;
  userId: string | null;
  fromApiKey: boolean;
}) {
  if (canOwnDeals(ctx.role, ctx.fromApiKey)) return null;

  apiLogger.warn({
    msg: "auth-guard:crm-write-denied",
    role: ctx.role,
    userId: ctx.userId,
  });
  return NextResponse.json(
    { error: "You do not have permission to modify CRM records", code: "CRM_WRITE_FORBIDDEN" },
    { status: 403 },
  );
}
