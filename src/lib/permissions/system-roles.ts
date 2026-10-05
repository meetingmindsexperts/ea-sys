/**
 * THE SYSTEM ROLES, AS THE CODE BEHAVES TODAY (docs/CUSTOM_ROLES_PLAN.md §5,
 * Phase 1, Sep 30 2026).
 *
 * Each of the eight staff roles in `UserRole`, and the API key, expressed as
 * the set of (permission, scope) grants it holds. This file is the ONLY
 * definition: a system role row in the database carries no grants, so a
 * permission added by a later feature reaches every tenant the day it ships
 * (plan §3.3), and cloning a system role snapshots this list at that moment.
 *
 * TAKEN FROM THE PREDICATES AND THE ROUTE GUARDS, NOT FROM THE DOCS. Where a
 * cell here disagrees with what a document says a role should do, the code
 * won and the difference is recorded in the plan (§7.6), never "fixed" here.
 * `system-roles-parity.test.ts` proves it: for every role and every existing
 * predicate, `can()` on this data gives the predicate's answer. Cells no
 * predicate decides (a route's own guard) are pinned by the Phase 2 route
 * matrix as each domain is swept.
 *
 * NOTHING IN PRODUCTION CALLS THIS YET. Every route still asks its predicate;
 * this is the reference the sweep is checked against.
 *
 * Client-safe: constants and pure functions only.
 */
import type { PermissionKey, PersonGrant } from "./catalogue";

/** Where an event-bound grant applies (plan §3.1). */
export type GrantScope = "ALL" | "ASSIGNED" | "WEBINAR";

export interface Grant {
  permission: PermissionKey;
  /** Required on an event-bound key, absent on an organisation-wide one. */
  scope?: GrantScope;
}

export type SystemRoleKey =
  | "SUPER_ADMIN"
  | "ADMIN"
  | "ORGANIZER"
  | "MEMBER"
  | "ONSITE"
  | "WEBINARS"
  | "CRM_USER"
  | "HR_USER"
  | "API_KEY";

/**
 * The parts of the app a role WORKS IN (plan §3.5 `modules`; owner, Oct 5,
 * 2026): what its sidebar offers, and later what the middleware lets it open.
 * Keys decide what it may DO; areas decide where it is sent. They differ on
 * purpose: ONSITE holds read keys for speakers and the agenda (its desk form
 * reads them) but works only the desk, so its sidebar offers only the desk.
 *
 *   dashboard  the dashboard
 *   events     an event's full workspace (scoped like a grant)
 *   desk       an event's Registrations and Check-In (scoped like a grant)
 *   org        the organisation-level pages (analytics, contacts, invoices,
 *              media, agent, settings, activity, infra)
 *   crm, hr, procurement   those modules
 *   operator   the platform operator's pages (logs, lookup, backups, docs)
 */
export type Area = "dashboard" | "events" | "desk" | "org" | "crm" | "hr" | "procurement" | "operator";

export interface AreaGrant {
  area: Area;
  /** For `events` and `desk`: which events. Absent means every event. */
  scope?: GrantScope;
}

export interface SystemRole {
  key: SystemRoleKey;
  name: string;
  /** The `UserRole` value this is the system role of; null for the API key. */
  baseRole: string | null;
  grants: readonly Grant[];
  /**
   * Person grants (plan §3.4) this role carries by itself. SUPER_ADMIN and
   * HR_USER read HR with no tick on the person (`HR_SELF_SUFFICIENT_ROLES`).
   */
  impliedPersonGrants: readonly PersonGrant[];
  /** The parts of the app this role works in (see `Area`). */
  areas: readonly AreaGrant[];
}

const STAFF_AREAS: readonly AreaGrant[] = [
  { area: "dashboard" },
  { area: "events", scope: "ALL" },
  { area: "desk", scope: "ALL" },
  { area: "org" },
  { area: "crm" },
  { area: "hr" },
  { area: "procurement" },
];

