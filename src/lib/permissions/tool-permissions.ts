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
 *  2. PHASE 3: the tool gate asks `can(principal, TOOL_PERMISSIONS[name])`
 *     instead of the role lists it uses today.
 *
 * Client-safe: constants only.
 */
import type { PermissionKey } from "./catalogue";

export const TOOL_PERMISSIONS: Readonly<Record<string, PermissionKey>> = {
  // Events
  create_event: "events.create",
  update_event: "events.update",
  update_cme_settings: "events.settings",
  get_event_analytics: "analytics.read",
  get_event_dashboard: "events.read",
  get_event_info: "events.read",
  get_event_stats: "events.read",
  list_events: "events.read",
  search_event: "events.read",
  // Registrations
  list_registrations: "registrations.read",
  list_unpaid_registrations: "registrations.read",
  create_registration: "registrations.create",
  create_registrations_bulk: "registrations.create",
  update_registration: "registrations.update",
  bulk_update_registration_status: "registrations.bulk",
  check_in_registration: "registrations.checkin",
  // Money
  list_invoices: "invoices.read",
  create_invoice: "invoices.write",
  update_invoice_status: "invoices.write",
  send_invoice: "invoices.send",
  // Speakers
  list_speakers: "speakers.read",
  create_speaker: "speakers.create",
  create_speakers_bulk: "speakers.create",
  update_speaker: "speakers.update",
  get_speaker_agreement_template: "speakers.agreements.manage",
  list_speaker_agreements: "speakers.agreements.manage",
  upload_speaker_agreement_template: "speakers.agreements.manage",
  // Abstracts. Submitting a review through a tool is a staff act on behalf of
  // the pool, so it sits with deciding; reviewers themselves hold no role.
  list_abstracts: "abstracts.read",
  get_abstract_scores: "abstracts.read",
  list_abstract_themes: "abstracts.read",
  list_review_criteria: "abstracts.read",
  list_reviewers: "abstracts.read",
  update_abstract_status: "abstracts.decide",
  submit_abstract_review: "abstracts.decide",
  admin_submit_review_on_behalf: "abstracts.decide",
  assign_reviewer_to_abstract: "abstracts.reviewers.assign",
  unassign_reviewer_from_abstract: "abstracts.reviewers.assign",
  create_abstract_theme: "abstracts.themes.manage",
  create_review_criterion: "abstracts.criteria.manage",
  update_review_criterion: "abstracts.criteria.manage",
  // Programme
  list_sessions: "sessions.read",
  list_live_sessions_now: "sessions.read",
  list_tracks: "sessions.read",
  list_zoom_meetings: "sessions.read",
  create_session: "sessions.write",
  update_session: "sessions.write",
  add_speaker_to_session: "sessions.write",
  add_topic_to_session: "sessions.write",
  remove_speaker_from_session: "sessions.write",
  replace_session_speakers: "sessions.write",
  create_track: "tracks.write",
  create_zoom_meeting: "zoom.meetings.manage",
  // Registration types and promo codes
  list_ticket_types: "tickets.read",
  create_ticket_type: "tickets.write",
  list_promo_codes: "promo.read",
  create_promo_code: "promo.write",
  update_promo_code: "promo.write",
  delete_promo_code: "promo.delete",
  // Accommodation
  list_accommodations: "accommodation.read",
  list_hotels: "accommodation.read",
  list_room_types: "accommodation.read",
  create_accommodation: "accommodation.write",
  update_accommodation_status: "accommodation.write",
  create_hotel: "hotels.manage",
  create_room_type: "hotels.manage",
  update_room_type: "hotels.manage",
  delete_room_type: "hotels.manage",
  // Communications
  send_bulk_email: "communications.send",
  list_scheduled_emails: "communications.schedule",
  cancel_scheduled_email: "communications.schedule",
  list_email_templates: "templates.read",
  create_email_template: "templates.manage",
  update_email_template: "templates.manage",
  reset_email_template: "templates.manage",
  duplicate_email_template: "templates.manage",
  // Certificates
  list_certificate_templates: "certificates.read",
  create_certificate_template: "certificates.templates.manage",
  update_certificate_template: "certificates.templates.manage",
  // Webinar, sponsors, media
  get_webinar_info: "webinar.analytics.read",
  list_webinar_attendance: "webinar.analytics.read",
  list_webinar_engagement: "webinar.analytics.read",
  list_sponsors: "sponsors.read",
  upsert_sponsors: "sponsors.manage",
  research_sponsor: "sponsors.manage",
  list_media: "media.read",
  // Faculty extras
  list_rsvps: "rsvp.roster.read",
  // Contacts
  list_contacts: "contacts.read",
  create_contact: "contacts.write",
  update_contact: "contacts.write",
  // CRM
  list_crm_companies: "crm.read",
  list_crm_contacts: "crm.read",
  list_crm_deal_products: "crm.read",
  list_crm_deal_types: "crm.read",
  list_crm_deals: "crm.read",
  list_crm_pipeline: "crm.read",
  list_crm_products: "crm.read",
  list_crm_tasks: "crm.read",
  get_crm_company: "crm.read",
  get_crm_deal: "crm.read",
  get_crm_report: "crm.read",
  create_crm_company: "crm.write",
  create_crm_contact: "crm.write",
  create_crm_deal: "crm.write",
  create_crm_product: "crm.write",
  create_crm_task: "crm.write",
  update_crm_company: "crm.write",
  update_crm_contact: "crm.write",
  update_crm_deal: "crm.write",
  update_crm_product: "crm.write",
  update_deal_product: "crm.write",
  add_deal_product: "crm.write",
  add_crm_note: "crm.write",
  close_crm_deal: "crm.write",
  complete_crm_task: "crm.write",
  move_crm_deal_stage: "crm.write",
  // Budgets and Procurement (registered only while the module is on; refused to a key)
  list_budgets: "procurement.budgets.view",
  get_budget: "procurement.budgets.view",
  list_budget_categories: "procurement.budgets.view",
  list_budget_templates: "procurement.budgets.view",
  list_spend_requests: "procurement.requests.view",
  list_commitments: "procurement.orders.view",
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
