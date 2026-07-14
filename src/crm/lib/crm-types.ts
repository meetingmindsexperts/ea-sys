/**
 * Client-safe CRM types + display constants.
 *
 * No `db` import, no server-only modules — this file is imported by "use client"
 * components. (Pulling a Node builtin in here would bundle as `undefined` and the
 * symptom would be "the button does nothing, no logs" — see AGENTS.md.)
 *
 * `dealValue` is OPTIONAL on every deal shape on purpose: for a MEMBER the server
 * strips it (they read the board, not the money), so the UI must be able to render
 * a deal that has no value rather than assuming one is always present.
 */

export type CrmDealStatus = "OPEN" | "WON" | "LOST";
export type CrmTaskStatus = "OPEN" | "DONE";
export type CrmActivityType = "NOTE" | "CALL" | "MEETING";
export type CrmLifecycleStage = "LEAD" | "ENGAGED" | "CUSTOMER" | "CHAMPION";

export interface CrmStage {
  id: string;
  name: string;
  sortOrder: number;
  isTerminal: boolean;
}

export interface CrmPersonRef {
  id: string;
  firstName: string;
  lastName: string;
  email?: string;
}

export interface CrmBoardDeal {
  id: string;
  name: string;
  /** Absent for MEMBER — redacted server-side. Render "—", never assume a number. */
  dealValue?: string | number | null;
  currency: string;
  stageId: string;
  status: CrmDealStatus;
  expectedClose?: string | null;
  wonAt?: string | null;
  lostAt?: string | null;
  lostReason?: string | null;
  sponsorSyncedAt?: string | null;
  createdAt: string;
  company?: { id: string; name: string } | null;
  contact?: CrmPersonRef | null;
  event?: { id: string; name: string; slug: string } | null;
  owner?: CrmPersonRef | null;
  _count?: { tasks: number; notes: number };
}

export interface CrmCompanyRow {
  id: string;
  name: string;
  industry?: string | null;
  website?: string | null;
  country?: string | null;
  city?: string | null;
  needsReview: boolean;
  createdAt: string;
  _count?: { contacts: number; deals: number };
}

export interface CrmCompanyDetail extends CrmCompanyRow {
  notes?: string | null;
  contacts: Array<{
    id: string;
    firstName: string;
    lastName: string;
    email: string;
    jobTitle?: string | null;
    lifecycleStage?: CrmLifecycleStage | null;
  }>;
  deals: CrmBoardDeal[];
}

export interface CrmTaskRow {
  id: string;
  title: string;
  description?: string | null;
  dueAt?: string | null;
  remindAt?: string | null;
  status: CrmTaskStatus;
  completedAt?: string | null;
  owner?: CrmPersonRef | null;
  deal?: { id: string; name: string } | null;
  company?: { id: string; name: string } | null;
  contact?: { id: string; firstName: string; lastName: string } | null;
}

export interface CrmNoteRow {
  id: string;
  body: string;
  activityType: CrmActivityType;
  createdAt: string;
  updatedAt: string;
  authorId?: string | null;
  author?: { id: string; firstName: string; lastName: string } | null;
}

// ── Display ──────────────────────────────────────────────────────────────────

/** Exhaustive Records — TS fails the build if a new enum value has no mapping. */
export const ACTIVITY_TYPE_LABELS: Record<CrmActivityType, string> = {
  NOTE: "Note",
  CALL: "Call",
  MEETING: "Meeting",
};

export const LIFECYCLE_LABELS: Record<CrmLifecycleStage, string> = {
  LEAD: "Lead",
  ENGAGED: "Engaged",
  CUSTOMER: "Customer",
  CHAMPION: "Champion",
};

export const LIFECYCLE_COLORS: Record<CrmLifecycleStage, string> = {
  LEAD: "bg-slate-100 text-slate-700 border-slate-200",
  ENGAGED: "bg-sky-100 text-sky-700 border-sky-200",
  CUSTOMER: "bg-emerald-100 text-emerald-700 border-emerald-200",
  CHAMPION: "bg-amber-100 text-amber-800 border-amber-200",
};

export const DEAL_STATUS_COLORS: Record<CrmDealStatus, string> = {
  OPEN: "bg-sky-100 text-sky-700 border-sky-200",
  WON: "bg-emerald-100 text-emerald-700 border-emerald-200",
  LOST: "bg-rose-100 text-rose-700 border-rose-200",
};

export function personName(p?: CrmPersonRef | { firstName: string; lastName: string } | null): string {
  if (!p) return "Unassigned";
  return `${p.firstName} ${p.lastName}`.trim();
}

/**
 * Format a deal value. Returns null when the caller can't see money (MEMBER) —
 * callers render a muted "—" rather than a misleading "0".
 *
 * A redacted value and a genuinely-zero value are different facts and must not
 * look the same.
 */
export function formatDealValue(
  value: string | number | null | undefined,
  currency: string,
): string | null {
  if (value === null || value === undefined) return null;
  const n = typeof value === "string" ? Number(value) : value;
  if (!Number.isFinite(n)) return null;
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: currency || "USD",
    maximumFractionDigits: 0,
  }).format(n);
}

/** Sum of visible deal values in a column. Null when money is redacted. */
export function sumStageValue(deals: CrmBoardDeal[], currency = "USD"): string | null {
  const visible = deals.filter((d) => d.dealValue !== null && d.dealValue !== undefined);
  if (visible.length === 0) return null;
  const total = visible.reduce((acc, d) => acc + Number(d.dealValue ?? 0), 0);
  return formatDealValue(total, currency);
}
