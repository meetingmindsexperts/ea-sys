/**
 * THE PERMISSION CATALOGUE: every capability a custom role can grant.
 *
 * Plan of record: docs/PROCUREMENT_ROLES_PLAN.md. A custom role ("PO Author")
 * is a named set of these keys, tagged onto a person on top of their base role
 * (D1, D2). One person may hold several; their capability is the UNION.
 *
 * WHY THE CATALOGUE LIVES IN CODE AND NOT IN A TABLE. A key is only meaningful
 * because a route asks for it, so the set of valid keys is a property of the
 * deployed build, not of the data. Holding them in a table would let a row name
 * a permission nothing enforces, which reads as access and grants none. The
 * join table stores keys and is validated against this file on write.
 *
 * WHY IT LIVES IN CORE AND NOT IN `src/procurement/`. Settings, the sidebar and
 * the dashboard layout all need it, and each would otherwise be an exemption on
 * the one-way import boundary: the same reasoning that placed
 * `procurement-visibility.ts` and `module-flags.ts` here. Client-safe by
 * construction: no db, no Node imports, no `next/server`.
 *
 * NAMESPACED (`procurement.*`) because D5 reuses these three tables for CRM and
 * HR. A future module adds its own block; nothing here changes.
 *
 * EXTENDED TO THE WHOLE APPLICATION on Sep 30, 2026 (docs/CUSTOM_ROLES_PLAN.md
 * Phase 1, §4): every operation a staff role performs is a key here, with three
 * flags the procurement keys never needed:
 *   eventBound   the key takes a scope (ALL / ASSIGNED / WEBINAR) and a check
 *                needs an event;
 *   sensitive    the role editor warns before granting it (plan §8.3);
 *   personGrant  the key does nothing without a grant on the PERSON as well
 *                (plan §3.4): HR access, or the procurement approval ceiling.
 * And one flag that keeps this additive: `live`. A key is live when routes
 * check it. The system roles (system-roles.ts) hold every key and `can()`
 * answers for every key, but the editor offers and the service stores ONLY
 * live keys, so a custom role cannot be given a key nothing enforces yet.
 * Phase 2 flips a domain's keys to live as it is swept.
 */

