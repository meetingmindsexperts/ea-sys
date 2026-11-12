import type { RegistrationCreatedSource } from "@prisma/client";
import { paidCardNote, summarizePaymentStatuses, type PaymentStatusSummary } from "@/lib/registration-payment-stats";

/**
 * The numbers on the Registrations page's summary card (owner report, Nov 12,
 * 2026, on the 4th GCC Hematology Hub: "these numbers are off").
 *
 * The card read Total 65 with Confirmed 27, Pending 37 and Checked In 0, which
 * add up to 64: the total counted a cancelled registration that no tile named.
 * It said nothing about where a registration came from either, so 38 rows a
 * colleague had typed in looked the same as 27 people who registered online.
 *
 * The rules, all in this one place:
 *   - Every number counts LIVE registrations: a cancelled one leaves the total
 *     and the paid count, and is named beside them, never hidden.
 *   - Total = confirmed + pending + checked in + waitlisted, always.
 *   - Where a registration came from is its `createdSource`, grouped into the
 *     few doors an organiser thinks in (online, staff, import, desk, agent).
 *   - Faculty is decided by the registration TYPE and nothing else: the
 *     built-in Faculty type (`TicketType.isFaculty`). The page splits its rows
 *     on that flag and passes each half here. An ordinary type that is merely
 *     NAMED "Faculty" or "Speaker" is a delegate type like any other, and
 *     `lookalikeFacultyTypes` exists to say so on the page. (An ordinary type
 *     named exactly "Faculty" does become the built-in one, by itself, the
 *     first time the event needs one, when it is free and holds no money:
 *     `ensureFacultyTicketType` in speaker-companion.ts. That cannot happen
 *     once the event has a built-in type, which is the case this flags.)
 *
 * Pure and client-safe: the page already holds the rows, so this costs no
 * request and no query.
 */

export type RegistrationSourceGroup = "online" | "staff" | "imported" | "desk" | "agent" | "speakers" | "unknown";

/** The order the groups are listed in. */
export const SOURCE_GROUP_ORDER: readonly RegistrationSourceGroup[] = ["online", "staff", "imported", "desk", "agent", "speakers", "unknown"];

export const SOURCE_GROUP_LABELS: Record<RegistrationSourceGroup, string> = {
  online: "registered online",
  staff: "added by staff",
  imported: "imported",
  desk: "walk-in at the desk",
  agent: "added by an agent or integration",
  speakers: "made for a speaker",
  unknown: "source not recorded",
};

// Keyed by the Prisma enum (a type-only import, so this stays client-safe): a
// source added to the enum will not compile until it is given a group here.
const SOURCE_GROUP: Record<RegistrationCreatedSource, RegistrationSourceGroup> = {
  PUBLIC_REGISTER: "online",
  PUBLIC_SUBMITTER: "online",
  PUBLIC_COMPLETION_FORM: "online",
  GROUP_REGISTER: "online",
  ADMIN_DASHBOARD: "staff",
  FACULTY_ADMIN: "staff",
  CSV_IMPORT: "imported",
  ONSITE_DESK: "desk",
  MCP_AGENT: "agent",
  SPEAKER_COMPANION: "speakers",
  OTHER: "unknown",
};

/** A row older than the column, or a value this build does not know, is "unknown", never dropped. */
export function sourceGroupOf(createdSource: string | null | undefined): RegistrationSourceGroup {
  if (!createdSource || !Object.hasOwn(SOURCE_GROUP, createdSource)) return "unknown";
  return SOURCE_GROUP[createdSource as RegistrationCreatedSource];
}

export interface RegistrationStatRow {
  status: string;
  paymentStatus: string;
  createdSource?: string | null;
  ticketType?: { id: string; name: string; isFaculty?: boolean | null } | null;
}

export interface RegistrationListStats extends PaymentStatusSummary {
  /** Live registrations: everything but cancelled. */
  total: number;
  confirmed: number;
  pending: number;
  checkedIn: number;
  waitlisted: number;
  /** Cancelled registrations, in no other number here. */
  cancelled: number;
  /** Cancelled registrations still marked paid: money held for a place that is gone. */
  cancelledPaid: number;
  /** Live registrations by the door they came through; only the groups that have any. */
  sources: { group: RegistrationSourceGroup; count: number }[];
  /** Live registrations by type, largest first; a registration with no type is listed last. */
  types: { id: string | null; name: string; count: number }[];
}

