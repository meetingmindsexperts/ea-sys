import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { buildEventAccessWhere } from "@/lib/event-access";
import { canViewFinance } from "@/lib/finance-visibility";
import { computeEventAnalytics, type EventAnalytics } from "@/lib/event-analytics";

interface RouteParams {
  params: Promise<{ eventId: string }>;
}

/** RFC 4180 CSV field — quote + escape when needed. */
function csvField(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return "";
  const s = String(value);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/**
 * Flatten the analytics into a single "metric,value" CSV so the PM team /
 * CEO can pull the headline numbers into Excel/BI. Time-series and
 * breakdowns are emitted as labelled rows in the same sheet.
 */
function toCsv(a: EventAnalytics): string {
  const rows: (string | number | null)[][] = [
    ["Section", "Metric", "Value"],
    ["Event", "Name", a.event.name],
    ["Event", "Generated at", a.generatedAt],
    ["Registrations", "Total", a.registrations.total],
  ];
  for (const [k, v] of Object.entries(a.registrations.byStatus)) rows.push(["Registrations by status", k, v]);
  for (const b of a.registrations.byType) rows.push(["Registrations by type", b.label, b.count]);
  for (const b of a.registrations.byTier) rows.push(["Registrations by tier", b.label, b.count]);
  for (const b of a.registrations.overTime) rows.push(["Registrations per day", b.date, b.count]);

  rows.push(["Check-in", "Eligible", a.checkIn.eligible]);
  rows.push(["Check-in", "Checked in", a.checkIn.checkedIn]);
  rows.push(["Check-in", "Not checked in", a.checkIn.notCheckedIn]);
  rows.push(["Check-in", "Rate %", a.checkIn.rate]);
  if (a.checkIn.peakHour) rows.push(["Check-in", "Peak hour", `${String(a.checkIn.peakHour.hour).padStart(2, "0")}:00 (${a.checkIn.peakHour.count})`]);
  for (const b of a.checkIn.byDay) rows.push(["Check-ins per day", b.date, b.count]);
  for (const b of a.checkIn.byHour) rows.push(["Check-ins by hour", `${String(b.hour).padStart(2, "0")}:00`, b.count]);
  for (const b of a.checkIn.byStaff) rows.push(["Check-ins by staff", b.label, b.count]);

  rows.push(["Badges", "Printed (registrations)", a.badges.printed]);
  rows.push(["Badges", "Not printed", a.badges.notPrinted]);
  rows.push(["Badges", "Total prints (incl. reprints)", a.badges.totalPrints]);
  rows.push(["Badges", "Reprints", a.badges.reprints]);

  if (a.revenue) {
    for (const c of a.revenue.collected) rows.push(["Revenue collected", c.currency, c.amount]);
    for (const [k, v] of Object.entries(a.revenue.byPaymentStatus)) rows.push(["Registrations by payment status", k, v]);
    rows.push(["Revenue", "Outstanding (count)", a.revenue.outstandingCount]);
  }

  return rows.map((r) => r.map(csvField).join(",")).join("\n");
}

export async function GET(req: Request, { params }: RouteParams) {
  try {
    const [{ eventId }, session] = await Promise.all([params, auth()]);
    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    // Event access scoped to the caller's role (org membership / assignment).
    const event = await db.event.findFirst({
      where: buildEventAccessWhere(session.user, eventId),
      select: { id: true },
    });
    if (!event) {
      return NextResponse.json({ error: "Event not found" }, { status: 404 });
    }

    // Revenue is finance data — omitted entirely for MEMBER.
    const includeFinance = canViewFinance(session.user.role);
    const analytics = await computeEventAnalytics(eventId, { includeFinance });
    if (!analytics) {
      return NextResponse.json({ error: "Event not found" }, { status: 404 });
    }

    if (new URL(req.url).searchParams.get("export") === "csv") {
      return new NextResponse(toCsv(analytics), {
        status: 200,
        headers: {
          "Content-Type": "text/csv; charset=utf-8",
          "Content-Disposition": `attachment; filename="analytics-${eventId}.csv"`,
        },
      });
    }

    return NextResponse.json(analytics);
  } catch (error) {
    apiLogger.error({ err: error, msg: "Error computing event analytics" });
    return NextResponse.json({ error: "Failed to compute analytics" }, { status: 500 });
  }
}