const at = (scope: GrantScope, ...keys: PermissionKey[]): Grant[] => keys.map((permission) => ({ permission, scope }));
const org = (...keys: PermissionKey[]): Grant[] => keys.map((permission) => ({ permission }));

// ── Building blocks, named for the boundary they come from ──────────────────

/** Read-only event keys every org-wide staff role reads (MEMBER, the read-everything role, defines the set). */
const EVENT_READ: PermissionKey[] = [
  "events.read",
  "registrations.read",
  "speakers.read",
  "abstracts.read",
  "proposals.read",
  "sessions.read",
  "tickets.read",
  "promo.read",
  "accommodation.read",
  "invoices.read",
  "invoices.export",
  "templates.read",
  "sponsors.read",
  "surveys.read",
  "webinar.analytics.read",
  "analytics.read",
];

/** `REGISTRATION_DESK_ALLOW`: what a desk role does beside reading. */
const DESK: PermissionKey[] = ["registrations.create", "registrations.update", "registrations.checkin", "registrations.badges.print", "payments.record"];

/** What ONSITE and WEBINARS hold on the desk that MEMBER does not (the barcode boundary). */
const DESK_WITH_CODES: PermissionKey[] = ["registrations.export", "dtcm.assign"];

/**
 * Every event-domain key an ORGANIZER holds (`WRITE_ROLES` with no allow-list
 * plus everything above), which is the same set an ADMIN holds. Only
 * `abstracts.delete` is missing: it is SUPER_ADMIN's alone.
 */
const ORGANIZER_EVENT: PermissionKey[] = [
  ...EVENT_READ,
  ...DESK,
  ...DESK_WITH_CODES,
  // `email-logs` and `email-activity` are WRITE_ROLES plus WEBINAR_STAFF_ALLOW: not MEMBER.
  "emailLogs.read",
  "events.create",
  "events.update",
  "events.delete",
  "events.clone",
  // The whole event as one ZIP (Sep 30, 2026): ADMIN and ORGANIZER only.
  "events.export",
  // The event media library: not in EVENT_READ, because MEMBER was always
  // refused it (owner kept that, Oct 5, 2026).
  "media.read",
  // The DTCM spreadsheet import and the EventsAir import: ADMIN and ORGANIZER.
  "dtcm.import",
  "imports.eventsair",
  "events.settings",
  "registrations.delete",
  "registrations.import",
  "registrations.bulk",
  "registrations.email",
  "registrations.email.change",
  // Registration share links (Sep 29, 2026): ADMIN and ORGANIZER, as
  // `submissions.share`.
  "registrations.share",
  "registrations.promo.apply",
  "payments.refund",
  "registrations.cancel",
  "creditNotes.issue",
  "invoices.write",
  "invoices.send",
  "speakers.create",
  "speakers.update",
  "speakers.delete",
  "speakers.import",
  "speakers.email",
  "speakers.agreements.manage",
  "speakers.documents.read",
  "speakers.documents.write",
  "speakers.documents.open",
  "speakers.companion.grant",
  "abstracts.update",
  "abstracts.decide",
  "abstracts.import",
  "abstracts.email",
  "abstracts.reviewers.assign",
  "abstracts.themes.manage",
  "abstracts.criteria.manage",
  "reviewers.pool.manage",
  "submissions.share",
  "abstracts.export",
  "proposals.export",
  "proposals.decide",
  "proposals.themes.manage",
  "sessions.write",
  "sessions.delete",
  "tracks.write",
  "zoom.meetings.manage",
  "tickets.write",
  "tickets.delete",
  "promo.write",
  "promo.delete",
  "accommodation.write",
  "accommodation.delete",
  "hotels.manage",
  "communications.send",
  "communications.schedule",
  "templates.manage",
  // Certificate templates GET is `denyReviewer`: not a MEMBER read.
  "certificates.read",
  "certificates.templates.manage",
  "certificates.issue",
  "certificates.reissue",
  "webinar.manage",
  "webinar.attendance.export",
  "sponsors.manage",
  "media.manage",
  "reimbursements.manage",
  "honorarium.manage",
  "travelGrants.manage",
  "rsvp.manage",
  "rsvp.roster.read",
  "surveys.manage",
  "surveys.export",
  // Resetting a submitted survey is ADMIN and ORGANIZER only, not the webinar
  // team on webinars (owner, the survey reset route).
  "surveys.reset",
  "activity.read",
];