/** Every capability a custom role can grant today. Order is display order. */
export const PERMISSION_KEYS = [
  // Budgets
  "procurement.budgets.view",
  "procurement.budgets.create",
  "procurement.budgets.edit",
  "procurement.budgets.discard",
  "procurement.budgets.signoff",
  // Approvals
  "procurement.approvals.decide",
  // Spend requests
  "procurement.requests.view",
  "procurement.requests.create",
  "procurement.requests.manage",
  // Purchase orders
  "procurement.orders.view",
  "procurement.orders.receive",
  "procurement.orders.cancel",
  "procurement.orders.confirmReceipt",
  "procurement.orders.send",
  // Suppliers
  "procurement.suppliers.view",
  "procurement.suppliers.propose",
  "procurement.suppliers.decide",
  "procurement.suppliers.edit",
  "procurement.suppliers.financials.view",
  // Catalogue
  "procurement.catalogue.manage",
  // Procurement administration (SUPER_ADMIN and ADMIN by role today)
  "procurement.integrations.manage",
  "procurement.suppliers.transfer",

  // ── The application (Phase 1, Sep 30 2026): defined, not yet live ──
  // Events
  "events.read",
  "events.create",
  "events.update",
  "events.delete",
  "events.clone",
  "events.settings",
  "events.staff.assign",
  // Registrations
  "registrations.read",
  "registrations.create",
  "registrations.update",
  "registrations.delete",
  "registrations.import",
  "registrations.export",
  "registrations.checkin",
  "registrations.badges.print",
  "registrations.bulk",
  "registrations.email",
  "dtcm.assign",
  // Money
  "payments.record",
  "payments.refund",
  "registrations.cancel",
  "creditNotes.issue",
  "invoices.read",
  "invoices.write",
  "invoices.send",
  "invoices.export",
  "invoices.ledger",
  "billingAccounts.read",
  "billingAccounts.manage",
  "registrations.promo.apply",
  // Speakers
  "speakers.read",
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
  // Abstracts
  "abstracts.read",
  "abstracts.update",
  "abstracts.decide",
  "abstracts.delete",
  "abstracts.import",
  "abstracts.email",
  "abstracts.reviewers.assign",
  "abstracts.themes.manage",
  "abstracts.criteria.manage",
  "reviewers.pool.manage",
  "submissions.share",
  // Session proposals
  "proposals.read",
  "proposals.decide",
  "proposals.themes.manage",
  // Programme
  "sessions.read",
  "sessions.write",
  "sessions.delete",
  "tracks.write",
  "zoom.meetings.manage",
  // Registration types and promo codes
  "tickets.read",
  "tickets.write",
  "tickets.delete",
  "promo.read",
  "promo.write",
  "promo.delete",
  // Accommodation
  "accommodation.read",
  "accommodation.write",
  "accommodation.delete",
  "hotels.manage",
  // Communications
  "communications.send",
  "communications.schedule",
  "templates.read",
  "templates.manage",
  "emailLogs.read",
  // Certificates
  "certificates.read",
  "certificates.templates.manage",
  "certificates.issue",
  "certificates.reissue",
  // Webinar
  "webinar.manage",
  "webinar.analytics.read",
  "webinar.attendance.export",
  "sponsors.read",
  "sponsors.manage",
  "media.read",
  "media.manage",
  // Faculty extras
  "reimbursements.manage",
  "honorarium.manage",
  "travelGrants.manage",
  "rsvp.manage",
  "rsvp.roster.read",
  "surveys.read",
  "surveys.manage",
  "surveys.export",
  // Analytics and audit
  "analytics.read",
  "activity.read",
  "activity.org.read",
  // Contacts
  "contacts.read",
  "contacts.write",
  "contacts.delete",
  "contacts.import",
  "contacts.export",
  // CRM
  "crm.read",
  "crm.write",
  "crm.delete",
  "crm.export",
  "crm.purge",
  "crm.inbox.read",
  "crm.dealValues.view",
  "crm.quoteDefaults.manage",
  // HR
  "hr.read",
  "hr.write",
  // Organisation
  "org.settings",
  "org.credentials",
  "users.invite",
  "users.manage",
  "roles.manage",
  "apiKeys.manage",
  "loginActivity.read",
  "agent.use",
  "mcp.connect",
  // Field visibility
  "finance.view",
  "barcode.view",
  "honorarium.view",
  "supportingDocs.view",
  "zoomHost.view",
] as const;

export type PermissionKey = (typeof PERMISSION_KEYS)[number];

const PERMISSION_KEY_SET: ReadonlySet<string> = new Set(PERMISSION_KEYS);

/** Is this string a permission this build actually enforces? Fails closed. */
export function isPermissionKey(key: string): key is PermissionKey {
  return PERMISSION_KEY_SET.has(key);
}

/** Groups for the role editor, in display order. */
export const PERMISSION_GROUPS = [
  "Events",
  "Registrations",
  "Money",
  "Speakers",
  "Abstracts",
  "Session proposals",
  "Programme",
  "Registration types and promo codes",
  "Accommodation",
  "Communications",
  "Certificates",
  "Webinar",
  "Faculty extras",
  "Analytics and audit",
  "Contacts",
  "CRM",
  "HR",
  "Organisation",
  "Field visibility",
  "Budgets",
  "Approvals",
  "Requests",
  "Orders",
  "Suppliers",
  "Catalogue",
] as const;

export type PermissionGroup = (typeof PERMISSION_GROUPS)[number];

/** A grant on the PERSON that a key also needs (plan §3.4). */
export type PersonGrant = "hrAccess" | "procurementApprove";

export interface PermissionDescriptor {
  key: PermissionKey;
  group: PermissionGroup;
  /** The checkbox label. Plain words: the reader is an administrator, not a developer. */
  label: string;
  /** One sentence under the label saying what it actually lets the person do. */
  description: string;
  /** Routes check this key. Only live keys can be put on a custom role. */
  live: boolean;
  /** Takes a scope; a check needs an event. Absent means an organisation-wide key. */
  eventBound?: true;
  /** The editor warns before granting it. */
  sensitive?: true;
  /** Does nothing without this grant on the person as well. */
  personGrant?: PersonGrant;
}

