import type { PermissionKey } from "./catalogue";

/**
 * Permissions that hang on WHAT a request changes rather than which route it
 * calls (owner, Oct 6, 2026). Client-safe: constants and pure functions only.
 *
 * Two operations reach more than one permission through one door:
 *
 *  1. THE EVENT EDIT (`PUT /api/events/[id]`). The Settings, Content and
 *     Survey screens all save through it, so before this file every field
 *     asked `events.update`, and a custom role ticking "Event settings and
 *     content" or "Surveys" got nothing. Now each field asks its own key. The
 *     route checks only the fields whose VALUE CHANGES: the Settings General
 *     tab sends details, tax and settings together on every save, and asking
 *     for every key present would stop someone allowed one of them from
 *     saving the tab at all.
 *
 *  2. THE BULK SEND. The certificate email issues certificates and the survey
 *     invitation hands out the survey, so sending either also needs the key
 *     of that operation, not only `communications.send`.
 *
 * Every built-in role that holds `events.update` holds the other two event
 * keys at the same scope, so none of them notices (1). (2) narrows one
 * built-in role: WEBINARS loses the certificate send (it holds no
 * `certificates.issue`, matching its documented "no certificates"; production
 * had no certificate send by a WEBINARS user when this landed). A full API
 * key is unaffected (the send routes take a session, and its MCP door is not
 * gated); a key acting with a role needs the second key like a person does.
 */

/** The event's details, dates, venue and status (`events.update`). */
export const EVENT_DETAIL_FIELDS = [
  "name",
  "slug",
  "description",
  "eventType",
  "tag",
  "specialty",
  "code",
  "startDate",
  "endDate",
  "timezone",
  "venue",
  "address",
  "city",
  "country",
  "supportEmail",
  "status",
  "maxAttendees",
] as const;

/** The survey's questions and its two texts (`surveys.manage`). */
export const EVENT_SURVEY_FIELDS = ["surveyConfig", "surveyIntroHtml", "surveyThankYouHtml"] as const;

/** Settings, Content and branding: sender, tax and bank, terms (`events.settings`). */
export const EVENT_SETTINGS_FIELDS = [
  "settings",
  "bannerImage",
  "bannerImageMobile",
  "footerHtml",
  "emailHeaderImage",
  "emailFooterImage",
  "emailFooterHtml",
  "emailFromAddress",
  "emailFromName",
  "emailCcAddresses",
  "registrationTermsHtml",
  "registrationWelcomeHtml",
  "abstractWelcomeHtml",
  "sessionProposalWelcomeHtml",
  "abstractGuidelinesHtml",
  "abstractTermsHtml",
  "travelGrantMessageHtml",
  "travelGrantTermsHtml",
  "abstractConfirmationHtml",
  "registrationConfirmationHtml",
  "speakerAgreementHtml",
  "taxRate",
  "taxLabel",
  "bankDetails",
  "badgeVerticalOffset",
  "requiresDtcmBarcode",
] as const;

/**
 * `settings` sub-keys that belong to another permission and are written only
 * by their own routes, so the event edit drops them (Phase 6 review, Oct 7,
 * 2026): `events.settings` once rewrote the CME accreditation printed on
 * certificates (`certificates.templates.manage`), the reimbursement claim
 * items (`reimbursements.manage`) and the webinar config (`webinar.manage`).
 * `reviewerUserIds` is the reviewer pool's and `handouts` the handouts
 * routes'. No screen sends any of them through this route.
 */
export const ROUTE_OWNED_SETTINGS_KEYS = ["reviewerUserIds", "handouts", "cme", "reimbursement", "webinar"] as const;
const ROUTE_OWNED_SETTINGS = new Set<string>(ROUTE_OWNED_SETTINGS_KEYS);

/** The settings an event edit may write: everything but the route-owned keys. */
export function editableEventSettings(settings: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(settings).filter(([k]) => !ROUTE_OWNED_SETTINGS.has(k)));
}

/** The keys a caller may hold to reach the event edit at all. */
export const EVENT_EDIT_KEYS = ["events.update", "events.settings", "surveys.manage"] as const satisfies readonly PermissionKey[];

const SURVEY = new Set<string>(EVENT_SURVEY_FIELDS);
const SETTINGS = new Set<string>(EVENT_SETTINGS_FIELDS);