/** `WEBINAR_STAFF_ALLOW`: the ~55 route files WEBINARS controls on webinar events. */
const WEBINARS_MANAGE: PermissionKey[] = [
  "events.create",
  "events.update",
  "events.settings",
  "registrations.import",
  "registrations.bulk",
  "registrations.email",
  "registrations.email.change",
  "invoices.read",
  // The webinar's invoice CSV (recorded by the money matrix, Oct 5, 2026).
  "invoices.export",
  "speakers.read",
  "speakers.create",
  "speakers.update",
  "speakers.delete",
  "speakers.import",
  "speakers.email",
  "sessions.read",
  "sessions.write",
  "sessions.delete",
  "tracks.write",
  "zoom.meetings.manage",
  "tickets.read",
  "tickets.write",
  "tickets.delete",
  "communications.send",
  "communications.schedule",
  "templates.read",
  "templates.manage",
  "webinar.manage",
  "webinar.analytics.read",
  "webinar.attendance.export",
  "sponsors.read",
  "sponsors.manage",
  "media.read",
  "media.manage",
  "surveys.read",
  "surveys.manage",
  "surveys.export",
  "analytics.read",
];

/** `PROCUREMENT_READ_ROLES`, and what `hasAnyProcurementGrant` lets a grant holder see. */
const PROCUREMENT_VIEW: PermissionKey[] = ["procurement.budgets.view", "procurement.requests.view", "procurement.orders.view", "procurement.suppliers.view"];

/** `BUDGET_AUTHOR_ROLES` (`canAuthorBudgets`). */
const BUDGET_AUTHOR: PermissionKey[] = ["procurement.budgets.create", "procurement.budgets.edit", "procurement.budgets.discard"];

/** The organisation-level keys an ORGANIZER holds beside its events. */
const ORGANIZER_ORG: PermissionKey[] = [
  // The Onsite Staff tab: ORGANIZER's one users power (create and assign ONSITE accounts).
  "events.staff.assign",
  // Email history beyond events (contacts, team members, organisation mail),
  // and the organisation media library: ADMIN and ORGANIZER, as their
  // `denyReviewer` gates (custom roles Phase 2, Oct 5, 2026).
  "emailLogs.org.read",
  "media.library.manage",
  // The team list and a colleague's record (Settings, the Onsite Staff card,
  // the activity feed's people filter). Owner, Oct 5, 2026: staff whose screens
  // use it; ONSITE, WEBINARS, CRM_USER and HR_USER no longer read it.
  "users.read",
  "invoices.ledger",
  "billingAccounts.read",
  "billingAccounts.manage",
  "contacts.read",
  "contacts.write",
  "contacts.delete",
  "contacts.import",
  "contacts.export",
  "crm.read",
  "crm.write",
  "crm.inbox.read",
  "crm.dealValues.view",
  ...PROCUREMENT_VIEW,
  ...BUDGET_AUTHOR,
  "procurement.suppliers.financials.view",
  "agent.use",
  "mcp.connect",
  "finance.view",
  "barcode.view",
  "honorarium.view",
  "supportingDocs.view",
  "zoomHost.view",
];

/** What ADMIN holds above ORGANIZER: the organisation, and the module-wide CRM and procurement powers. */
const ADMIN_EXTRA: PermissionKey[] = [
  "org.settings",
  "org.credentials",
  "users.invite",
  "users.manage",
  "apiKeys.manage",
  "loginActivity.read",
  "activity.org.read",
  "crm.delete",
  "crm.export",
  "crm.quoteDefaults.manage",
  "procurement.requests.manage",
  "procurement.catalogue.manage",
  "procurement.integrations.manage",
  "procurement.suppliers.transfer",
  // commitment-service: `actsOnOrder` (send, receive) and cancel admit
  // `canAdminProcurement`, which is ADMIN and SUPER_ADMIN by role.
  "procurement.orders.send",
  "procurement.orders.receive",
  "procurement.orders.cancel",
];

