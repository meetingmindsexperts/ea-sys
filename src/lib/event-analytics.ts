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
  const regs = await db.registration.findMany({
    where: { eventId },
    select: {
      status: true,
      paymentStatus: true,
      createdAt: true,
      checkedInAt: true,
      badgePrintCount: true,
      ticketType: { select: { name: true } },
      pricingTier: { select: { name: true } },
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

  // ── Who checked people in (from AuditLog CHECK_IN rows) ──
  const checkInActions = await db.auditLog.groupBy({
    by: ["userId"],
    where: { eventId, action: "CHECK_IN" },
    _count: { _all: true },
  });
  const staffIds = checkInActions.map((a) => a.userId).filter((id): id is string => !!id);
  const staff = staffIds.length
    ? await db.user.findMany({ where: { id: { in: staffIds } }, select: { id: true, firstName: true, lastName: true } })
    : [];
  const staffName = new Map(staff.map((u) => [u.id, `${u.firstName} ${u.lastName}`.trim()]));
  const byStaff: CountBucket[] = checkInActions
    .map((a) => ({
      label: a.userId ? (staffName.get(a.userId) ?? "Unknown") : "System",
      count: a._count._all,
    }))
    .sort(sortByCountDesc);

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