/** Shorthand for the application entries below: every one is not yet live. */
function app(
  key: PermissionKey,
  group: PermissionGroup,
  label: string,
  description: string,
  flags: { eventBound?: true; sensitive?: true; personGrant?: PersonGrant } = {},
): PermissionDescriptor {
  return { key, group, label, description, live: false, ...flags };
}
const E = { eventBound: true } as const;
const ES = { eventBound: true, sensitive: true } as const;
const S = { sensitive: true } as const;

/**
 * The catalogue itself. Every key above appears exactly once; a drift test
 * asserts both directions, because a key with no descriptor renders as a blank
 * checkbox and a descriptor with no key grants nothing.
 *
 * DELIBERATELY ABSENT: `budgets.reopen`. Owner decision D15 puts reopening a
 * closed budget and unfreezing a frozen one WITH budget authoring, so those
 * routes ask for `budgets.edit`. A separate key that is always ticked beside
 * another one is a key nobody can use differently.
 */
export const PERMISSION_CATALOGUE: readonly PermissionDescriptor[] = [
  {
    key: "procurement.budgets.view",
    group: "Budgets",
    live: true,
    label: "See the Budgets list",
    description: "Open the Budgets screen and read any budget for the organisation.",
  },
  {
    key: "procurement.budgets.create",
    group: "Budgets",
    live: true,
    label: "Create budgets",
    description: "Start a new budget for an event, from scratch or from a template.",
  },
  {
    key: "procurement.budgets.edit",
    group: "Budgets",
    live: true,
    label: "Edit and submit budgets",
    // Reopening a closed budget and unfreezing need the catalogue admin key
    // (the transition route asks `need: "admin"`), whatever D15 intended.
    description: "Change lines, submit for approval, reallocate, start a new version, freeze and close.",
  },
  {
    key: "procurement.budgets.discard",
    group: "Budgets",
    live: true,
    label: "Discard a draft budget",
    description: "Throw away a budget that was never approved. Approved budgets are never deleted.",
  },
  {
    key: "procurement.budgets.signoff",
    group: "Budgets",
    live: true,
    label: "Sign off a closed budget",
    description: "The finance sign-off that ends a budget after close-out.",
  },
  {
    key: "procurement.approvals.decide",
    group: "Approvals",
    live: true,
    // The AED authority lives on the PERSON (D3, D6); the key alone decides nothing.
    personGrant: "procurementApprove",
    label: "Approve or reject",
    description:
      "Decide budgets, reallocations and spend requests, up to the AED limit set on this person.",
  },
  {
    key: "procurement.requests.view",
    group: "Requests",
    live: true,
    label: "See spend requests",
    description: "Read the organisation's purchase requests.",
  },
  {
    key: "procurement.requests.create",
    group: "Requests",
    live: true,
    label: "Raise spend requests",
    description:
      "Raise a purchase request, attach quotes, submit it, and amend your own. Includes seeing the budget line you are spending against.",
  },
  {
    key: "procurement.requests.manage",
    group: "Requests",
    live: true,
    label: "Edit or cancel anyone's request",
    description: "Act on a request somebody else raised.",
  },
  {
    key: "procurement.orders.view",
    group: "Orders",
    live: true,
    label: "See purchase orders",
    description: "Read the orders issued against approved requests.",
  },
  {
    key: "procurement.orders.receive",
    group: "Orders",
    live: true,
    label: "Mark goods received",
    description: "Record a partial or full receipt against an order you raised.",
  },
  {
    key: "procurement.orders.cancel",
    group: "Orders",
    live: true,
    label: "Cancel an order",
    description: "Close an order and release what it had committed on the budget line.",
  },
  {
    key: "procurement.orders.confirmReceipt",
    group: "Orders",
    live: true,
    label: "Confirm a large receipt",
    description:
      "The second pair of eyes on a full receipt of AED 50,000 or more. Never the person who received it.",
  },
  {
    key: "procurement.orders.send",
    group: "Orders",
    live: true,
    label: "Send an order to the supplier",
    description: "Email the purchase order PDF to the supplier's contacts.",
  },
  {
    key: "procurement.suppliers.view",
    group: "Suppliers",
    live: true,
    label: "See suppliers",
    description: "Read the supplier master, without tax numbers or bank details.",
  },
  {
    key: "procurement.suppliers.propose",
    group: "Suppliers",
    live: true,
    label: "Propose a supplier",
    description: "Put a new supplier forward for approval.",
  },
  {
    key: "procurement.suppliers.decide",
    group: "Suppliers",
    live: true,
    label: "Approve or reject suppliers",
    description: "Decide a proposed supplier and let its waiting requests convert to orders.",
  },
  {
    key: "procurement.suppliers.edit",
    group: "Suppliers",
    live: true,
    label: "Edit suppliers",
    description: "Change an approved supplier's details, including bank details.",
  },
  {
    key: "procurement.suppliers.financials.view",
    group: "Suppliers",
    live: true,
    label: "See supplier tax and bank details",
    description: "Read the classified fields on a supplier record.",
  },
  {
    key: "procurement.catalogue.manage",
    group: "Catalogue",
    live: true,
    label: "Manage the catalogue",
    description: "Add and edit products, budget templates and cost categories.",
  },
  app("procurement.integrations.manage", "Organisation", "Connect accounting", "Connect, test and disconnect the QuickBooks connector for the organisation."),
  app("procurement.suppliers.transfer", "Suppliers", "Import and export suppliers", "Move the supplier master in and out as a spreadsheet."),

  // ── Events ──
  app("events.read", "Events", "See events", "Open the events list and an event's pages.", E),
  app("events.create", "Events", "Create events", "Create a new event. Under a webinar-only scope the event must be a webinar.", E),
  app("events.update", "Events", "Edit events", "Change an event's details, dates, venue and status.", E),
  app("events.delete", "Events", "Delete events", "Remove an event and everything under it.", ES),
  app("events.clone", "Events", "Clone events", "Copy an event with its setup into a new one.", E),
  app("events.settings", "Events", "Event settings and content", "Settings, Content and Readiness: sender, tax and bank details, terms, webinar and Zoom settings.", E),
  app("events.staff.assign", "Events", "Onsite staff", "Create temporary desk accounts and assign them to events (the Onsite Staff tab)."),

  // ── Registrations ──
  app("registrations.read", "Registrations", "See registrations", "Open the registrations list and a registration's details and activity.", E),
  app("registrations.create", "Registrations", "Add registrations", "Register somebody from the dashboard.", E),
  app("registrations.update", "Registrations", "Edit registrations", "Change an attendee's details, type, tags and notes.", E),
  app("registrations.delete", "Registrations", "Delete registrations", "Remove a registration row. Cancelling with a refund is a separate permission.", ES),
  app("registrations.import", "Registrations", "Import registrations", "Load registrations from a spreadsheet or from contacts.", E),
  app("registrations.export", "Registrations", "Export registrations", "Download the registrations list, with contact details, as a spreadsheet.", ES),
  app("registrations.checkin", "Registrations", "Check in", "Check attendees in and undo a mistaken check-in.", E),
  app("registrations.badges.print", "Registrations", "Print badges", "Preview and print badges.", E),
  app("registrations.bulk", "Registrations", "Bulk changes", "Change tags or the registration type on many registrations at once.", E),
  app("registrations.email", "Registrations", "Email a registrant", "Send an email to one registration from its page.", E),
  app("dtcm.assign", "Registrations", "Assign DTCM codes", "Assign a spare Dubai compliance code to a registration.", E),

  // ── Money ──
  app("payments.record", "Money", "Record payments", "Record an offline payment against a registration.", E),
  app("payments.refund", "Money", "Refund", "Refund a paid registration, in full or in part.", ES),
  app("registrations.cancel", "Money", "Cancel registrations", "Cancel a registration, refunding it first when it was paid.", ES),
  app("creditNotes.issue", "Money", "Issue credit notes", "Issue a credit note against a paid registration.", ES),
  app("invoices.read", "Money", "See invoices", "Open an event's invoices, receipts and quotes.", E),
  app("invoices.write", "Money", "Edit invoices", "Create and change invoices for an event.", E),
  app("invoices.send", "Money", "Send invoices", "Email an invoice or receipt to its payer.", E),
  app("invoices.export", "Money", "Export invoices", "Download an event's invoice list as a spreadsheet.", ES),
  app("invoices.ledger", "Money", "The organisation's invoice book", "Open the invoice list across every event.", S),
  app("billingAccounts.read", "Money", "See billing accounts", "Read the payer book."),
  app("billingAccounts.manage", "Money", "Billing accounts", "Manage the payer book and the organisation's billing details."),
  app("registrations.promo.apply", "Money", "Apply promo codes", "Apply a promo code to a registration, or remove one.", E),

  // ── Speakers ──
  app("speakers.read", "Speakers", "See speakers", "Open the speakers list and a speaker's page.", E),
  app("speakers.create", "Speakers", "Add speakers", "Add a speaker by hand.", E),
  app("speakers.update", "Speakers", "Edit speakers", "Change a speaker's details, photo, tags and sessions.", E),
  app("speakers.delete", "Speakers", "Delete speakers", "Remove a speaker.", ES),
  app("speakers.import", "Speakers", "Import speakers", "Load speakers from a spreadsheet, from contacts or from registrations.", E),
  app("speakers.email", "Speakers", "Email a speaker", "Send an email to one speaker from their page.", E),
  app("speakers.agreements.manage", "Speakers", "Speaker agreements", "Upload the agreement template and send agreements.", E),
  app("speakers.documents.read", "Speakers", "See speaker documents", "Open a speaker's uploaded documents.", E),
  app("speakers.documents.write", "Speakers", "Manage speaker documents", "Upload and remove a speaker's documents.", E),
  // Separate from `.read` on purpose (owner, Oct 2, 2026): the LIST of a
  // speaker's documents is one thing, the FILES (passport copies among them)
  // another. MEMBER holds the list and not the files, as before the sweep.
  app("speakers.documents.open", "Speakers", "Open speaker document files", "Download a speaker's uploaded files, passport copies included.", ES),
  app("speakers.companion.grant", "Speakers", "Faculty registrations", "Give a speaker the companion registration that carries their badge.", E),

  // ── Abstracts ──
  app("abstracts.read", "Abstracts", "See abstracts", "Open the abstracts list, an abstract and its reviews.", E),
  app("abstracts.update", "Abstracts", "Edit abstracts", "Change an abstract's details on the author's behalf.", E),
  app("abstracts.decide", "Abstracts", "Decide abstracts", "Accept, reject or send back an abstract.", E),
  app("abstracts.delete", "Abstracts", "Delete abstracts", "Remove an abstract and its reviews.", ES),
  app("abstracts.import", "Abstracts", "Import abstracts", "Load abstracts from a spreadsheet.", E),
  app("abstracts.email", "Abstracts", "Email authors", "Email an abstract's author from the abstract.", E),
  app("abstracts.reviewers.assign", "Abstracts", "Assign reviewers", "Assign and unassign reviewers on an abstract.", E),
  app("abstracts.themes.manage", "Abstracts", "Abstract themes", "Manage the themes and sub-themes authors choose from.", E),
  app("abstracts.criteria.manage", "Abstracts", "Review criteria", "Manage the scoring criteria reviewers use.", E),
  app("submissions.share", "Abstracts", "Share submissions by link", "Turn on, set up and renew the read-only links that show abstracts or session proposals to people without a sign-in.", E),
  app("reviewers.pool.manage", "Abstracts", "Reviewer pool", "Add and remove the event's reviewers.", E),

  // ── Session proposals ──
  app("proposals.read", "Session proposals", "See session proposals", "Open the session proposals list and a proposal.", E),
  app("proposals.decide", "Session proposals", "Decide session proposals", "Accept, reject or send back a session proposal.", E),
  app("proposals.themes.manage", "Session proposals", "Proposal themes", "Manage the themes proposers choose from.", E),

  // ── Programme ──
  app("sessions.read", "Programme", "See the programme", "Open the agenda, sessions and tracks.", E),
  app("sessions.write", "Programme", "Edit the programme", "Create and change sessions, their speakers and topics.", E),
  app("sessions.delete", "Programme", "Delete sessions", "Remove sessions from the programme.", E),
  app("tracks.write", "Programme", "Manage tracks", "Create, rename and remove tracks.", E),
  app("zoom.meetings.manage", "Programme", "Zoom meetings", "Create and change a session's Zoom meeting and panelists.", E),

  // ── Registration types and promo codes ──
  app("tickets.read", "Registration types and promo codes", "See registration types", "Open the registration types and their pricing tiers.", E),
  app("tickets.write", "Registration types and promo codes", "Edit registration types", "Create and change registration types and pricing tiers.", E),
  app("tickets.delete", "Registration types and promo codes", "Delete registration types", "Remove a registration type or tier.", E),
  app("promo.read", "Registration types and promo codes", "See promo codes", "Open the promo codes and their use.", E),
  app("promo.write", "Registration types and promo codes", "Edit promo codes", "Create and change promo codes.", E),
  app("promo.delete", "Registration types and promo codes", "Delete promo codes", "Remove a promo code.", E),

  // ── Accommodation ──
  app("accommodation.read", "Accommodation", "See accommodation", "Open hotels, room types and bookings.", E),
  app("accommodation.write", "Accommodation", "Manage bookings", "Create and change accommodation bookings.", E),
  app("accommodation.delete", "Accommodation", "Delete bookings", "Remove an accommodation booking.", E),
  app("hotels.manage", "Accommodation", "Hotels and rooms", "Create and change hotels and room types.", E),

  // ── Communications ──
  app("communications.send", "Communications", "Send bulk email", "Send an email to an audience of the event.", E),
  app("communications.schedule", "Communications", "Schedule emails", "Schedule, change and cancel automated emails.", E),
  app("templates.read", "Communications", "See email templates", "Open the event's email templates.", E),
  app("templates.manage", "Communications", "Email templates", "Edit the event's email templates.", E),
  app("emailLogs.read", "Communications", "Email history", "Read what was sent to whom.", E),

  // ── Certificates ──
  app("certificates.read", "Certificates", "See certificates", "Open the certificate templates and issue runs.", E),
  app("certificates.templates.manage", "Certificates", "Certificate templates", "Create and change certificate templates.", E),
  app("certificates.issue", "Certificates", "Issue certificates", "Run an issue and download the PDFs.", E),
  app("certificates.reissue", "Certificates", "Resend and revoke certificates", "Resend a certificate or revoke one.", E),

  // ── Webinar ──
  app("webinar.manage", "Webinar", "Webinar console", "Run the webinar: room, panelists, recording, sequence.", E),
  app("webinar.analytics.read", "Webinar", "Webinar attendance", "See who attended and for how long.", E),
  app("webinar.attendance.export", "Webinar", "Export webinar attendance", "Download the attendance list, with contact details.", ES),
  app("sponsors.read", "Events", "See sponsors", "Open the event's sponsors.", E),
  app("sponsors.manage", "Events", "Sponsors", "Manage the event's sponsors.", E),
  app("media.read", "Events", "See event media", "Open the event's media library.", E),
  app("media.manage", "Events", "Event media", "Upload and remove the event's media files.", E),

  // ── Faculty extras ──
  app("reimbursements.manage", "Faculty extras", "Reimbursements", "Handle speaker reimbursement claims, with passports and bank details.", E),
  app("honorarium.manage", "Faculty extras", "Honoraria", "Set and change a speaker's honorarium.", E),
  app("travelGrants.manage", "Faculty extras", "Travel grants", "Manage travel grant offers and answers.", E),
  app("rsvp.manage", "Faculty extras", "RSVPs", "Set up RSVP campaigns and their guest lists.", E),
  app("rsvp.roster.read", "Faculty extras", "RSVP guest lists", "Read who answered and what they answered.", ES),
  app("surveys.read", "Faculty extras", "See the survey", "Open the survey's setup and answers.", E),
  app("surveys.manage", "Faculty extras", "Surveys", "Set up the survey.", E),
  app("surveys.export", "Faculty extras", "Export survey answers", "Download survey answers as a spreadsheet.", ES),

  // ── Analytics and audit ──
  app("analytics.read", "Analytics and audit", "Event analytics", "Open an event's analytics.", E),
  app("activity.read", "Analytics and audit", "Event activity", "Read an event's audit trail.", E),
  app("activity.org.read", "Analytics and audit", "Organisation activity", "Read the audit trail across the organisation."),

  // ── Contacts ──
  app("contacts.read", "Contacts", "See contacts", "Open the contact store."),
  app("contacts.write", "Contacts", "Edit contacts", "Create and change contacts."),
  app("contacts.delete", "Contacts", "Delete contacts", "Remove contacts from the store.", S),
  app("contacts.import", "Contacts", "Import contacts", "Load contacts from a spreadsheet."),
  app("contacts.export", "Contacts", "Export contacts", "Download the contact store as a spreadsheet.", S),

  // ── CRM ──
  app("crm.read", "CRM", "See the CRM", "Open deals, companies, contacts and tasks."),
  app("crm.write", "CRM", "Work the CRM", "Own deals; create and change deals, companies, contacts, tasks and notes."),
  app("crm.delete", "CRM", "Archive in the CRM", "Archive and restore deals and companies."),
  app("crm.export", "CRM", "Export the CRM", "Download the pipeline as a spreadsheet.", S),
  app("crm.purge", "CRM", "Purge the CRM", "Permanently delete archived records.", S),
  app("crm.inbox.read", "CRM", "CRM inbox", "Read the shared inbox."),
  app("crm.dealValues.view", "CRM", "See deal values", "See the money on deals and reports."),
  app("crm.quoteDefaults.manage", "CRM", "Quote defaults", "Set the default terms on quotes."),

  // ── HR ──
  app("hr.read", "HR", "See HR", "Open attendance, leave and holidays. Also needs HR access on the person, except for a Super Admin or HR User.", { personGrant: "hrAccess" }),
  app("hr.write", "HR", "Manage HR", "Change attendance, leave, rules and holidays. Also needs HR access on the person, except for a Super Admin or HR User.", { personGrant: "hrAccess" }),

  // ── Organisation ──
  app("org.settings", "Organisation", "Organisation settings", "Change the organisation's name, branding and defaults."),
  app("org.credentials", "Organisation", "Integrations", "Hold and test the AI, Stripe, Zoom and EventsAir credentials.", S),
  app("users.invite", "Organisation", "Invite users", "Invite team members, no wider than your own access."),
  app("users.manage", "Organisation", "Manage users", "Change roles, deactivate, sign out everywhere and remove accounts.", S),
  app("roles.manage", "Organisation", "Manage roles", "Create and change custom roles and tag them on people.", S),
  app("apiKeys.manage", "Organisation", "API keys", "Create and revoke the organisation's API keys and OAuth clients.", S),
  app("loginActivity.read", "Organisation", "Sign-in activity", "See sign-ins and who is online."),
  app("agent.use", "Organisation", "AI agent", "Use the event agent. A Member gets its read-only tools."),
  app("mcp.connect", "Organisation", "Connect an AI assistant", "Approve a claude.ai connection to the organisation on your own behalf."),

  // ── Field visibility ──
  app("finance.view", "Field visibility", "See amounts", "See prices, payments, invoices and billing on the pages you can open."),
  app("barcode.view", "Field visibility", "See entry codes", "See entry barcodes and Dubai compliance codes."),
  app("honorarium.view", "Field visibility", "See honoraria", "See what a speaker is paid."),
  app("supportingDocs.view", "Field visibility", "See supporting documents", "Open the documents registrants uploaded to prove eligibility."),
  app("zoomHost.view", "Field visibility", "See Zoom host details", "See start links, passcodes and stream keys."),
];