const ORGANIZER_GRANTS: Grant[] = [...at("ALL", ...ORGANIZER_EVENT), ...org(...ORGANIZER_ORG)];
const ADMIN_GRANTS: Grant[] = [...ORGANIZER_GRANTS, ...org(...ADMIN_EXTRA)];

export const SYSTEM_ROLES: Readonly<Record<SystemRoleKey, SystemRole>> = {
  SUPER_ADMIN: {
    key: "SUPER_ADMIN",
    name: "Super Admin",
    baseRole: "SUPER_ADMIN",
    grants: [
      ...ADMIN_GRANTS,
      // SUPER_ADMIN alone: abstract delete (route check), CRM purge, the roles
      // editor (`denyNonRoleAdmin`), INTERNAL-tier API keys and OAuth clients,
      // and deciding suppliers by role
      // (`canDecideSuppliers`). HR without a tick on the person.
      ...at("ALL", "abstracts.delete"),
      ...org("crm.purge", "roles.manage", "apiKeys.internalTier", "procurement.approvalChain.manage", "procurement.suppliers.decide", "hr.read", "hr.write"),
    ],
    impliedPersonGrants: ["hrAccess"],
    areas: [...STAFF_AREAS, { area: "operator" }],
  },
  ADMIN: {
    key: "ADMIN",
    name: "Admin",
    baseRole: "ADMIN",
    // HR only with the per-person tick: `hr.read` / `hr.write` are held, and
    // `can()` refuses them until `hrAccess` is set (plan §3.4).
    grants: [...ADMIN_GRANTS, ...org("hr.read", "hr.write")],
    impliedPersonGrants: [],
    areas: STAFF_AREAS,
  },
  ORGANIZER: {
    key: "ORGANIZER",
    name: "Organizer",
    baseRole: "ORGANIZER",
    // Org-wide, never "assigned events only" (the code, not the old docs).
    // Its ONSITE-only invite is `events.staff.assign`, not `users.invite`.
    grants: [...ORGANIZER_GRANTS, ...org("hr.read", "hr.write")],
    impliedPersonGrants: [],
    areas: STAFF_AREAS,
  },
  MEMBER: {
    key: "MEMBER",
    name: "Member",
    baseRole: "MEMBER",
    // Internal read-everything staff, money included (June 17 2026), with the
    // desk. No codes, no export, no supporting documents, no per-event
    // activity (`canWrite`), no RSVP roster. Lists a speaker's documents but
    // cannot open the files (`speakers.documents.open`; owner, Oct 2, 2026).
    grants: [
      ...at("ALL", ...EVENT_READ, ...DESK, "speakers.documents.read"),
      ...org("invoices.ledger", "billingAccounts.read", "users.read", "contacts.read", "contacts.export", "crm.read", ...PROCUREMENT_VIEW, "agent.use", "finance.view", "hr.read", "hr.write"),
    ],
    impliedPersonGrants: [],
    areas: STAFF_AREAS,
  },
  ONSITE: {
    key: "ONSITE",
    name: "Onsite Staff",
    baseRole: "ONSITE",
    // The desk on assigned events only; sees amounts and codes. It reads the
    // event's registration types (the desk's add-registration form needs
    // them) and promo codes, which the route matrix recorded on Oct 1, 2026
    // and the owner kept (plan §6 Phase 2, "Registration types and promo codes");
    // and the agenda (sessions and tracks), recorded Oct 2, 2026, kept the
    // same way so nobody's access changes; and speakers, which the desk reads
    // to fill in a registration (owner, Oct 2, 2026); and the webinar
    // console's reads, recorded Oct 2, 2026 and kept as found by the owner.
    grants: [
      ...at("ASSIGNED", "events.read", "registrations.read", "tickets.read", "promo.read", "sessions.read", "speakers.read", "abstracts.read", "proposals.read", "webinar.analytics.read", ...DESK, ...DESK_WITH_CODES),
      // The assigned event's invoices, quotes and invoice CSV, and the payer
      // list its add-registration form reads: recorded by the money matrix and
      // kept by the owner, Oct 5, 2026. NOT the organisation's invoice book
      // (`invoices.ledger`), which it read across every event before (fixed).
      ...at("ASSIGNED", "invoices.read", "invoices.export"),
      // The assigned event's analytics and sponsors (the desk's sponsor picker),
      // recorded by the remaining-routes matrix and kept as found, Oct 5, 2026.
      ...at("ASSIGNED", "analytics.read", "sponsors.read"),
      ...org("finance.view", "barcode.view", "billingAccounts.read", "hr.read", "hr.write"),
    ],
    impliedPersonGrants: [],
    areas: [{ area: "desk", scope: "ASSIGNED" }],
  },
  WEBINARS: {
    key: "WEBINARS",
    name: "Webinars",
    baseRole: "WEBINARS",
    // Two tiers (Aug 10 2026): the desk on EVERY event, full control on
    // WEBINAR events. `emailLogs.read` rides on the desk, confined to
    // registration emails (review M-1). Never refunds, cancels, deletes a
    // registration (L-4), certificates, contacts, the ledger, or the agent.
    grants: [
      ...at("ALL", "events.read", "registrations.read", ...DESK, ...DESK_WITH_CODES, "emailLogs.read"),
      ...at("WEBINAR", ...WEBINARS_MANAGE),
      // Reads a webinar's promo codes (no write: promo codes are hidden on
      // webinars); recorded by the route matrix, kept by the owner, Oct 1, 2026.
      ...at("WEBINAR", "promo.read"),
      // Reads a webinar's abstracts and session proposals (and their themes),
      // recorded by the route matrix and kept as found, Oct 2, 2026.
      ...at("WEBINAR", "abstracts.read", "proposals.read"),
      // The payer list the desk's add-registration form reads (recorded by
      // the money matrix, kept as found, Oct 5, 2026).
      ...org("finance.view", "barcode.view", "zoomHost.view", "billingAccounts.read", "hr.read", "hr.write"),
    ],
    impliedPersonGrants: [],
    areas: [{ area: "desk", scope: "ALL" }, { area: "events", scope: "WEBINAR" }, { area: "procurement" }],
  },
  CRM_USER: {
    key: "CRM_USER",
    name: "CRM User",
    baseRole: "CRM_USER",
    grants: org("crm.read", "crm.write", "crm.delete", "crm.inbox.read", "crm.dealValues.view", "contacts.read", "hr.read", "hr.write"),
    impliedPersonGrants: [],
    areas: [{ area: "crm" }],
  },
  HR_USER: {
    key: "HR_USER",
    name: "HR User",
    baseRole: "HR_USER",
    grants: org("hr.read", "hr.write"),
    impliedPersonGrants: ["hrAccess"],
    areas: [{ area: "hr" }],
  },
  API_KEY: {
    key: "API_KEY",
    name: "API key (full)",
    baseRole: null,
    // WHAT A KEY REACHES, not "admin if it could": the MCP tools (mapped in
    // tool-permissions.ts) and the few REST routes that authenticate a key
    // (contacts, CRM, four event reads); every other route calls `auth()`.
    // Derived and pinned by api-key-reach.test.ts. The first draft of this row
    // was some forty cells wider (refunds, deletes, certificate issue), which a
    // sweep would have turned into real power for a leaked key.
    grants: [
      ...at(
        "ALL",
        "events.read",
        "events.create",
        "events.update",
        "events.settings",
        "registrations.read",
        "registrations.create",
        "registrations.update",
        "registrations.checkin",
        "registrations.bulk",
        "registrations.export",
        "invoices.read",
        "invoices.write",
        "invoices.send",
        "speakers.read",
        "speakers.create",
        "speakers.update",
        "speakers.agreements.manage",
        "abstracts.read",
        "abstracts.decide",
        "abstracts.reviewers.assign",
        "abstracts.themes.manage",
        "abstracts.criteria.manage",
        "sessions.read",
        "sessions.write",
        "tracks.write",
        "zoom.meetings.manage",
        "tickets.read",
        "tickets.write",
        "promo.read",
        "promo.write",
        "promo.delete",
        "accommodation.read",
        "accommodation.write",
        "hotels.manage",
        "communications.send",
        "communications.schedule",
        "templates.read",
        "templates.manage",
        "certificates.read",
        "certificates.templates.manage",
        "webinar.analytics.read",
        "sponsors.read",
        "sponsors.manage",
        "media.read",
        "rsvp.roster.read",
        "analytics.read",
      ),
      ...org(
        "contacts.read",
        "contacts.write",
        "contacts.delete",
        "contacts.import",
        "contacts.export",
        "crm.read",
        "crm.write",
        "crm.delete",
        "crm.export",
        "crm.inbox.read",
        "crm.dealValues.view",
        "finance.view",
        "barcode.view",
        "zoomHost.view",
      ),
    ],
    impliedPersonGrants: [],
    areas: [],
  },
};

