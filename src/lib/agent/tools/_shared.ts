// Shared types + constants for agent/MCP tool executors.
// Leaf module — must not import from any sibling tool file.

export interface AgentContext {
  eventId: string;
  organizationId: string;
  userId: string;
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

export const SPEAKER_STATUSES = new Set(["INVITED", "CONFIRMED", "DECLINED", "CANCELLED"]);
export const REGISTRATION_STATUSES = new Set(["PENDING", "CONFIRMED", "CANCELLED", "WAITLISTED", "CHECKED_IN"]);
export const MANUAL_REGISTRATION_STATUSES = new Set(["PENDING", "CONFIRMED", "WAITLISTED"]);
export const ALL_PAYMENT_STATUSES = new Set([
  "UNASSIGNED",
  "UNPAID",
  "PENDING",
  "PAID",
  "COMPLIMENTARY",
  "REFUNDED",
  "FAILED",
]);
export const TITLE_VALUES = new Set(["DR", "MR", "MRS", "MS", "PROF"]);
export const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export const MAX_EMAIL_RECIPIENTS = 500;
