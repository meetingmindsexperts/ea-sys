/**
 * Operational analytics for an event — registration funnel, check-in
 * timing, and badge-print metrics. Powers the event Analytics page + its
 * CSV export (PM/CEO reporting).
 *
 * All aggregation is done in-process from a small set of queries (one
 * registration scan + one payment aggregate + one check-in audit groupBy)
 * rather than many round-trips. Events are typically hundreds–low thousands
 * of registrations, so a single findMany of the slim columns is cheap.
 *
 * Finance figures (revenue) are only computed when `includeFinance` is true
 * — the caller passes `canViewFinance(role)` so MEMBER never sees money.
 */

import { db } from "./db";
import { EXCLUDE_FACULTY_WHERE } from "./faculty-filter";

export interface CountBucket {
  label: string;
  count: number;
}

export interface TimeBucket {
  /** ISO date (YYYY-MM-DD) in the event timezone. */
  date: string;
  count: number;
}

export interface HourBucket {
  /** Hour of day 0–23 in the event timezone. */
  hour: number;
  count: number;
}

export interface CurrencyAmount {
  currency: string;
  amount: number;
}

export interface CheckInLogEntry {
  registrationId: string;
  serialId: number | null;
  name: string;
  email: string;
  /** ISO timestamp of the check-in. */
  checkedInAt: string;
  /** Staff member who performed the check-in ("System" if no user). */
  checkedInBy: string;
  /** "Scanned" (barcode) or "Manual" (typed/admin). */
  method: "Scanned" | "Manual";
}

export interface EventAnalytics {
  event: { id: string; name: string; startDate: string; timezone: string };
  generatedAt: string;
  registrations: {
    total: number;
    byStatus: Record<string, number>;
    byType: CountBucket[];
    byTier: CountBucket[];
    /** Daily registration counts (createdAt), event timezone. */
    overTime: TimeBucket[];
  };
  checkIn: {
    eligible: number; // CONFIRMED or already CHECKED_IN — the denominator
    checkedIn: number;
    notCheckedIn: number; // eligible − checkedIn (no-shows so far)
    rate: number; // checkedIn / eligible, 0 when eligible = 0
    byDay: TimeBucket[]; // check-ins per calendar day
    byHour: HourBucket[]; // check-ins by hour-of-day (the rush curve)
    peakHour: { hour: number; count: number } | null;
    byStaff: CountBucket[]; // who checked in how many (from AuditLog)
    log: CheckInLogEntry[]; // per-attendee check-in records, newest first
  };
  badges: {
    printed: number; // distinct registrations with ≥1 print
    notPrinted: number; // eligible − printed
    totalPrints: number; // sum of badgePrintCount (incl. reprints)
    reprints: number; // totalPrints − printed
  };
  /** Null when finance is not visible to the caller (MEMBER). */
  revenue: {
    collected: CurrencyAmount[]; // sum of completed payments by currency
    byPaymentStatus: Record<string, number>; // registration counts
    outstandingCount: number; // registrations UNPAID / PENDING
  } | null;
}

/** Format a Date into YYYY-MM-DD in a given IANA timezone. */
function dayKey(d: Date, timeZone: string): string {
  // en-CA yields YYYY-MM-DD.
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
}

/** Hour of day (0–23) in a given IANA timezone. */
function hourOf(d: Date, timeZone: string): number {
  const h = new Intl.DateTimeFormat("en-US", { timeZone, hour: "2-digit", hour12: false }).format(d);
  // "24" can appear for midnight in some environments — normalize to 0.
  const n = parseInt(h, 10);
  return Number.isNaN(n) ? 0 : n % 24;
}

