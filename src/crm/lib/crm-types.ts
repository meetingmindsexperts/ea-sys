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

/**
 * Sales-conversation status (Freshsales-style ladder). Distinct from
 * lifecycleStage (relationship depth) — a CHAMPION can still be in NEGOTIATION
 * on this year's deal. Order here IS the display order.
 */
export const CONTACT_STATUS_VALUES = [
  "NEW",
  "CONTACTED",
  "INTERESTED",
  "QUALIFIED",
  "NEGOTIATION",
  "WON",
  "LOST",
  "UNQUALIFIED",
] as const;
export type CrmContactStatus = (typeof CONTACT_STATUS_VALUES)[number];

/**
 * The currencies a deal can be priced in. ONE list — it was hardcoded in both
 * deal dialogs, so adding a currency meant editing two files (or worse, one).
 */
export const DEAL_CURRENCIES = ["USD", "AED", "EUR", "GBP", "SAR"] as const;

export interface CrmStage {
  id: string;
  name: string;
  sortOrder: number;
  isTerminal: boolean;
  /** WON/LOST for mapped terminal stages — what the deal state machine reads. */
  terminalOutcome?: "WON" | "LOST" | null;
}

/**
 * Where a NEW deal lands when the caller didn't pick a stage: the first open
 * (non-terminal) column, falling back to the first column at all. ONE home for
 * the rule (review R2-M10) — the create dialog and the MCP create tool used to
 * carry their own identical copies, owned by neither. The deals IMPORTER does
 * NOT use this: it refuses a pipeline with no open column instead of falling
 * back into a terminal one (R2 rider L14).
 */
export function defaultOpenStage<T extends { isTerminal: boolean }>(stages: T[]): T | null {
  return stages.find((s) => !s.isTerminal) ?? stages[0] ?? null;
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
  mobile?: string | null;
  country?: string | null;
  lifecycleStage?: CrmLifecycleStage | null;
  status?: CrmContactStatus | null;
  tags?: string[];
  /** Auto-computed on read from live deal involvement (deals-only formula). */
  score?: number;
  company?: { id: string; name: string } | null;
  /** The rep who owns this relationship — powers the "My contacts" filter. */
  owner?: CrmPersonRef | null;
  /** Non-null when this rep is ALSO in the event contact store (i.e. they attend). */
  contactId?: string | null;
  archivedAt?: string | null;
  createdAt: string;
  _count?: { deals: number };
}

