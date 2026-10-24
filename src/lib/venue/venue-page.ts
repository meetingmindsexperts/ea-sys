/**
 * The walkable venue's page, shared by GET /e/:slug/venue (the saved venue)
 * and POST /e/:slug/venue/preview (an unsaved drawn plan, phase 2 of
 * docs/VENUE_FLOOR_PLAN_EDITOR_PLAN.md). Served as the vendor built it
 * (vendor/ehc-venue, generated into page-html.generated.json), after three
 * small scripts: the event's real name, dates and venue (window.EHC_EVENT),
 * its recordings per screen (window.EHC_SCREENS), and, for the real venue
 * only, this person's runtime settings (window.EHC_VENUE) and the EA-SYS
 * runtime the vendor code talks to (/venue-runtime.js).
 *
 * A preview runs offline: no runtime, so no live colleagues, AI attendees,
 * saved activity or reports (the vendor's code runs without one, as in its own
 * tests), and a strip across the top says it is a preview of unsaved changes.
 */
import { NextResponse } from "next/server";
import type { VenueLayout } from "./layout";
import type { EventLayout } from "./event-venue";
import { venueRooms } from "./event-venue";
import type { VenueGate } from "./route-guard";
import { venueDisplayName } from "./display-name";
import { venueDateRange } from "./date-range";
import { resolveTimezone } from "@/lib/event-time";
import { VENUE_SAFETY_INBOX, readVenueConfig } from "@/services/venue-service";
import { readVenueAi } from "@/services/venue-ai-service";
import { loadVenueProgramme } from "@/services/venue-programme-service";
import venuePage from "./page-html.generated.json";

/** A value as a script literal that can never close the <script> it sits in. */
export const scriptLiteral = (v: unknown) => JSON.stringify(v).replace(/</g, "\\u003c").replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");

const escapeHtml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const MESSAGES: Record<number, string> = {
  400: "This plan could not be read. Go back to the editor and try again.",
  403: "You do not have access to this venue.",
  404: "Not found.",
  413: "This plan is too large to preview.",
  429: "Too many previews in the last hour. Try again later.",
  503: "This venue's rooms cannot be laid out right now. The event team has been told.",
};

/** A plain page for a refusal, with an optional list of reasons (escaped: they can carry room names). */
export function plainVenuePage(status: number, opts: { message?: string; reasons?: string[]; headers?: Record<string, string> } = {}): NextResponse {
  const message = opts.message ?? MESSAGES[status] ?? "Something went wrong.";
  const reasons = opts.reasons?.length ? `<ul>${opts.reasons.map((r) => `<li>${escapeHtml(r)}</li>`).join("")}</ul>` : "";
  return new NextResponse(`<!doctype html><meta charset="utf-8"><title>Online venue</title><div style="font:16px system-ui;margin:2rem;max-width:40rem"><p>${escapeHtml(message)}</p>${reasons}</div>`, {
    status,
    headers: { "Content-Type": "text/html; charset=utf-8", ...opts.headers },
  });
}

const PREVIEW_STRIP =
  '<div role="status" style="position:fixed;top:0;left:50%;transform:translateX(-50%);z-index:2147483647;margin-top:8px;padding:6px 14px;border-radius:999px;' +
  'background:#0c4a6e;color:#f0f9ff;font:500 13px system-ui;box-shadow:0 2px 8px rgba(0,0,0,.35);pointer-events:none">' +
  "Preview of unsaved changes. Nothing here is saved; live colleagues and AI attendees are off.</div>";

type OpenGate = Extract<VenueGate, { ok: true }>;

/** The venue page for this event and layout (`null`: EHC's hand-built preset). */
export async function venuePageResponse(gate: OpenGate, built: EventLayout, opts: { preview?: boolean } = {}): Promise<{ response: NextResponse; sessions: number; sponsors: number }> {
  const e = gate.event;
  const layout: VenueLayout | null = built.kind === "generated" ? built.layout : null;
  const tz = resolveTimezone(e.timezone);
  // The sessions and sponsors the screens, agenda and stands show (phase 6 step 4).
  const programme = await loadVenueProgramme({ organizationId: gate.organizationId, eventId: e.id }, venueRooms(built), tz);
  const ehcEvent = {
    name: e.name,
    date: venueDateRange(e.startDate, e.endDate, tz),
    ...(e.venue && { venue: e.venue }),
    // A generated venue names its own event everywhere; EHC's rooms keep EHC's short name and society.
    ...(layout && { short: (e.code || e.name).slice(0, 24), ...(e.organization?.name && { organiser: e.organization.name }) }),
  };
  // Recordings per screen from the event's settings; an empty map stops the
  // vendor page looking for a screens.json beside itself (it would 404).
  const screens = readVenueConfig(e.settings).screens ?? {};
  const ehcVenue = { api: `/api/venue/${e.id}`, userId: gate.userId, name: venueDisplayName(gate.session), team: gate.team, ai: readVenueAi(e.settings).on };
  const runtime = opts.preview ? "" : `window.EHC_VENUE=${scriptLiteral(ehcVenue)};`;
  const page =
    '<!doctype html><html lang="en"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">' +
    `<title>${opts.preview ? "Preview: " : ""}Online venue</title>` +
    "<style>body{margin:0}[hidden]{display:none!important}</style></head><body>" +
    `<script>window.EHC_LAYOUT=${layout ? scriptLiteral(layout) : "null"};window.EHC_EVENT=${scriptLiteral(ehcEvent)};${runtime}window.EHC_CONTACT=${scriptLiteral(VENUE_SAFETY_INBOX)};window.EHC_SCREENS=${scriptLiteral(screens)};window.EHC_PROGRAMME=${scriptLiteral(programme)};</script>` +
    (opts.preview ? "" : '<script src="/venue-runtime.js"></script>') +
    venuePage.html +
    (opts.preview ? PREVIEW_STRIP : "") +
    "</body></html>";
  return {
    response: new NextResponse(page, {
      headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" },
    }),
    sessions: programme.sessions.length,
    sponsors: programme.sponsors.length,
  };
}