export async function computeEventAnalytics(
  eventId: string,
  opts: { includeFinance: boolean },
): Promise<EventAnalytics | null> {
  const event = await db.event.findUnique({
    where: { id: eventId },
    select: { id: true, name: true, startDate: true, timezone: true },
  });
  if (!event) return null;

  const tz = event.timezone || "Asia/Dubai";

  // One slim scan of registrations powers the funnel + check-in + badge maths.
  // Delegate-focused — faculty companion registrations are excluded (they're
  // counted/shown via the speakers + registrations lists, not analytics).
  const regs = await db.registration.findMany({
    where: { eventId, ...EXCLUDE_FACULTY_WHERE },
    select: {
      id: true,
      serialId: true,
      status: true,
      paymentStatus: true,
      createdAt: true,
      checkedInAt: true,
      badgePrintCount: true,
      ticketType: { select: { name: true } },
      pricingTier: { select: { name: true } },
      attendee: { select: { firstName: true, lastName: true, email: true } },
    },
  });

  // ── Registration funnel ──
  const byStatus: Record<string, number> = {};
  const byPaymentStatus: Record<string, number> = {};
  const typeCounts = new Map<string, number>();
  const tierCounts = new Map<string, number>();
  const regByDay = new Map<string, number>();

  // ── Check-in + badges ──
  let eligible = 0;
  let checkedIn = 0;
  let printed = 0;
  let totalPrints = 0;
  let outstandingCount = 0;
  const checkInByDay = new Map<string, number>();
  const checkInByHour = new Map<number, number>();

  for (const r of regs) {
    byStatus[r.status] = (byStatus[r.status] ?? 0) + 1;
    byPaymentStatus[r.paymentStatus] = (byPaymentStatus[r.paymentStatus] ?? 0) + 1;

    const typeName = r.ticketType?.name ?? "—";
    typeCounts.set(typeName, (typeCounts.get(typeName) ?? 0) + 1);
    if (r.pricingTier?.name) tierCounts.set(r.pricingTier.name, (tierCounts.get(r.pricingTier.name) ?? 0) + 1);

    const d = dayKey(r.createdAt, tz);
    regByDay.set(d, (regByDay.get(d) ?? 0) + 1);

    // Eligible denominator for check-in/badge rates: anyone not cancelled.
    if (r.status !== "CANCELLED") eligible += 1;

    if (r.checkedInAt) {
      checkedIn += 1;
      const cd = dayKey(r.checkedInAt, tz);
      checkInByDay.set(cd, (checkInByDay.get(cd) ?? 0) + 1);
      const ch = hourOf(r.checkedInAt, tz);
      checkInByHour.set(ch, (checkInByHour.get(ch) ?? 0) + 1);
    }

    if (r.badgePrintCount > 0) printed += 1;
    totalPrints += r.badgePrintCount;

    if (r.paymentStatus === "UNPAID" || r.paymentStatus === "PENDING") outstandingCount += 1;
  }

  const sortByCountDesc = (a: CountBucket, b: CountBucket) => b.count - a.count;
  const sortByDate = (a: TimeBucket, b: TimeBucket) => a.date.localeCompare(b.date);

  const byHour: HourBucket[] = [...checkInByHour.entries()]
    .map(([hour, count]) => ({ hour, count }))
    .sort((a, b) => a.hour - b.hour);
  const peakHour = byHour.length
    ? byHour.reduce((max, b) => (b.count > max.count ? b : max), byHour[0])
    : null;

  // ── Per-attendee check-in log + who-checked-in-whom ──
  // The log SPINE is Registration.checkedInAt — every check-in sets it, so
  // the log is complete even for check-ins that predate audit logging or
  // were set directly (e.g. seeded data). We then ENRICH each row with the
  // CHECK_IN AuditLog (staff + method), which carries who/how but may be
  // absent for non-route check-ins. byStaff is derived from the audit rows
  // (the only source that knows which staff member acted).
  const checkInRows = await db.auditLog.findMany({
    where: { eventId, action: "CHECK_IN" },
    select: { userId: true, entityId: true, changes: true },
  });
  const staffIds = [...new Set(checkInRows.map((r) => r.userId).filter((id): id is string => !!id))];
  const staff = staffIds.length
    ? await db.user.findMany({ where: { id: { in: staffIds } }, select: { id: true, firstName: true, lastName: true } })
    : [];
  const staffName = new Map(staff.map((u) => [u.id, `${u.firstName} ${u.lastName}`.trim()]));

  // registrationId → enrichment from the audit row (last one wins if multiple).
  const auditByReg = new Map<string, { by: string; method: "Scanned" | "Manual" }>();
  const staffCounts = new Map<string, number>();
  for (const row of checkInRows) {
    const changes = (row.changes ?? {}) as Record<string, unknown>;
    const who = row.userId ? (staffName.get(row.userId) ?? "Unknown") : "System";
    staffCounts.set(who, (staffCounts.get(who) ?? 0) + 1);
    auditByReg.set(row.entityId, { by: who, method: changes.qrCode ? "Scanned" : "Manual" });
  }
  const byStaff: CountBucket[] = [...staffCounts.entries()]
    .map(([label, count]) => ({ label, count }))
    .sort(sortByCountDesc);

  const log: CheckInLogEntry[] = regs
    .filter((r) => r.checkedInAt)
    .sort((a, b) => (b.checkedInAt as Date).getTime() - (a.checkedInAt as Date).getTime())
    .map((r) => {
      const enrich = auditByReg.get(r.id);
      return {
        registrationId: r.id,
        serialId: r.serialId,
        name: `${r.attendee?.firstName ?? ""} ${r.attendee?.lastName ?? ""}`.trim() || "—",
        email: r.attendee?.email ?? "",
        checkedInAt: (r.checkedInAt as Date).toISOString(),
        checkedInBy: enrich?.by ?? "—",
        method: enrich?.method ?? "Manual",
      };
    });

  // ── Revenue (finance-gated) ──
  let revenue: EventAnalytics["revenue"] = null;
  if (opts.includeFinance) {
    const payments = await db.payment.groupBy({
      by: ["currency"],
      where: { registration: { eventId }, status: "PAID" },
      _sum: { amount: true },
    });
    const collected: CurrencyAmount[] = payments
      .map((p) => ({ currency: p.currency, amount: Number(p._sum.amount ?? 0) }))
      .filter((c) => c.amount > 0)
      .sort((a, b) => b.amount - a.amount);
    revenue = { collected, byPaymentStatus, outstandingCount };
  }

  return {
    event: {
      id: event.id,
      name: event.name,
      startDate: event.startDate.toISOString(),
      timezone: tz,
    },
    generatedAt: new Date().toISOString(),
    registrations: {
      total: regs.length,
      byStatus,
      byType: [...typeCounts.entries()].map(([label, count]) => ({ label, count })).sort(sortByCountDesc),
      byTier: [...tierCounts.entries()].map(([label, count]) => ({ label, count })).sort(sortByCountDesc),
      overTime: [...regByDay.entries()].map(([date, count]) => ({ date, count })).sort(sortByDate),
    },
    checkIn: {
      eligible,
      checkedIn,
      notCheckedIn: Math.max(0, eligible - checkedIn),
      rate: eligible > 0 ? Math.round((checkedIn / eligible) * 1000) / 10 : 0,
      byDay: [...checkInByDay.entries()].map(([date, count]) => ({ date, count })).sort(sortByDate),
      byHour,
      peakHour: peakHour ? { hour: peakHour.hour, count: peakHour.count } : null,
      byStaff,
      log,
    },
    badges: {
      printed,
      notPrinted: Math.max(0, eligible - printed),
      totalPrints,
      reprints: Math.max(0, totalPrints - printed),
    },
    revenue,
  };
}
