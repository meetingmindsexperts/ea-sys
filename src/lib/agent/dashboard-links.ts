/**
 * Where things are in the dashboard, for the Event Agent (September 22, 2026).
 *
 * The agent's prompt told the model to "point the user to the dashboard" and
 * never said where anything was, so asked "where can I find those drafts?"
 * it answered with menu names that do not exist ("Emails", then "Email
 * Templates" in the sidebar; the real page is Communications, Email
 * Templates). Two things fix that, both derived from the ONE table below so
 * they cannot drift from each other or from the sidebar:
 *
 *  - `buildDashboardMapSection` renders the table into the system prompt, one
 *    line per surface, with the current event's id substituted, so a prose
 *    answer names a real page and its link.
 *  - `dashboardPathForTool` maps a tool call to the page that shows what it
 *    touched (and the row's own page when the result carries its id), which
 *    the shared tool runner attaches to every successful result as
 *    `dashboardUrl`, on both doors.
 *
 * Pure and client-safe: no server imports, so a test can pin every registered
 * tool to a surface and a renamed page fails here, not in a paid run.
 */

export interface DashboardSurface {
  key: string;
  /** How the sidebar and the page header name it, so the model repeats a real label. */
  label: string;
  /** The path; null when the surface needs an event and none is selected. */
  path: (eventId: string | null) => string | null;
}

const ev = (eventId: string | null, tail: string): string | null => (eventId ? `/events/${eventId}${tail}` : null);

/** The surfaces the model may point a person to, in sidebar order. */
export const DASHBOARD_SURFACES: readonly DashboardSurface[] = [
  { key: "events", label: "Events (the list of every event)", path: () => "/events" },
  { key: "event", label: "Event landing page", path: (e) => ev(e, "") },
  { key: "settings", label: "Event Settings (dates, venue, registration, tax, branding, CME accreditation)", path: (e) => ev(e, "/settings") },
  { key: "content", label: "Content (registration welcome and terms, speaker and presenter agreement text)", path: (e) => ev(e, "/content") },
  { key: "setup", label: "Event Setup hub", path: (e) => ev(e, "/setup") },
  { key: "registrations", label: "Registrations", path: (e) => ev(e, "/registrations") },
  { key: "check-in", label: "Check-In", path: (e) => ev(e, "/check-in") },
  { key: "tickets", label: "Registration Types (ticket types and pricing tiers)", path: (e) => ev(e, "/tickets") },
  { key: "promo-codes", label: "Promo Codes", path: (e) => ev(e, "/promo-codes") },
  { key: "speakers", label: "Speakers", path: (e) => ev(e, "/speakers") },
  { key: "agenda", label: "Agenda (tracks, sessions, topics, Zoom meetings)", path: (e) => ev(e, "/agenda") },
  { key: "abstracts", label: "Abstracts (submissions, review criteria, themes)", path: (e) => ev(e, "/abstracts") },
  { key: "reviewers", label: "Reviewers", path: (e) => ev(e, "/reviewers") },
  { key: "session-proposals", label: "Session Proposals", path: (e) => ev(e, "/session-proposals") },
  { key: "communications", label: "Communications (bulk email, scheduled emails, email activity)", path: (e) => ev(e, "/communications") },
  { key: "email-templates", label: "Communications, Email Templates (every email template, built-in and custom)", path: (e) => ev(e, "/communications/templates") },
  { key: "sponsors", label: "Sponsors", path: (e) => ev(e, "/sponsors") },
  { key: "media", label: "Media (the event's image library)", path: (e) => ev(e, "/media") },
  { key: "accommodation", label: "Accommodation (hotels, room types, bookings)", path: (e) => ev(e, "/accommodation") },
  { key: "invoices", label: "Invoices (this event's invoices, receipts, credit notes)", path: (e) => ev(e, "/invoices") },
  { key: "certificates", label: "Certificates (templates, issuing, CME hours)", path: (e) => ev(e, "/certificates") },
  { key: "webinar", label: "Webinar Console", path: (e) => ev(e, "/webinar") },
  { key: "rsvp", label: "RSVP (dinners and other invitations)", path: (e) => ev(e, "/rsvp") },
  { key: "survey", label: "Survey", path: (e) => ev(e, "/survey") },
  { key: "analytics", label: "Analytics", path: (e) => ev(e, "/analytics") },
  { key: "contacts", label: "Contacts (the organisation's contact store)", path: () => "/contacts" },
  { key: "budgets", label: "Budgets (budget and procurement)", path: () => "/procurement" },
  { key: "crm", label: "CRM (deals, companies, contacts, tasks)", path: () => "/crm" },
];

const SURFACE_BY_KEY: Readonly<Record<string, DashboardSurface>> = Object.fromEntries(
  DASHBOARD_SURFACES.map((s) => [s.key, s]),
);

type Result = Record<string, unknown>;

const idOf = (r: Result, key: string): string | null => {
  const row = r[key];
  const id = row && typeof row === "object" ? (row as Result).id : undefined;
  return typeof id === "string" && id.length > 0 ? id : null;
};

/**
 * Tool name → surface, first match wins. A rule may also point at the row's
 * own page when the result carries the row (`{ speaker: { id } }`).
 */