export const SYSTEM_ROLE_KEYS = Object.keys(SYSTEM_ROLES) as SystemRoleKey[];

/** The system role behind a caller: by base role, or the API key for a role-less key caller. */
export function systemRoleFor(role: string | null | undefined, fromApiKey = false): SystemRole | null {
  if (fromApiKey) return SYSTEM_ROLES.API_KEY;
  if (!role) return null;
  const found = SYSTEM_ROLE_KEYS.map((k) => SYSTEM_ROLES[k]).find((r) => r.baseRole === role);
  return found ?? null;
}

/**
 * THE TRANSITION ARM. The four procurement columns on `User` still grant
 * access on their own (`procurement-visibility.ts`: `canRequestProcurement`
 * is the key OR the column), until PROCUREMENT_ROLES_PLAN §10a retires them.
 * `systemPrincipal()` turns a set column into these grants, so `can()` gives
 * the same answer the predicates give today. When the columns go, this goes.
 */
export const LEGACY_PROCUREMENT_GRANTS: Readonly<Record<"request" | "settle" | "approveCeiling" | "approveUnlimited", readonly Grant[]>> = {
  // Raise (`need: "request"`), propose a supplier (request OR settle), and act
  // on one's OWN order (commitment-service `actsOnOrder`: the requester of that
  // request sends and receives it). The "own order" condition is a row rule no
  // key expresses; the service keeps it (plan §5, recorded).
  request: org(...PROCUREMENT_VIEW, "procurement.requests.create", "procurement.orders.send", "procurement.orders.receive", "procurement.suppliers.propose"),
  // Settle (`need: "settle"` and commitment-service): sign-off, supplier edit
  // and decision, and every order action including the large-receipt check.
  settle: org(
    ...PROCUREMENT_VIEW,
    "procurement.budgets.signoff",
    "procurement.suppliers.decide",
    "procurement.suppliers.edit",
    "procurement.suppliers.financials.view",
    "procurement.suppliers.propose",
    "procurement.orders.cancel",
    "procurement.orders.send",
    "procurement.orders.receive",
    "procurement.orders.confirmReceipt",
  ),
  // An approver (any ceiling) is the second pair of eyes on a large receipt.
  approveCeiling: org(...PROCUREMENT_VIEW, "procurement.approvals.decide", "procurement.orders.confirmReceipt"),
  approveUnlimited: org(...PROCUREMENT_VIEW, "procurement.approvals.decide", "procurement.orders.confirmReceipt", "procurement.suppliers.decide"),
};