const NO_TYPE = "No type yet";

export function summarizeRegistrationRows(rows: ReadonlyArray<RegistrationStatRow>): RegistrationListStats {
  const live = rows.filter((r) => r.status !== "CANCELLED");
  const cancelled = rows.filter((r) => r.status === "CANCELLED");
  const count = (status: string) => live.filter((r) => r.status === status).length;

  const bySource = new Map<RegistrationSourceGroup, number>();
  const byType = new Map<string, { id: string | null; name: string; count: number }>();
  for (const row of live) {
    const group = sourceGroupOf(row.createdSource);
    bySource.set(group, (bySource.get(group) ?? 0) + 1);
    const key = row.ticketType?.id ?? "";
    const entry = byType.get(key) ?? { id: row.ticketType?.id ?? null, name: row.ticketType?.name ?? NO_TYPE, count: 0 };
    entry.count += 1;
    byType.set(key, entry);
  }

  return {
    total: live.length,
    confirmed: count("CONFIRMED"),
    pending: count("PENDING"),
    checkedIn: count("CHECKED_IN"),
    waitlisted: count("WAITLISTED"),
    cancelled: cancelled.length,
    cancelledPaid: cancelled.filter((r) => r.paymentStatus === "PAID").length,
    ...summarizePaymentStatuses(live),
    sources: SOURCE_GROUP_ORDER.filter((g) => bySource.has(g)).map((group) => ({ group, count: bySource.get(group) ?? 0 })),
    types: [...byType.values()].sort((a, b) => Number(a.id === null) - Number(b.id === null) || b.count - a.count || a.name.localeCompare(b.name)),
  };
}

/** "27 registered online · 38 added by staff", or null when there is nothing to say. */
export function sourcesLine(stats: Pick<RegistrationListStats, "sources">): string | null {
  if (stats.sources.length === 0) return null;
  return stats.sources.map((s) => `${s.count} ${SOURCE_GROUP_LABELS[s.group]}`).join(" · ");
}

/** "1 cancelled, not counted" and "2 waitlisted": what the three status tiles do not name. */
export function totalNote(stats: Pick<RegistrationListStats, "cancelled" | "waitlisted">): string | null {
  const parts: string[] = [];
  if (stats.waitlisted > 0) parts.push(`${stats.waitlisted} waitlisted`);
  if (stats.cancelled > 0) parts.push(`${stats.cancelled} cancelled, not counted`);
  return parts.length > 0 ? parts.join(" · ") : null;
}

/**
 * Ordinary types whose NAME says faculty or speaker. Pass DELEGATE rows only.
 *
 * An advisory only, never a rule: nothing is counted differently because of a
 * name, and what the page says about such a type (it is an ordinary type, its
 * people count as delegates) is true of every ordinary type. It is here
 * because the name is the whole confusion. Ten of 48 events on production
 * (Nov 12, 2026) held an ordinary "Faculty" or "Speaker" type, most often a
 * leftover from cloning before Jul 27, 2026, whose people count as delegates
 * while the page's own Faculty row counts only the built-in type. Wider than
 * the Registration Types page's note (exactly "Faculty", beside the built-in
 * type): that one explains two types of one name, this one a number.
 */
const FACULTY_LOOKALIKE = /\b(faculty|speakers?)\b/i;

export function lookalikeFacultyTypes(stats: Pick<RegistrationListStats, "types">): { id: string | null; name: string; count: number }[] {
  return stats.types.filter((t) => t.id !== null && FACULTY_LOOKALIKE.test(t.name));
}

/**
 * The line under Paid: the free and sponsor-paid counts (paidCardNote), plus
 * any cancelled registration still marked paid, which the count above leaves
 * out and an organiser needs to see: the money is held and the place is gone.
 */
export function paidNoteOf(stats: PaymentStatusSummary & Pick<RegistrationListStats, "cancelledPaid">): string | null {
  const parts = [paidCardNote(stats)];
  if (stats.cancelledPaid > 0) parts.push(`${stats.cancelledPaid} cancelled, still marked paid`);
  const said = parts.filter(Boolean);
  return said.length > 0 ? said.join(" · ") : null;
}
