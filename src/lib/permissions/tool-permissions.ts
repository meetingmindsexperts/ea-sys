/**
 * Agent and MCP tools carry no permission keys of their own: each maps to the
 * permission of the operation it performs (docs/CUSTOM_ROLES_PLAN.md §4,
 * Phase 1). Two uses:
 *
 *  1. THE API KEY'S REAL REACH. A key reaches the MCP tools and the handful of
 *     REST routes that authenticate through `getOrgContext`; every other route
 *     calls `auth()` and answers 401 to a key. The "API key (full)" system
 *     role is therefore derived from this file and `REST_API_KEY_PERMISSIONS`,
 *     and `api-key-reach.test.ts` proves the registry, this map and the system
 *     role agree, so a tool added without a mapping fails CI rather than
 *     silently widening or narrowing what a key can do.
 *  2. THE TOOL GATE. Every agent and role-keyed MCP call asks
 *     `can(principal, TOOL_PERMISSIONS[name])`. Until Oct 7, 2026 the gate kept
 *     its own copy in src/lib/agent/tool-permissions.ts, and eleven tools had
 *     drifted between the two (Phase 6 review): a key given the "API key
 *     (full)" role was refused tools that role claimed to cover. This is now
 *     the one list; the agent module re-exports it.
 *
 * Client-safe: constants only.
 */
import type { PermissionKey } from "./catalogue";

export const TOOL_PERMISSIONS: Readonly<Record<string, PermissionKey>> = {
  // Events
  list_events: "events.read",
  search_event: "events.read",
  get_event_info: "events.read",
  get_event_stats: "events.read",
  get_event_dashboard: "events.read",
  create_event: "events.create",
  update_event: "events.update",
  get_event_analytics: "analytics.read",
  // Contacts
  list_contacts: "contacts.read",
  create_contact: "contacts.write",
  update_contact: "contacts.write",
  // Program
  list_tracks: "sessions.read",
  list_sessions: "sessions.read",
  list_live_sessions_now: "sessions.read",
  list_zoom_meetings: "sessions.read",
  create_track: "tracks.write",
  create_session: "sessions.write",
  update_session: "sessions.write",
  add_topic_to_session: "sessions.write",
  add_speaker_to_session: "sessions.write",
  remove_speaker_from_session: "sessions.write",
  replace_session_speakers: "sessions.write",
  create_zoom_meeting: "zoom.meetings.manage",
  // Speakers
  list_speakers: "speakers.read",
  list_speaker_agreements: "speakers.read",
  get_speaker_agreement_template: "speakers.read",
  create_speaker: "speakers.create",
  create_speakers_bulk: "speakers.import",
  update_speaker: "speakers.update",
  upload_speaker_agreement_template: "speakers.agreements.manage",
  // Registrations and types
  list_ticket_types: "tickets.read",
  create_ticket_type: "tickets.write",
  list_registrations: "registrations.read",
  create_registration: "registrations.create",
  create_registrations_bulk: "registrations.import",
  update_registration: "registrations.update",
  bulk_update_registration_status: "registrations.bulk",
  check_in_registration: "registrations.checkin",
  list_unpaid_registrations: "finance.view",
  list_promo_codes: "promo.read",
  create_promo_code: "promo.write",
  update_promo_code: "promo.write",
  delete_promo_code: "promo.delete",
  // Abstracts
  list_abstracts: "abstracts.read",
  list_abstract_themes: "abstracts.read",
  list_review_criteria: "abstracts.read",
  get_abstract_scores: "abstracts.read",
  list_reviewers: "reviewers.pool.manage",
  create_abstract_theme: "abstracts.themes.manage",
  create_review_criterion: "abstracts.criteria.manage",
  update_review_criterion: "abstracts.criteria.manage",
  update_abstract_status: "abstracts.decide",
  assign_reviewer_to_abstract: "abstracts.reviewers.assign",
  unassign_reviewer_from_abstract: "abstracts.reviewers.assign",
  submit_abstract_review: "abstracts.decide",
  admin_submit_review_on_behalf: "abstracts.decide",
  // Accommodation
  list_hotels: "accommodation.read",
  list_room_types: "accommodation.read",
  list_accommodations: "accommodation.read",
  create_hotel: "hotels.manage",
  create_room_type: "hotels.manage",
  update_room_type: "hotels.manage",
  delete_room_type: "hotels.manage",
  create_accommodation: "accommodation.write",
  update_accommodation_status: "accommodation.write",
  // Money
  list_invoices: "invoices.read",
  create_invoice: "invoices.write",
  send_invoice: "invoices.send",
  update_invoice_status: "invoices.write",
  // Communications
  list_email_templates: "templates.read",
  create_email_template: "templates.manage",
  update_email_template: "templates.manage",
  duplicate_email_template: "templates.manage",
  reset_email_template: "templates.manage",
  send_bulk_email: "communications.send",
  list_scheduled_emails: "communications.schedule",
  cancel_scheduled_email: "communications.schedule",
  list_media: "media.library.manage",
  // Certificates
  list_certificate_templates: "certificates.read",
  create_certificate_template: "certificates.templates.manage",
  update_certificate_template: "certificates.templates.manage",
  update_cme_settings: "certificates.templates.manage",
  // Webinar, sponsors, RSVP
  get_webinar_info: "webinar.analytics.read",
  list_webinar_attendance: "webinar.analytics.read",
  list_webinar_engagement: "webinar.analytics.read",
  list_sponsors: "sponsors.read",
  upsert_sponsors: "sponsors.manage",
  research_sponsor: "sponsors.manage",
  list_rsvps: "rsvp.roster.read",
  // CRM
  list_crm_pipeline: "crm.read",
  list_crm_deals: "crm.read",
  list_crm_deal_types: "crm.read",
  get_crm_deal: "crm.read",
  list_crm_companies: "crm.read",
  get_crm_company: "crm.read",
  list_crm_tasks: "crm.read",
  list_crm_contacts: "crm.read",
  list_crm_products: "crm.read",
  list_crm_deal_products: "crm.read",
  get_crm_report: "crm.read",
  create_crm_deal: "crm.write",
  update_crm_deal: "crm.write",
  move_crm_deal_stage: "crm.write",
  close_crm_deal: "crm.write",
  create_crm_company: "crm.write",
  update_crm_company: "crm.write",
  create_crm_task: "crm.write",
  complete_crm_task: "crm.write",
  add_crm_note: "crm.write",
  create_crm_contact: "crm.write",
  update_crm_contact: "crm.write",
  create_crm_product: "crm.write",
  update_crm_product: "crm.write",
  add_deal_product: "crm.write",
  update_deal_product: "crm.write",
  // Budgets
  list_budgets: "procurement.budgets.view",
  get_budget: "procurement.budgets.view",
  list_budget_categories: "procurement.budgets.view",
  list_budget_templates: "procurement.budgets.view",
  list_spend_requests: "procurement.requests.view",
  list_commitments: "procurement.orders.view",
  create_budget: "procurement.budgets.create",
  add_budget_lines: "procurement.budgets.edit",
  replace_budget_lines: "procurement.budgets.edit",
};

