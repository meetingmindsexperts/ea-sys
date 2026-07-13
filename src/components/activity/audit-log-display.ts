/**
 * Shared display helpers for raw AuditLog rows — used by BOTH the
 * event-dashboard activity feed (`components/activity-feed.tsx`) and the
 * org-wide global activity feed (`(dashboard)/activity/global-activity-feed.tsx`).
 * These two render the same AuditLog shape and previously kept identical copies
 * of the icon map, colour map, and the action-describe / actor-label functions;
 * this is the single source of truth. (Distinct from the per-person
 * `ActivityTimelineCard` + `lib/activity-feed.ts`, which is a different,
 * merged-timeline subsystem.)
 */
import {
  Activity,
  UserPlus,
  Mic,
  Calendar,
  Building2,
  Ticket,
  FileText,
  Users,
  Tag,
  type LucideIcon,
} from "lucide-react";

/** Minimal AuditLog shape both feeds satisfy (global adds an `event` field). */
export interface AuditLogLike {
  action: string;
  entityType: string;
  entityId: string;
  changes: Record<string, unknown>;
  user: { firstName: string; lastName: string; email: string } | null;
}

const ENTITY_ICONS: Record<string, LucideIcon> = {
  Registration: UserPlus,
  Speaker: Mic,
  Session: Calendar,
  Hotel: Building2,
  TicketType: Ticket,
  Abstract: FileText,
  User: Users,
  Track: Tag,
};

const ACTION_COLORS: Record<string, string> = {
  CREATE: "bg-green-100 text-green-700",
  UPDATE: "bg-blue-100 text-blue-700",
  DELETE: "bg-red-100 text-red-700",
  EMAIL_SENT: "bg-violet-100 text-violet-700",
  BULK_UPDATE: "bg-amber-100 text-amber-700",
};

/** Icon for an entity type, falling back to the generic Activity glyph. */
export function auditEntityIcon(entityType: string): LucideIcon {
  return ENTITY_ICONS[entityType] || Activity;
}

/** Tailwind colour classes for an action, falling back to neutral slate. */
export function auditActionColor(action: string): string {
  return ACTION_COLORS[action] || "bg-slate-100 text-slate-600";
}

/** Human-readable description of an audit row. */
export function describeAuditAction(log: AuditLogLike): string {
  const changes = log.changes || {};
  const source = changes.source as string | undefined;

  if (log.entityType === "Registration" && log.action === "CREATE") {
    const attendee = changes.attendee as
      | { firstName?: string; lastName?: string; email?: string }
      | undefined;
    const ticketType = (changes.ticketType as string) || "";
    const name = attendee
      ? `${attendee.firstName || ""} ${attendee.lastName || ""}`.trim()
      : "";
    const confirmId = (changes.confirmationNumber as string) || log.entityId;
    const shortId =
      confirmId.length > 12 ? `${confirmId.slice(0, 4)}...${confirmId.slice(-4)}` : confirmId;

    if (source === "public_registration") {
      return `${name || "Someone"} registered${ticketType ? ` as ${ticketType}` : ""} (${shortId})`;
    }
    return `Registration created for ${name || "attendee"}${ticketType ? ` — ${ticketType}` : ""} (${shortId})`;
  }

  if (log.action === "EMAIL_SENT") {
    const recipient = changes.recipient as string | undefined;
    return `Email sent to ${recipient || "recipient"}`;
  }
  if (log.action === "DELETE") return `${log.entityType} deleted`;
  if (log.action === "UPDATE") return `${log.entityType} updated`;
  if (log.action === "BULK_UPDATE") return `Bulk update on ${log.entityType}`;

  return `${log.action} ${log.entityType}`;
}

/**
 * WHO the row is about (as opposed to who did it) — pulled out of the `changes`
 * blob, which for the common `{ before, after }` update shape carries the full
 * row including the person's name.
 *
 * Without this, an admin scanning the feed sees forty rows of "Registration
 * updated" and cannot tell them apart. Returns null when the blob carries no
 * name (bulk summaries, deletes, config rows) — the caller then just omits it
 * rather than printing a placeholder.
 */
export function auditSubjectName(log: AuditLogLike): string | null {
  const c = (log.changes || {}) as Record<string, unknown>;
  // Prefer `after` (the state we moved to); fall back to `before` for deletes.
  const candidates = [c.after, c.before, c.deleted, c].filter(
    (x): x is Record<string, unknown> => !!x && typeof x === "object" && !Array.isArray(x),
  );

  for (const row of candidates) {
    // A registration's name lives on its nested attendee; a speaker's is inline.
    const holder =
      row.attendee && typeof row.attendee === "object" && !Array.isArray(row.attendee)
        ? (row.attendee as Record<string, unknown>)
        : row;
    const first = typeof holder.firstName === "string" ? holder.firstName : "";
    const last = typeof holder.lastName === "string" ? holder.lastName : "";
    const name = `${first} ${last}`.trim();
    if (name) return name;
    if (typeof holder.name === "string" && holder.name.trim()) return holder.name.trim();
    if (typeof holder.email === "string" && holder.email.trim()) return holder.email.trim();
  }
  return null;
}

/** Who performed the action (user name/email, or a synthetic source label). */
export function auditActorLabel(log: AuditLogLike): string {
  if (log.user) {
    return `${log.user.firstName} ${log.user.lastName}`.trim() || log.user.email;
  }
  const source = (log.changes as Record<string, unknown>)?.source;
  if (source === "public_registration") return "Public Registration";
  return "System";
}
