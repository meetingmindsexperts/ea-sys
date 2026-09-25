/**
 * When visit measurement began for an organisation: its earliest recorded hit
 * (Sep 25, 2026). A registration from before that date cannot be set against
 * a visit, because no visit was recorded, so the funnel's "Registered online"
 * starts counting from here rather than from the start of the chosen window.
 * Without this a 90-day window reached back into weeks with registrations and
 * no measurement, and conversion showed 600%.
 *
 * Organisation-wide, not per event: an event whose first visit came late may
 * still have had unmeasured visitors before it; the organisation's first hit
 * is when the beacon went live.
 */
import { db } from "@/lib/db";

export async function measuredFrom(organizationId: string): Promise<Date | null> {
  const first = await db.analyticsEvent.findFirst({
    where: { organizationId },
    orderBy: { createdAt: "asc" },
    select: { createdAt: true },
  });
  return first?.createdAt ?? null;
}

/** The later of the window start and the start of measurement; null when nothing was ever measured. */
export function registrationsFrom(windowFrom: Date, measuredStart: Date | null): Date | null {
  if (!measuredStart) return null;
  return measuredStart > windowFrom ? measuredStart : windowFrom;
}
