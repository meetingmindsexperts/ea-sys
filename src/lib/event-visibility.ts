/**
 * WHICH FIELDS of an event a role may see.
 *
 * Sibling of `finance-visibility`, `barcode-visibility` and
 * `contact-visibility`, and deliberately separate from `event-access`: that
 * module answers WHICH events a role may see (the `where`), this one answers
 * what an event looks like once they can see it. Two different questions that
 * were previously both answered inline at each call site, which is how an
 * abstract submitter came to receive registration headcounts, the settings
 * JSON and the internal CC list.
 *
 * Everything here derives from `EVENT_CORE_SELECT`, so the list view and the
 * detail view cannot drift apart, and a column added to Event later cannot
 * join either payload by accident.
 */

import { isTeamRole } from "@/lib/auth-guards";

/**
 * The event facts any authenticated role may see: enough to name the event and
 * place it in time. Nothing configurable, nothing financial, nothing about who
 * else is involved.
 */
const EVENT_CORE_SELECT = {
  id: true,
  name: true,
  slug: true,
  status: true,
  description: true,
  startDate: true,
  endDate: true,
  timezone: true,
  venue: true,
} as const;

/** The events LIST renders exactly the core facts. */
export const EVENT_LIST_SELECT = EVENT_CORE_SELECT;

/**
 * Registration and speaker headcounts: ORGANISER data.
 *
 * A reviewer scores abstracts and a submitter submits their own; how many
 * people bought a ticket is outside both remits, so the counts are not fetched
 * for them rather than fetched and hidden in CSS.
 */
export const EVENT_LIST_COUNT_SELECT = {
  _count: { select: { registrations: true, speakers: true } },
} as const;

/**
 * The list select for a given role. Fails closed: an unrecognised role gets the
 * core facts, so a role added later and forgotten here loses the headcounts
 * rather than inheriting them.
 */
export function eventListSelect(role: string | null | undefined) {
  return isTeamRole(role)
    ? { ...EVENT_LIST_SELECT, ...EVENT_LIST_COUNT_SELECT }
    : EVENT_LIST_SELECT;
}

/**
 * The event DETAIL an org-null role receives: the core facts plus the banner
 * and the submission guidance their forms render.
 *
 * `GET /api/events/[eventId]` deliberately serves these roles — their pages
 * need the event's name, dates and guidance, and putting an org guard on it
 * once 403'd every submitter page for 13 days (the Aug 6, 2026 regression).
 * What it returned, though, was the whole row: the settings JSON, the auto-CC
 * list of internal staff addresses, badge and DTCM config, seat caps. Finance
 * columns were stripped by the redactor; nothing else was.
 */
export const RESTRICTED_EVENT_DETAIL_SELECT = {
  ...EVENT_CORE_SELECT,
  bannerImage: true,
  bannerImageMobile: true,
  // Submission guidance shown on the abstract / proposal forms.
  abstractGuidelinesHtml: true,
  abstractWelcomeHtml: true,
  sessionProposalWelcomeHtml: true,
  // The public "contact the organising team" address, already on every email
  // these people receive. Not the internal CC list, which stays out.
  emailFromAddress: true,
  // Narrowed by `pickRestrictedSettings` before the response is built. Selected
  // whole because Prisma cannot project inside a JSON column.
  settings: true,
} as const;

/**
 * Settings keys an org-null role's pages read:
 *  - `abstractPresentationTypes` drives the presentation-type picker
 *  - `sessionProposalDeadline` client-gates the proposal form
 *
 * Everything else in that blob is organiser business, and two of them are
 * pointed: `reviewerUserIds` would tell a submitter who is scoring their work,
 * and `surveyShareLink` holds a live token.
 */
export const RESTRICTED_SETTINGS_KEYS = [
  "abstractPresentationTypes",
  "sessionProposalDeadline",
] as const;

/**
 * Rebuild the settings blob from the allowed keys only. A whitelist, so a
 * settings key added later is invisible here until someone decides otherwise.
 *
 * Returns null when none are present, matching what an event with no settings
 * returns, so the client's existing "absent = default" handling is unchanged.
 */
export function pickRestrictedSettings(settings: unknown): Record<string, unknown> | null {
  if (!settings || typeof settings !== "object" || Array.isArray(settings)) return null;
  const source = settings as Record<string, unknown>;
  const picked: Record<string, unknown> = {};
  for (const key of RESTRICTED_SETTINGS_KEYS) {
    if (source[key] !== undefined) picked[key] = source[key];
  }
  return Object.keys(picked).length > 0 ? picked : null;
}