/** Full CRM contact, as returned by GET /api/crm/contacts/[id]. */
export interface CrmContactDetail extends Omit<CrmContactRow, "score"> {
  notes?: string | null;
  /** Auto-computed score with its breakdown, so the page can explain the number. */
  score?: { openDealPoints: number; wonDealPoints: number; total: number };
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

// ── Products (catalog + deal line items) ──────────────────────────────────────

export type CrmProductSourceType = "IN_HOUSE" | "OUTSOURCED";

export const PRODUCT_SOURCE_LABELS: Record<CrmProductSourceType, string> = {
  IN_HOUSE: "In-House",
  OUTSOURCED: "Out-Sourced",
};

/** A catalog product/service. `price` is absent (redacted) for MEMBER. */
export interface CrmProductRow {
  id: string;
  name: string;
  sku?: string | null;
  category: string;
  source: CrmProductSourceType;
  /** Catalog list price — absent for MEMBER (finance-gated). */
  price?: string | number | null;
  currency: string;
  priceIncludesTax: boolean;
  sortOrder: number;
  archivedAt?: string | null;
  createdAt: string;
}

/** A product on a deal (line item). `unitPrice` is absent (redacted) for MEMBER. */
export interface CrmDealProductRow {
  id: string;
  crmProductId?: string | null;
  productName: string;
  category: string;
  sku?: string | null;
  /** Unit price set on the deal — absent for MEMBER (finance-gated). */
  unitPrice?: string | number | null;
  currency: string;
  quantity: number;
  createdAt: string;
}

/** True when a deal's line items span more than one currency (can't be summed). */
export function dealProductsMixedCurrency(lines: CrmDealProductRow[]): boolean {
  return new Set(lines.map((l) => l.currency)).size > 1;
}

/**
 * Sum of a deal's line items (unitPrice × quantity). Returns null when any price is
 * redacted (MEMBER) OR the lines span multiple currencies — a partial or cross-currency
 * sum would be a lie (mirrors formatDealValue's "redacted ≠ 0" posture). Callers render
 * "—" and, for the mixed-currency case, say so (see dealProductsMixedCurrency).
 */
export function sumDealProducts(lines: CrmDealProductRow[]): number | null {
  if (lines.length === 0) return 0;
  if (lines.some((l) => l.unitPrice === null || l.unitPrice === undefined)) return null;
  if (dealProductsMixedCurrency(lines)) return null;
  return lines.reduce((acc, l) => acc + Number(l.unitPrice ?? 0) * l.quantity, 0);
}

// ── Deal documents ────────────────────────────────────────────────────────────

export type CrmDealDocumentKind = "PROSPECTUS" | "OTHER";

/** A file held by a deal (the sponsorship prospectus / supporting PDFs). */
export interface CrmDealDocumentRow {
  id: string;
  kind: CrmDealDocumentKind;
  url: string;
  filename: string;
  label?: string | null;
  mimeType: string;
  size: number;
  createdAt: string;
  uploadedBy?: { firstName: string; lastName: string } | null;
}

/** An editable CRM email template (org-wide), as returned by /api/crm/email-templates. */
export interface CrmEmailTemplateRow {
  id: string;
  name: string;
  subject: string;
  /** HTML body fragment. */
  body: string;
  sortOrder: number;
  archivedAt?: string | null;
  createdAt: string;
  updatedAt: string;
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
  /** Present on the deal DETAIL fetch (not the board list) — the resolved stage. */
  stage?: { id: string; name: string; isTerminal: boolean };
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
  /**
   * Per-currency OPEN+WON deal totals (never summed across currencies).
   * ABSENT (not empty) when the server redacted money for a MEMBER — render "—".
   */
  dealTotals?: Array<{ currency: string; total: number }>;
  /** Derived: PRIMARY on the newest deal, else the newest company contact. */
  primaryContact?: CrmPersonRef | null;
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

// ── In-app notifications (the CRM bell) ──────────────────────────────────────
// The CRM's OWN feed — deliberately separate from the core Notification bell.
// `type` values: DEAL_ASSIGNED | DEAL_STAGE_MOVED | DEAL_WON | DEAL_LOST |
// TASK_ASSIGNED | TASK_DUE (a string so a new kind needs no client change).

export interface CrmNotificationRow {
  id: string;
  type: string;
  title: string;
  message: string;
  link?: string | null;
  isRead: boolean;
  createdAt: string;
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

export const CONTACT_STATUS_LABELS: Record<CrmContactStatus, string> = {
  NEW: "New",
  CONTACTED: "Contacted",
  INTERESTED: "Interested",
  QUALIFIED: "Qualified",
  NEGOTIATION: "Negotiation",
  WON: "Won",
  LOST: "Lost",
  UNQUALIFIED: "Unqualified",
};

/** Same palette rules as the deal board: emerald = good, rose = bad, sky = active. */
export const CONTACT_STATUS_COLORS: Record<CrmContactStatus, string> = {
  NEW: "bg-slate-100 text-slate-700 border-slate-200",
  CONTACTED: "bg-sky-100 text-sky-700 border-sky-200",
  INTERESTED: "bg-cyan-100 text-cyan-700 border-cyan-200",
  QUALIFIED: "bg-violet-100 text-violet-700 border-violet-200",
  NEGOTIATION: "bg-amber-100 text-amber-800 border-amber-200",
  WON: "bg-emerald-100 text-emerald-700 border-emerald-200",
  LOST: "bg-rose-100 text-rose-700 border-rose-200",
  UNQUALIFIED: "bg-zinc-100 text-zinc-600 border-zinc-200",
};

export const DEAL_STATUS_COLORS: Record<CrmDealStatus, string> = {
  OPEN: "bg-sky-100 text-sky-700 border-sky-200",
  WON: "bg-emerald-100 text-emerald-700 border-emerald-200",
  LOST: "bg-rose-100 text-rose-700 border-rose-200",
};

/**
 * Semantic CTA colours for the deals surfaces — colour carries the MEANING of an
 * action so the eye can tell "win", "lose", "reach out" and "archive" apart at a
 * glance, instead of a wall of identical grey outline buttons.
 *
 * Deliberately keyed to the SAME palette as DEAL_STATUS_COLORS above, so the user
 * learns it once: emerald = won/good, rose = lost/bad, sky/cerulean = the brand's
 * "reach out", amber = caution (archive is reversible, not destruction — the true
 * destructive red is reserved for the SUPER_ADMIN purge). Dark variants included
 * because the dashboard ships dark mode.
 *
 * Apply on top of the shadcn Button; `won`/`newDeal` are filled (strongest
 * intent), the rest tint the `variant="outline"` base.
 */
export const CRM_CTA = {
  /** Close-won — the celebratory terminal action. Filled emerald. */
  won: "bg-emerald-600 text-white shadow-sm hover:bg-emerald-700 focus-visible:ring-emerald-500 dark:bg-emerald-600 dark:hover:bg-emerald-500",
  /** Close-lost — a legitimate outcome, not destruction. Rose-tinted outline. */
  lost: "border-rose-300 text-rose-700 hover:bg-rose-50 hover:text-rose-800 dark:border-rose-900 dark:text-rose-300 dark:hover:bg-rose-950/60",
  /** Reach out (Email) — the brand's cerulean/sky "communication" tint. */
  email: "border-sky-300 text-sky-700 hover:bg-sky-50 hover:text-sky-800 dark:border-sky-900 dark:text-sky-300 dark:hover:bg-sky-950/60",
  /** Restore from archive — a positive, undo-the-hide action. Emerald outline. */
  restore: "border-emerald-300 text-emerald-700 hover:bg-emerald-50 hover:text-emerald-800 dark:border-emerald-900 dark:text-emerald-300 dark:hover:bg-emerald-950/60",
  /** Archive — caution, reversible. Amber outline (NOT the destructive red). */
  archive: "border-amber-300 text-amber-700 hover:bg-amber-50 hover:text-amber-800 dark:border-amber-900 dark:text-amber-400 dark:hover:bg-amber-950/60",
} as const;

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

/**
 * Sum of visible deal values in a column. Null when money is redacted; the
 * literal "Mixed currencies" when the column holds more than one currency —
 * adding AED to USD and stamping the result "$" would be a fabricated number
 * (CRM review H2, same rule as sumDealProducts).
 */
export function sumStageValue(deals: CrmBoardDeal[]): string | null {
  const visible = deals.filter((d) => d.dealValue !== null && d.dealValue !== undefined);
  if (visible.length === 0) return null;
  const currencies = new Set(visible.map((d) => d.currency || "USD"));
  if (currencies.size > 1) return "Mixed currencies";
  const total = visible.reduce((acc, d) => acc + Number(d.dealValue ?? 0), 0);
  return formatDealValue(total, [...currencies][0]!);
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
  PRODUCT_ADDED: "Added a product",
  PRODUCT_REMOVED: "Removed a product",
  DOCUMENT_ADDED: "Added a document",
  DOCUMENT_REMOVED: "Removed a document",
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
  mobile: "Mobile",
  lifecycleStage: "Lifecycle",
  status: "Status",
  tags: "Tags",
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