/**
 * The key one event field needs. A field on no list is a detail: that is the
 * key every field asked before, so an unclassified field never needs less.
 */
export function eventFieldPermission(field: string): PermissionKey {
  if (SURVEY.has(field)) return "surveys.manage";
  if (SETTINGS.has(field)) return "events.settings";
  return "events.update";
}

/** The distinct keys a set of event fields needs. */
export function eventFieldPermissions(fields: Iterable<string>): PermissionKey[] {
  return [...new Set([...fields].map(eventFieldPermission))];
}

/** The second key a bulk send of this type needs, beside `communications.send` or `.schedule`. */
export function bulkEmailTypePermission(emailType: unknown): PermissionKey | null {
  if (emailType === "certificate") return "certificates.issue";
  if (emailType === "survey-invitation") return "surveys.manage";
  return null;
}

/**
 * The keys an agent or MCP tool call needs BESIDE its tool key, from what the
 * call asks for. `update_event` sends only the fields it changes (it has an
 * allow-list and no form), so each field present counts.
 */
export function toolInputPermissions(toolName: string, input: Record<string, unknown> | undefined): PermissionKey[] {
  // Read tools whose RESULT spans other domains' people (Phase 6 review, Oct
  // 7, 2026): their tool key is `events.read`, but the search returns
  // attendees, speakers, abstract authors and contacts, and the dashboard the
  // latest registrations, with names and emails. Every built-in role that
  // may use the agent holds all of these, so only a narrower custom role
  // notices.
  const extra = RESULT_DOMAIN_KEYS[toolName] ?? [];
  if (!input) return [...extra];
  const own = inputPermissions(toolName, input);
  return [...new Set([...extra, ...own])];
}

const RESULT_DOMAIN_KEYS: Readonly<Record<string, readonly PermissionKey[]>> = {
  search_event: ["registrations.read", "speakers.read", "abstracts.read", "contacts.read"],
  get_event_dashboard: ["registrations.read"],
};

function inputPermissions(toolName: string, input: Record<string, unknown>): PermissionKey[] {
  if (toolName === "update_event") {
    return eventFieldPermissions(Object.keys(input).filter((k) => k !== "eventId" && input[k] !== undefined));
  }
  if (toolName === "send_bulk_email") {
    const key = bulkEmailTypePermission(input.emailType);
    return key ? [key] : [];
  }
  return [];
}

/** JSON with sorted object keys, so a jsonb round trip (which reorders keys) compares equal. */
function stableJson(value: unknown): string {
  return JSON.stringify(value, (_k, v) =>
    v && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(Object.keys(v as object).sort().map((k) => [k, (v as Record<string, unknown>)[k]]))
      : v,
  );
}

/** Whether an incoming event field value differs from the stored one. */
export function eventFieldChanged(field: string, incoming: unknown, stored: unknown): boolean {
  if (incoming === undefined) return false;
  const norm = (v: unknown): unknown => {
    if (v === undefined || v === "") return null;
    if (v instanceof Date) return v.getTime();
    if ((field === "startDate" || field === "endDate") && typeof v === "string") return new Date(v).getTime();
    // Prisma Decimal (taxRate) and a number compare by value.
    if (field === "taxRate" && v !== null && typeof v === "object") return Number(String(v));
    // The form sends 0 for "unlimited", which the route stores as null.
    if (field === "maxAttendees" && v === 0) return null;
    return v;
  };
  return stableJson(norm(incoming)) !== stableJson(norm(stored));
}

/**
 * The fields a PUT body would actually change. `settings` is merged key by key
 * on the server, so it changes when any key it carries differs.
 */
export function changedEventFields(body: Record<string, unknown>, stored: Record<string, unknown>): string[] {
  return Object.keys(body).filter((field) => {
    if (field === "settings") {
      const incoming = editableEventSettings((body.settings ?? {}) as Record<string, unknown>);
      const current = (stored.settings && typeof stored.settings === "object" ? stored.settings : {}) as Record<string, unknown>;
      return Object.keys(incoming).some((k) => eventFieldChanged(k, incoming[k], current[k]));
    }
    return eventFieldChanged(field, body[field], stored[field]);
  });
}
