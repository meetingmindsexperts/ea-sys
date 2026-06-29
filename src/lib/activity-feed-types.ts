/**
 * Shared activity-feed types — the contract between the server builder
 * (`src/lib/activity-feed.ts`, which imports `db`/Prisma and is server-only)
 * and the client `ActivityTimelineCard`. Pure types, NO runtime imports, so a
 * client component can import them without pulling the server-only builder
 * into the browser bundle. Single source of truth (was previously declared in
 * both files and kept in sync by hand).
 */

export type ActivitySource = "speaker" | "registration";

export interface ActivityFieldDiff {
  field: string; // humanized label, e.g. "Payment status"
  before: string;
  after: string;
}

export interface ActivityItem {
  id: string;
  source: ActivitySource;
  kind: "audit" | "email" | "certificate";
  at: string; // ISO
  // audit
  action?: string;
  actor?: string | null;
  ipAddress?: string | null;
  /**
   * Field-level before→after changes for UPDATE entries, derived from the
   * audit row's `changes.before`/`changes.after`. Financial fields are
   * redacted for non-finance viewers. Empty/absent for non-UPDATE entries.
   */
  diffs?: ActivityFieldDiff[];
  // email
  subject?: string;
  to?: string;
  status?: string;
  templateSlug?: string | null;
  errorMessage?: string | null;
  // certificate
  serial?: string;
  certType?: string;
  pdfUrl?: string | null;
  revoked?: boolean;
}

export interface ActivityFeed {
  items: ActivityItem[];
  /** The linked counterpart entity, when one was resolved. */
  linked: { type: ActivitySource; id: string; linkedBy: "pointer" | "email" } | null;
}
