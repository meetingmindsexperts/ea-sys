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

export type CrmDealContactRole =
  | "PRIMARY"
  | "PROCUREMENT"
  | "MARKETING"
  | "TECHNICAL"
  | "INFLUENCER"
  | "OTHER";

/**
 * A BUSINESS contact — pharma rep, exhibitor sales, procurement.
 *
 * NOT the event `Contact` (HCPs). Those are a different table and a different
 * population, because every event Contact is mirrored to the external HCP
 * marketing list and a rep must never land there.
 */
export interface CrmContactRow {
  id: string;
  firstName: string;
  lastName: string;
  email: string;
  jobTitle?: string | null;
  phone?: string | null;
  country?: string | null;
  lifecycleStage?: CrmLifecycleStage | null;
  company?: { id: string; name: string } | null;
  /** Non-null when this rep is ALSO in the event contact store (i.e. they attend). */
  contactId?: string | null;
  archivedAt?: string | null;
  createdAt: string;
  _count?: { deals: number };
}

/** Full CRM contact, as returned by GET /api/crm/contacts/[id]. */
export interface CrmContactDetail extends CrmContactRow {
  notes?: string | null;
  /** The linked EVENT contact (they also attend), if any. */
  contact?: { id: string; firstName: string; lastName: string; email: string } | null;
  deals: Array<{
    role: CrmDealContactRole;
    deal: {
      id: string;
      name: string;
      dealValue?: string | number | null;
      currency: string;
      status: CrmDealStatus;
      event?: { id: string; name: string } | null;
    };
  }>;
}

/**
 * One resolved recipient of a sponsor-prospectus send: a de-duplicated business
 * contact reached through an event's non-lost deals. `dealCount` is how many of
 * that event's deals this person is on (they're emailed once regardless).
 */
export interface SponsorRecipient {
  crmContactId: string;
  firstName: string;
  lastName: string;
  email: string;
  companyName: string | null;
  dealCount: number;
}

/** A person on a deal, with the role they play on THAT deal. */
export interface CrmDealContactRef {
  role: CrmDealContactRole;
  crmContact: {
    id: string;
    firstName: string;
    lastName: string;
    email: string;
    jobTitle?: string | null;
    phone?: string | null;
  };
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
  archivedAt?: string | null;
  createdAt: string;
  company?: { id: string; name: string } | null;
  contacts?: CrmDealContactRef[];
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
  archivedAt?: string | null;
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
  archivedAt?: string | null;
  owner?: CrmPersonRef | null;
  deal?: { id: string; name: string } | null;
  company?: { id: string; name: string } | null;
  crmContact?: { id: string; firstName: string; lastName: string } | null;
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

// ── Change log (system activity) ──────────────────────────────────────────────
// Distinct from CrmNoteRow: a NOTE is a human writing "I called them"; a
// CrmActivityRow is a system record of create / edit / archive / stage-move etc.

export type CrmActivityEntityType = "DEAL" | "COMPANY" | "CONTACT" | "TASK";

/** One field's before→after, as stored in `changes.changes[field]`. */
export interface CrmFieldChange {
  from: string | number | boolean | null;
  to: string | number | boolean | null;
}

export interface CrmActivityChanges {
  source?: string;
  /** Field-level diff for UPDATE rows. */
  changes?: Record<string, CrmFieldChange>;
  /** Free-form extras (snapshot on ARCHIVE, stage names on STAGE_MOVE, …). */
  [k: string]: unknown;
}

export interface CrmActivityRow {
  id: string;
  entityType: CrmActivityEntityType;
  entityId: string;
  action: string;
  changes: CrmActivityChanges | null;
  createdAt: string;
  actor?: { id: string; firstName: string; lastName: string } | null;
}

// ── Display ──────────────────────────────────────────────────────────────────

/** Exhaustive Records — TS fails the build if a new enum value has no mapping. */
export const DEAL_CONTACT_ROLE_LABELS: Record<CrmDealContactRole, string> = {
  PRIMARY: "Primary",
  PROCUREMENT: "Procurement",
  MARKETING: "Marketing",
  TECHNICAL: "Technical",
  INFLUENCER: "Influencer",
  OTHER: "Other",
};

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

// ── Change-log display ────────────────────────────────────────────────────────

/** Human verb for each activity action. Unknown actions fall back to the raw code. */
export const CRM_ACTIVITY_ACTION_LABELS: Record<string, string> = {
  CREATE: "Created",
  UPDATE: "Edited",
  ARCHIVE: "Archived",
  RESTORE: "Restored",
  STAGE_MOVE: "Moved stage",
  WON: "Marked won",
  LOST: "Marked lost",
  COMPLETE: "Completed",
  REOPEN: "Reopened",
  CONTACT_ADDED: "Linked a contact",
  CONTACT_REMOVED: "Unlinked a contact",
  LINK_EVENT_CONTACT: "Linked to an event contact",
  UNLINK_EVENT_CONTACT: "Unlinked from the event contact",
  PROSPECTUS_SENT: "Prospectus emailed",
  EMAIL_SENT: "Email sent",
};

/**
 * Friendly labels for the fields we diff. Keys match the entity column names the
 * services pass to `diffFields`. Anything unmapped renders its raw key rather than
 * being hidden — a change you can't read is better than a change you can't see.
 */
export const CRM_FIELD_LABELS: Record<string, string> = {
  name: "Name",
  dealValue: "Value",
  currency: "Currency",
  expectedClose: "Expected close",
  companyId: "Company",
  eventId: "Event",
  ownerId: "Owner",
  industry: "Industry",
  website: "Website",
  country: "Country",
  city: "City",
  notes: "Notes",
  firstName: "First name",
  lastName: "Last name",
  email: "Email",
  jobTitle: "Job title",
  phone: "Phone",
  lifecycleStage: "Lifecycle",
  title: "Title",
  description: "Description",
  dueAt: "Due date",
  remindAt: "Reminder",
}

export function activityActionLabel(action: string): string {
  return CRM_ACTIVITY_ACTION_LABELS[action] ?? action;
}

export function fieldLabel(key: string): string {
  return CRM_FIELD_LABELS[key] ?? key;
}
