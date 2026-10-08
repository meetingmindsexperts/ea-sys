/**
 * Online venue service (docs/EVENT_BLUEPRINT_PLAN.md phase 4): what the venue
 * page stores and reads, for one event of the caller's organisation. The
 * route decides who may call (staff who see the event; the event team for the
 * team views); this service trusts its caller and runs inside the tenant
 * context. Errors are values.
 */
import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { runWithTenant } from "@/lib/tenant-context";
import { sendEmail } from "@/lib/email";
import { escapeHtml } from "@/lib/html";
import { updateEventSettings } from "@/lib/event-settings";
import { shapeActivity, shapeFilter, shapeReport } from "@/lib/venue/venue-data";

/** Where venue safety reports are emailed (plan D7). */
export const VENUE_SAFETY_INBOX = "info@meetingmindsgroup.com";

const MAX_DOC_BYTES = 64 * 1024;

interface Caller {
  organizationId: string;
  eventId: string;
  userId: string;
}

type Fail = { ok: false; code: "INVALID_REPORT" | "TOO_LARGE"; message: string };

function fail(code: Fail["code"], message: string, ctx: Record<string, unknown>): Fail {
  apiLogger.warn({ msg: "venue-service:refused", code, ...ctx });
  return { ok: false, code, message };
}

const tooLarge = (v: unknown) => new TextEncoder().encode(JSON.stringify(v ?? null)).length > MAX_DOC_BYTES;

// ── Activity ─────────────────────────────────────────────────────────────────

export function getMyActivity(c: Caller) {
  return runWithTenant(c.organizationId, async () => {
    const row = await db.venueActivity.findUnique({
      where: { eventId_userId: { eventId: c.eventId, userId: c.userId } },
      select: { data: true },
    });
    return row?.data ?? null;
  });
}

/** Replace this person's activity summary (the page saves every ~30 s and on leaving). */
export async function saveMyActivity(c: Caller, raw: unknown, displayName: string): Promise<{ ok: true } | Fail> {
  const ctx = { organizationId: c.organizationId, eventId: c.eventId, userId: c.userId };
  if (tooLarge(raw)) return fail("TOO_LARGE", "The activity summary is too large", ctx);
  const data = shapeActivity(raw, c.userId, displayName) as Prisma.InputJsonValue;
  await runWithTenant(c.organizationId, () =>
    db.venueActivity.upsert({
      where: { eventId_userId: { eventId: c.eventId, userId: c.userId } },
      create: { eventId: c.eventId, organizationId: c.organizationId, userId: c.userId, data },
      update: { data },
    }),
  );
  return { ok: true };
}

/** Everyone's activity in this event's venue: the event team's view. */
export function listActivity(organizationId: string, eventId: string) {
  return runWithTenant(organizationId, async () => {
    const rows = await db.venueActivity.findMany({
      where: { eventId, organizationId },
      select: { data: true },
      orderBy: { updatedAt: "desc" },
      take: 2000,
    });
    return rows.map((r) => r.data);
  });
}

// ── Reports ──────────────────────────────────────────────────────────────────

/** Store a safety report, then email it to the safety inbox (never undoes the store). */
export async function createReport(c: Caller, raw: unknown, ctxInfo: { eventName: string; reporterName: string }): Promise<{ ok: true } | Fail> {
  const ctx = { organizationId: c.organizationId, eventId: c.eventId, userId: c.userId };
  if (tooLarge(raw)) return fail("TOO_LARGE", "The report is too large", ctx);
  const item = shapeReport(raw, c.userId);
  if (!item) return fail("INVALID_REPORT", "Choose a reason for the report", ctx);

  const row = await runWithTenant(c.organizationId, () =>
    db.venueReport.create({
      data: { eventId: c.eventId, organizationId: c.organizationId, reporterId: c.userId, data: item as Prisma.InputJsonValue },
      select: { id: true },
    }),
  );
  apiLogger.info({ msg: "venue-service:report-stored", ...ctx, reportId: row.id });
  await emailReport(item, { ...ctxInfo, reportId: row.id }, ctx);
  return { ok: true };
}

async function emailReport(item: Record<string, unknown>, info: { eventName: string; reporterName: string; reportId: string }, ctx: Record<string, unknown>) {
  const who = item.who as { name: string; guest: boolean };
  const said = (item.said as { text: string }[]).map((s) => s.text);
  const lines = [
    `Event: ${info.eventName}`,
    `Reason: ${item.reason}`,
    `About: ${who.name || "unknown"}${who.guest ? " (guest)" : ""}`,
    `Room: ${item.zone || "unknown"}`,
    `Reported by: ${info.reporterName}`,
    item.note ? `Note: ${item.note}` : "",
    said.length ? `Their last lines:\n${said.map((s) => `  "${s}"`).join("\n")}` : "",
    `Report id: ${info.reportId}`,
  ].filter(Boolean);
  try {
    const res = await sendEmail({
      to: [{ email: VENUE_SAFETY_INBOX }],
      subject: `Venue safety report: ${info.eventName}`,
      htmlContent: lines.map((l) => `<p>${escapeHtml(l).replace(/\n/g, "<br/>")}</p>`).join("\n"),
      textContent: lines.join("\n"),
    });
    if (!res.success) apiLogger.error({ msg: "venue-service:report-email-failed", ...ctx, reportId: info.reportId, error: res.error, code: res.code });
  } catch (err) {
    apiLogger.error({ msg: "venue-service:report-email-failed", ...ctx, reportId: info.reportId, err });
  }
}

/** Every report in this event's venue, newest first, grouped by reporter for the page. */
export function listReports(organizationId: string, eventId: string) {
  return runWithTenant(organizationId, async () => {
    const rows = await db.venueReport.findMany({
      where: { eventId, organizationId },
      select: { reporterId: true, data: true },
      orderBy: { createdAt: "desc" },
      take: 2000,
    });
    return rows.map((r) => ({ reporterId: r.reporterId, item: r.data }));
  });
}

// ── Settings ─────────────────────────────────────────────────────────────────

export interface VenueConfig {
  filter: ReturnType<typeof shapeFilter> | null;
  screens: Record<string, { url: string; title: string }> | null;
}

/** The venue's settings live in `Event.settings.venue`. */
export function readVenueConfig(settings: unknown): VenueConfig {
  const venue = (settings && typeof settings === "object" ? (settings as Record<string, unknown>).venue : null) as Record<string, unknown> | null;
  if (!venue || typeof venue !== "object") return { filter: null, screens: null };
  const screens: VenueConfig["screens"] = {};
  for (const [k, v] of Object.entries((venue.screens as Record<string, unknown>) ?? {})) {
    const s = v as { url?: unknown; title?: unknown };
    if (/^[\w-]{1,40}$/.test(k) && typeof s?.url === "string" && /^https:\/\//.test(s.url)) {
      screens[k] = { url: s.url.slice(0, 500), title: typeof s.title === "string" ? s.title.slice(0, 120) : "" };
    }
  }
  return { filter: venue.filter ? shapeFilter(venue.filter) : null, screens: Object.keys(screens).length ? screens : null };
}

/** The event team saves the language filter; only `settings.venue.filter` changes. */
export async function saveFilter(organizationId: string, eventId: string, raw: unknown) {
  const filter = shapeFilter(raw);
  await runWithTenant(organizationId, () =>
    updateEventSettings(eventId, (cur) => {
      const venue = cur.venue && typeof cur.venue === "object" ? (cur.venue as Record<string, unknown>) : {};
      return { ...cur, venue: { ...venue, filter } };
    }),
  );
  return filter;
}
