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
  UserRound,
  CalendarCheck,
  CalendarRange,
  CalendarPlus,
  Flag,
  FileDown,
  type LucideIcon,
} from "lucide-react";
import { isHrAuditEntityType, type HrAuditEntityType } from "@/lib/hr-visibility";

/** Minimal AuditLog shape both feeds satisfy (global adds an `event` field). */
export interface AuditLogLike {
  action: string;
  entityType: string;
  entityId: string;
  changes: Record<string, unknown>;
  user: { firstName: string; lastName: string; email: string } | null;
}

/**
 * Labels for the HR entity types, as an EXHAUSTIVE Record: a type added to
 * `HR_AUDIT_ENTITY_TYPES` without a label here fails the build, which is the
 * house pattern (abstract-enums, session-enums) for "the UI cannot fall behind
 * the set". The HR tab's type filter is built from this.
 */
export const HR_AUDIT_ENTITY_LABELS: Record<HrAuditEntityType, string> = {
  Employee: "Employee",
  AttendanceEntry: "Attendance",
  AttendanceRule: "Standing rule",
  LeaveGrant: "Leave year roll",
  PublicHoliday: "Public holiday",
  HrAttendance: "Attendance export",
};

const HR_ENTITY_ICONS: Record<HrAuditEntityType, LucideIcon> = {
  Employee: UserRound,
  AttendanceEntry: CalendarCheck,
  AttendanceRule: CalendarRange,
  LeaveGrant: CalendarPlus,
  PublicHoliday: Flag,
  HrAttendance: FileDown,
};

const ENTITY_ICONS: Record<string, LucideIcon> = {
  Registration: UserPlus,
  Speaker: Mic,
  Session: Calendar,
  Hotel: Building2,
  TicketType: Ticket,
  Abstract: FileText,
  User: Users,
  Track: Tag,
  ...HR_ENTITY_ICONS,
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

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/**
 * "2026-03-12" → "12 Mar 2026". String arithmetic on purpose: HR calendar dates
 * are `YYYY-MM-DD` strings and must never pass through `new Date()`, which
 * answers in the reader's timezone and can move the day. Anything that is not
 * that shape is returned as-is rather than guessed at.
 */
function fmtCal(v: unknown): string {
  if (typeof v !== "string") return "—";
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v);
  if (!m) return v;
  const month = MONTHS[Number(m[2]) - 1];
  if (!month) return v;
  return `${Number(m[3])} ${month} ${m[1]}`;
}

function fmtRange(from: unknown, to: unknown): string {
  const f = fmtCal(from);
  const t = fmtCal(to);
  return f === t ? `on ${f}` : `${f} to ${t}`;
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/**
 * Descriptions for the HR module's audit rows. Every string here is built ONLY
 * from what the HR services chose to record (codes, dates, counts, scope). The
 * services deliberately never write a remark or a note body into the trail,
 * because free text about a person is where medical detail lands, so nothing
 * here can leak one either. Returns null for a shape it does not recognise and
 * the generic describer takes over.
 */
export function describeHrAuditAction(log: AuditLogLike): string | null {
  if (!isHrAuditEntityType(log.entityType)) return null;
  const c = (log.changes || {}) as Record<string, unknown>;

  switch (log.entityType) {
    case "Employee": {
      if (log.action === "CREATE") {
        const code = str(c.empCode);
        return `Employee added${code ? ` (${code})` : ""}`;
      }
      if (log.action === "UPDATE") return "Employee updated";
      if (log.action === "DELETE") return "Employee removed";
      return null;
    }
    case "AttendanceEntry": {
      if (log.action === "UPDATE") {
        const code = str(c.code) ?? "?";
        const days = num(c.days);
        const overwritten = Array.isArray(c.overwritten) ? c.overwritten.length : 0;
        const dayNote = days !== null && days > 1 ? ` (${days} days)` : "";
        const overNote = overwritten > 0 ? `, ${overwritten} overwritten` : "";
        return `Attendance recorded: ${code}, ${fmtRange(c.from, c.to)}${dayNote}${overNote}`;
      }
      if (log.action === "DELETE") {
        const removed = num(c.removed) ?? 0;
        return `Attendance cleared: ${removed} ${removed === 1 ? "day" : "days"}, ${fmtRange(c.from, c.to)}`;
      }
      return null;
    }
    case "AttendanceRule": {
      const verb =
        log.action === "CREATE" ? "added" : log.action === "DELETE" ? "removed" : null;
      if (!verb) return null;
      // A DELETE row written before the snapshot fix (Aug 31, 2026) carries
      // nulls for all of these. Say only what was recorded: "one person" for a
      // null scope would be a claim the trail never made.
      const parts: string[] = [];
      const code = str(c.code);
      if (code) parts.push(code);
      if (c.scope === "ORG") parts.push("company-wide");
      else if (c.scope === "EMPLOYEE") parts.push("one person");
      const start = str(c.startDate);
      const end = str(c.endDate);
      if (start) parts.push(end ? `from ${fmtCal(start)} to ${fmtCal(end)}` : `from ${fmtCal(start)}, open-ended`);
      return parts.length ? `Standing rule ${verb}: ${parts.join(", ")}` : `Standing rule ${verb}`;
    }
    case "LeaveGrant": {
      const year = num(c.toYear);
      const granted = num(c.granted) ?? 0;
      const skipped = num(c.skipped) ?? 0;
      const capped = Array.isArray(c.capped) ? c.capped.length : 0;
      const cappedNote = capped > 0 ? `, ${capped} capped` : "";
      return `Leave year ${year ?? "?"} carry-over: ${granted} granted, ${skipped} skipped${cappedNote}`;
    }
    case "PublicHoliday": {
      const verb =
        log.action === "CREATE" ? "added" : log.action === "DELETE" ? "removed" : null;
      if (!verb) return null;
      const label = str(c.label) ?? "holiday";
      return `Public holiday ${verb}: ${label}, ${fmtCal(c.date)}`;
    }
    case "HrAttendance": {
      // Written by `recordExport`: a CSV pull of attendance data. The row count
      // is what an operator asking "who took the register home" needs.
      const rows = num(c.rowCount);
      return `Attendance exported${rows !== null ? ` (${rows} ${rows === 1 ? "row" : "rows"})` : ""}`;
    }
  }
}

/** Human-readable description of an audit row. */
export function describeAuditAction(log: AuditLogLike): string {
  const hr = describeHrAuditAction(log);
  if (hr) return hr;

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
  if (log.action === "HONORARIUM_SET") {
    // { before, after } are { amount, currency } | null (speaker-honorarium route).
    const after = changes.after as { amount?: number; currency?: string } | null | undefined;
    return after?.amount ? `Honorarium set to ${after.currency} ${after.amount}` : "Honorarium cleared";
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
