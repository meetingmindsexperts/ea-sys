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

export const SPEAKER_STATUSES = new Set(["INVITED", "CONFIRMED", "DECLINED", "CANCELLED"]);
export const REGISTRATION_STATUSES = new Set(["PENDING", "CONFIRMED", "CANCELLED", "WAITLISTED", "CHECKED_IN"]);
export const MANUAL_REGISTRATION_STATUSES = new Set(["PENDING", "CONFIRMED", "WAITLISTED"]);
export const TITLE_VALUES = new Set(["DR", "MR", "MRS", "MS", "PROF"]);
export const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export const MAX_EMAIL_RECIPIENTS = 500;