/** Keys that routes check today: what the editor offers and the service stores. */
export const LIVE_PERMISSION_CATALOGUE: readonly PermissionDescriptor[] = PERMISSION_CATALOGUE.filter((p) => p.live);
export const LIVE_PERMISSION_GROUPS: readonly PermissionGroup[] = PERMISSION_GROUPS.filter((g) =>
  LIVE_PERMISSION_CATALOGUE.some((p) => p.group === g),
);
const LIVE_KEY_SET: ReadonlySet<string> = new Set(LIVE_PERMISSION_CATALOGUE.map((p) => p.key));

/** Is this a key a custom role may carry in this build? Fails closed. */
export function isLivePermissionKey(key: string): key is PermissionKey {
  return LIVE_KEY_SET.has(key);
}

const DESCRIPTOR_BY_KEY: ReadonlyMap<string, PermissionDescriptor> = new Map(PERMISSION_CATALOGUE.map((p) => [p.key, p]));

/** The descriptor for a key, or undefined for a string that is not a key. */
export function describePermission(key: string): PermissionDescriptor | undefined {
  return DESCRIPTOR_BY_KEY.get(key);
}

/**
 * The starter roles seeded once per organisation (D11, narrowed by D14 to these
 * four: no Project Manager role and no Budget Viewer). Editable and archivable
 * afterwards, so this is a starting point rather than a fixed list.
 *
 * PO AUTHOR IS THE PROJECT-MANAGER ROLE (D14). Every project manager is a
 * MEMBER, and a MEMBER authors nothing by role, so this set is what a PM needs:
 * budget authoring plus raising requests and receiving what they ordered.
 *
 * THE TWO SEPARATION RULES ARE BUILT INTO THESE SETS and re-checked on the
 * union when roles are assigned (§4): the approver never holds
 * `requests.create`, and the settle holder never holds `approvals.decide`.
 */