/** Tools that exist for a signed-in person but are refused to an API key by their own executor. */
export const TOOLS_REFUSED_TO_API_KEYS: ReadonlySet<string> = new Set([
  "list_budgets",
  "get_budget",
  "list_budget_categories",
  "list_budget_templates",
  "list_spend_requests",
  "list_commitments",
]);

/**
 * The REST routes that authenticate a key (`getOrgContext` or the CRM route
 * helper), and the permission each verb is. Every other route calls `auth()`.
 */
export const REST_API_KEY_PERMISSIONS: readonly { route: string; permission: PermissionKey }[] = [
  { route: "GET /api/events", permission: "events.read" },
  { route: "GET /api/events/[eventId]/registrations", permission: "registrations.read" },
  { route: "GET /api/events/[eventId]/registrations?export=csv", permission: "registrations.export" },
  { route: "GET /api/events/[eventId]/sessions", permission: "sessions.read" },
  { route: "GET /api/events/[eventId]/speakers", permission: "speakers.read" },
  { route: "GET /api/registration-types", permission: "tickets.read" },
  { route: "GET /api/contacts, /api/contacts/[contactId], /api/contacts/tags", permission: "contacts.read" },
  { route: "POST /api/contacts, PUT /api/contacts/[contactId], POST .../email, PATCH /api/contacts/bulk-tags", permission: "contacts.write" },
  { route: "DELETE /api/contacts/[contactId]", permission: "contacts.delete" },
  { route: "POST /api/contacts/import", permission: "contacts.import" },
  { route: "GET /api/contacts/export", permission: "contacts.export" },
  { route: "GET /api/crm/*", permission: "crm.read" },
  { route: "POST, PUT, PATCH /api/crm/* (requireCrmWrite: canOwnDeals)", permission: "crm.write" },
  { route: "archive and restore under /api/crm/* (canDeleteCrm)", permission: "crm.delete" },
  { route: "CSV export under /api/crm/reports (canExportCrm)", permission: "crm.export" },
  { route: "GET /api/crm/inbox (canViewCrmInbox)", permission: "crm.inbox.read" },
  { route: "deal values on /api/crm/* (canViewDealValues)", permission: "crm.dealValues.view" },
];

/** The field keys a key holds because the redaction predicates answer yes to `isApiKey`. */
export const API_KEY_FIELD_PERMISSIONS: readonly PermissionKey[] = ["finance.view", "barcode.view", "zoomHost.view"];
