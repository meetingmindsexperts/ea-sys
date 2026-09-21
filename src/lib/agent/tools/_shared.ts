// Shared types + constants for agent/MCP tool executors.
// Leaf module — must not import from any sibling tool file.
// (Importing the generated Prisma enum is fine — it's not a sibling tool.)

import { PaymentStatus } from "@prisma/client";

/**
 * Which door reached the executor. Stamped onto every audit row a tool
 * writes, directly or through a service, so the trail says who acted: the
 * in-app Event Agent ("agent") or an MCP client ("mcp"). Executors read
 * `ctx.source`; none hardcodes a door (readiness gap G5: the agent's own
 * actions used to be recorded as "mcp").
 */
export type AgentSource = "agent" | "mcp";

export interface AgentContext {
  eventId: string;
  organizationId: string;
  userId: string;
  source: AgentSource;
  /** `creates` counts every write tool call in the request (see isWriteTool). */
  counters: { creates: number; emailsSent: number };
}

export type ToolExecutor = (
  input: Record<string, unknown>,
  ctx: AgentContext
) => Promise<unknown>;

/**
 * Whether a tool is read-only (safe for the MEMBER viewer role).
 *
 * FAIL CLOSED: only tools whose name starts with `list_`, `get_`, or
 * `search_` are considered read-only. Every other tool — create_ /
 * update_ / delete_ / add_ / remove_ / replace_ / assign_ / unassign_ /
 * submit_ / check_in_ / send_ / cancel_ / bulk_ / upsert_ AND any future
 * tool that doesn't match the read prefixes — is treated as a write and
 * refused for read-only roles. New tools are denied by default until
 * proven safe, which is the correct security posture for an
 * authorization boundary.
 */
export function isReadOnlyTool(toolName: string): boolean {
  return /^(list_|get_|search_)/.test(toolName);
}

/**
 * Tools that are not reads but write nothing either: research_sponsor
 * scrapes a public website and returns what it found. They stay refused
 * for read-only roles (isReadOnlyTool is the authorization boundary and
 * fails closed) but do not count against the per-request write cap. A
 * tool is in this set only by being named here; a tool that is neither a
 * read nor listed is a write until proven otherwise.
 */
export const NON_MUTATING_NON_READ_TOOLS = new Set(["research_sponsor"]);

/**
 * Whether a tool changes data. Derived from the read-only predicate rather
 * than a hand-written list: the route's list of 14 names missed 11 write
 * tools (the session roster edits, update_session, Zoom meeting creation,
 * the certificate-template and review-criterion writes, CME settings), so
 * those never counted against the write cap (readiness gap G2).
 */
export function isWriteTool(toolName: string): boolean {
  if (isReadOnlyTool(toolName)) return false;
  return !NON_MUTATING_NON_READ_TOOLS.has(toolName);
}

/**
 * Tools that return the dinner-RSVP guest list (names, emails, dietary
 * notes) — refused for MEMBER even though they are list_-prefixed
 * (review R2 M5). The roster GET deliberately blocks MEMBER via
 * denyReviewer (Round-1 H2: the read-only sponsor-side observer must not
 * read the confidential VIP guest list); the agent surface must agree
 * with that policy, not tunnel around it.
 */
export const ROSTER_PII_AGENT_TOOLS = new Set(["list_rsvps"]);

export const SPEAKER_STATUSES = new Set(["INVITED", "CONFIRMED", "DECLINED", "CANCELLED"]);
export const REGISTRATION_STATUSES = new Set(["PENDING", "CONFIRMED", "CANCELLED", "WAITLISTED", "CHECKED_IN"]);
export const MANUAL_REGISTRATION_STATUSES = new Set(["PENDING", "CONFIRMED", "WAITLISTED"]);
// Derived from the generated Prisma enum so it CANNOT drift. The previous
// hardcoded list was missing INCLUSIVE (added with the sponsor-paid
// feature), so the update_registration / bulk_update_registration_status
// guards rejected INCLUSIVE as invalid and the INCLUSIVE-handling code
// downstream was unreachable — the agent could never set a registration
// to sponsor-paid. Every future PaymentStatus value is now included
// automatically.
export const ALL_PAYMENT_STATUSES = new Set<string>(
  Object.values(PaymentStatus),
);
// Admin-settable subset for WRITE paths (review H12). PENDING / REFUNDED /
// FAILED are owned by the Stripe webhook + the gated refund flow — setting
// them as bare flags cooks the books (REFUNDED with refundedAmount 0, no
// credit note, no Payment flip, no audit). Reads/filters keep
// ALL_PAYMENT_STATUSES. Mirrors MANUAL_PAYMENT_STATUSES in
// registration-enums.ts (drift-guarded by a test).
export const ADMIN_SETTABLE_PAYMENT_STATUSES = new Set<string>([
  "UNASSIGNED",
  "UNPAID",
  "PAID",
  "COMPLIMENTARY",
  "INCLUSIVE",
]);
export const PAYMENT_STATUS_WRITE_REJECTION =
  "Stripe-driven paymentStatus values (PENDING/REFUNDED/FAILED) cannot be set directly — PENDING/FAILED are owned by the payment webhook, and refunds must go through the credit-note-gated refund flow (registration Billing tab / POST …/refund) so the money actually moves.";
export const TITLE_VALUES = new Set(["DR", "MR", "MRS", "MS", "PROF"]);
export const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export const MAX_EMAIL_RECIPIENTS = 500;