export interface StarterRole {
  name: string;
  description: string;
  permissions: readonly PermissionKey[];
}

export const STARTER_ROLES: readonly StarterRole[] = [
  {
    name: "PO Author",
    description:
      "Runs an event's budget and buys against it: creates and edits the budget, raises purchase requests, receives what arrives. Held by project managers.",
    permissions: [
      "procurement.budgets.view",
      "procurement.budgets.create",
      "procurement.budgets.edit",
      "procurement.budgets.discard",
      "procurement.requests.view",
      "procurement.requests.create",
      "procurement.orders.view",
      "procurement.orders.receive",
      "procurement.suppliers.view",
      "procurement.suppliers.propose",
    ],
  },
  {
    name: "PO Approver",
    description:
      "Decides budgets and spend requests up to the AED limit set on the person. Deliberately cannot raise a request, so a request never reaches its own author.",
    permissions: [
      "procurement.budgets.view",
      "procurement.requests.view",
      "procurement.approvals.decide",
      "procurement.orders.view",
      "procurement.suppliers.view",
    ],
  },
  {
    name: "Requester",
    description:
      "Raises purchase requests and receives what arrives, without reaching the Budgets screen. Sees the line being spent against, and nothing more of the budget.",
    permissions: [
      "procurement.requests.view",
      "procurement.requests.create",
      "procurement.orders.view",
      "procurement.orders.receive",
      "procurement.suppliers.view",
      "procurement.suppliers.propose",
    ],
  },
  {
    name: "Finance Settle",
    description:
      "Checks completeness and settles: signs off closed budgets, manages suppliers and their bank details, sends and cancels orders. Never decides an approval.",
    permissions: [
      "procurement.budgets.view",
      "procurement.budgets.signoff",
      "procurement.requests.view",
      "procurement.requests.manage",
      "procurement.orders.view",
      "procurement.orders.cancel",
      "procurement.orders.confirmReceipt",
      "procurement.orders.send",
      "procurement.suppliers.view",
      "procurement.suppliers.decide",
      "procurement.suppliers.edit",
      "procurement.suppliers.financials.view",
    ],
  },
];