const TOOL_SURFACE_RULES: ReadonlyArray<{
  test: RegExp;
  surface: string;
  row?: (r: Result, eventId: string | null) => string | null;
}> = [
  { test: /email_template/, surface: "email-templates", row: (r, e) => (idOf(r, "template") ? ev(e, `/communications/templates/${idOf(r, "template")}`) : null) },
  { test: /scheduled_email|send_bulk_email/, surface: "communications" },
  { test: /^list_events$|^search_event$/, surface: "events" },
  { test: /^create_event$/, surface: "events", row: (r) => (idOf(r, "event") ? `/events/${idOf(r, "event")}` : null) },
  { test: /^update_event$|^get_event_/, surface: "event" },
  { test: /certificate|cme_settings/, surface: "certificates" },
  { test: /webinar/, surface: "webinar" },
  { test: /track|session|topic|zoom_meeting/, surface: "agenda" },
  { test: /speaker_agreement/, surface: "speakers" },
  { test: /speakers?(_|$)/, surface: "speakers", row: (r, e) => (idOf(r, "speaker") ? ev(e, `/speakers/${idOf(r, "speaker")}`) : null) },
  { test: /check_in/, surface: "check-in" },
  { test: /registration/, surface: "registrations" },
  { test: /ticket_type/, surface: "tickets" },
  { test: /promo_code/, surface: "promo-codes" },
  { test: /sponsor/, surface: "sponsors" },
  { test: /^list_reviewers$/, surface: "reviewers" },
  { test: /abstract|review/, surface: "abstracts", row: (r, e) => (idOf(r, "abstract") ? ev(e, `/abstracts/${idOf(r, "abstract")}/edit`) : null) },
  { test: /hotel|room_type|accommodation/, surface: "accommodation" },
  { test: /invoice/, surface: "invoices" },
  { test: /rsvp/, surface: "rsvp" },
  { test: /media/, surface: "media" },
  { test: /crm_deal|crm_note|crm_pipeline|crm_report/, surface: "crm", row: (r) => (idOf(r, "deal") ? `/crm/deals/${idOf(r, "deal")}` : null) },
  { test: /crm_compan/, surface: "crm", row: (r) => (idOf(r, "company") ? `/crm/companies/${idOf(r, "company")}` : null) },
  { test: /crm_contact/, surface: "crm", row: (r) => (idOf(r, "contact") ? `/crm/contacts/${idOf(r, "contact")}` : null) },
  { test: /crm_/, surface: "crm" },
  // The deal-product tools carry no "crm_" (add_deal_product, update_deal_product).
  { test: /deal/, surface: "crm", row: (r) => (idOf(r, "deal") ? `/crm/deals/${idOf(r, "deal")}` : null) },
  { test: /contact/, surface: "contacts", row: (r) => (idOf(r, "contact") ? `/contacts/${idOf(r, "contact")}` : null) },
  { test: /budget|spend_request|commitment/, surface: "budgets", row: (r) => (idOf(r, "budget") ? `/procurement/budgets/${idOf(r, "budget")}` : null) },
];

/** The surface a tool belongs to, or null for a tool the table does not know. */
export function surfaceForTool(toolName: string): DashboardSurface | null {
  const rule = TOOL_SURFACE_RULES.find((rl) => rl.test.test(toolName));
  return rule ? SURFACE_BY_KEY[rule.surface] ?? null : null;
}

/**
 * The dashboard path for what a tool call touched: the row's own page when
 * the result names it, else the surface's page. Null when the tool is
 * unknown or the surface needs an event and none was in context.
 */
export function dashboardPathForTool(toolName: string, eventId: string | null, result: unknown): string | null {
  const rule = TOOL_SURFACE_RULES.find((rl) => rl.test.test(toolName));
  if (!rule) return null;
  const r = result && typeof result === "object" ? (result as Result) : {};
  const rowPath = rule.row ? rule.row(r, eventId) : null;
  if (rowPath) return rowPath;
  return SURFACE_BY_KEY[rule.surface]?.path(eventId) ?? null;
}

/** The absolute form, for a tool result or the prompt; a missing base yields the path alone. */
export function dashboardUrl(path: string, baseUrl: string | undefined): string {
  const base = (baseUrl ?? "").replace(/\/+$/, "");
  return `${base}${path}`;
}

/** The prompt section: one line per surface, the event's id substituted when one is selected. */
export function buildDashboardMapSection(eventId: string | null, baseUrl: string | undefined): string {
  const lines = DASHBOARD_SURFACES.map((s) => {
    const path = s.path(eventId) ?? s.path("{eventId}");
    return `- ${s.label}: ${dashboardUrl(path ?? "", baseUrl)}`;
  });
  const eventNote = eventId
    ? ""
    : " No event is selected, so an event page's link carries {eventId}: find the event first and fill its id in.";
  return [
    "## Where things are in the dashboard",
    "When someone asks where to find, check or edit something, name the page and give its link from this list; never invent a menu or page name. " +
      "A tool result's dashboardUrl is the link to what that call just touched: quote it when you report the result." +
      eventNote,
    ...lines,
  ].join("\n");
}
