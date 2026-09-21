# Roles and permissions: who can do what

> **Read this before changing any role guard, and change it in the same commit.**
> Every claim was verified against the code on **2026-09-21** by resolving each
> predicate to its role set, not by reading comments or older documents. The
> boundary table in §4 is pinned by `__tests__/lib/roles-and-permissions-doc.test.ts`:
> it evaluates every predicate for all eleven roles and fails when a row here
> stops matching the code. A permissions table nobody updates is worse than no
> table, because it gets quoted (the rule [DATA_EXPORTS.md](DATA_EXPORTS.md)
> already lives by).

This page is the one place that answers "what can a Member do". The older
summaries in ROADMAP, HANDOVER, ARCHITECTURE and the security posture document
point here. The user guide's chapter 15 is the same content in operator words.

---

## 1. The roles, in one line each

Eleven roles on `User.role`, plus two principals that are not roles.

| Role | Bound to an organisation | Sees which events | In one line |
|---|---|---|---|
| **SUPER_ADMIN** | yes (an org-less Super Admin is the platform operator) | every event in the org (every event, when org-less) | Everything an Admin can do, plus the operator surfaces (Logs, ID lookup, Backups, Help queries, Docs, alert silencing), INTERNAL API-key and OAuth tiers, the Roles and System tabs, HR without a grant, CRM purge. |
| **ADMIN** | yes | every event in the org | Full control of every event and of the organisation: settings, users and invites, integrations, API keys, Activity, sign-in activity, CRM incl. export, budget authoring and the catalogue. |
| **ORGANIZER** | yes | **every event in the org** (org-wide, never "assigned events only") | Full control of every event: registrations, money movement, speakers, programme, communications, certificates, reimbursements, travel grants. Contacts read, write and export. May create Onsite Staff accounts and assign them. Cannot touch org settings, users, API keys, integrations, the Activity page or sign-in activity. |
| **MEMBER** | yes | every event in the org | Internal staff who read everything, **money included**, and run the registration desk (add, edit, check in, badges, record a payment). No other write. Never sees entry or DTCM barcodes, cannot export registrations, cannot open supporting documents. CRM read only, no deal values. AI Agent in read-only mode. |
| **ONSITE** | yes | **only events it is assigned to** (Settings, Onsite Staff) | Temporary desk staff and contractors. On an assigned event: the registrations list, add and edit, check in and undo, badges, record a payment, export the list, entry and DTCM codes, spare DTCM codes. Sees amounts. Nothing else, and unassigned events do not exist for it. |
| **WEBINARS** | yes | WEBINAR-type events for management; every org event for the desk | Organizer-grade control of webinar events, registration desk on every other event (Member parity, no assignment needed). Never: org settings or users, API keys, CRM, contacts, sign-in activity, refunds, credit notes, cancellations, certificates, reimbursements, the AI Agent, event delete or clone, promo codes, the org invoice ledger. |
| **CRM_USER** | yes | none | The sponsorship pipeline only: deals, companies, CRM contacts, tasks, inbox, deal values, archive. Contact-store read. No events, no CSV export, no purge. |
| **HR_USER** | yes | none | The HR module only (attendance, leave, holidays). Nothing else. |
| **REVIEWER** | no | events whose reviewer pool lists them | Read and score the abstracts of those events, from `/my-reviews`. Nothing else. |
| **SUBMITTER** | no | events holding their speaker record | Their own abstracts and session proposals, and My Details. Nothing else. |
| **REGISTRANT** | no | events holding their registration | `/my-registration` only: view and edit their own details, pay, download their quote or invoice. |
| **API key** (role `null`) | the org that issued it | every event in the org | Admin-equivalent on REST and MCP for the org's event data, barcodes and exports included. Refused on the operator surfaces, sign-in activity, supporting documents, HR, Budgets and Procurement, CRM purge and quote defaults, and custom-role management. A SUPER_ADMIN may issue an INTERNAL-tier key that bypasses the hourly MCP limit. |
| **Custom role** (permission set) | the org | n/a | Not a `User.role`. A named set of Budgets and Procurement permissions a Super Admin creates under Settings, Roles and tags onto a person **on top of** their base role; several sets add up. Procurement keys only today (§7.3). |

Internal-domain rule: a person registering with a `meetingmindsdubai.com`
address (after verification) or a `meetingmindsexperts.com` /
`meetingmindsgroup.com` address (at once) gets the org attached even as a
REGISTRANT, so "org-bound" alone is never a sufficient check.

---

## 2. Writes: three tiers

1. **Full write:** SUPER_ADMIN, ADMIN, ORGANIZER (`WRITE_ROLES`). Every other
   role is refused on every non-abstract write unless a route opts it in. The
   list is an allow-list since Sep 16, 2026: a role string the code does not
   know fails closed.
2. **Desk opt-in** (`REGISTRATION_DESK_ALLOW` = ONSITE, MEMBER, WEBINARS):
   add a registration, edit one, check in and undo, print badges, record a
   payment, assign a spare DTCM code (which also needs the barcode boundary in
   §4, so MEMBER is refused there). Every desk route resolves its event through
   the scoping in §3, so ONSITE reaches only its assigned events.
3. **Webinar opt-in** (`WEBINAR_STAFF_ALLOW` = WEBINARS): about 55 route files
   on WEBINAR-type events only: create webinar events (a conference is refused
   with `WEBINAR_ONLY`), event settings and content, registrations including
   bulk and imports, communications, email templates, scheduled emails,
   sessions, tracks, Zoom, speakers, registration types, media, sponsors,
   survey. Every one of them pairs the opt-in with the §3 lookup, so the same
   route fails closed on a conference.

Abstract routes carry their own rules: a REVIEWER scores what it is assigned
or pooled on, a SUBMITTER writes its own DRAFT rows, staff decide.

---

## 3. Event scope (`buildEventAccessWhere`)

| Role | Resolves to |
|---|---|
| SUPER_ADMIN, ADMIN, ORGANIZER, MEMBER | every event in the org |
| SUPER_ADMIN with no org | every event (platform operator) |
| ONSITE | org events whose `settings.onsiteUserIds` contains the user |
| WEBINARS | `eventType = WEBINAR` on the manage surface; every org event on the desk surface (events list and detail, registrations list, create, detail, check-in, badges, payments, activity) |
| CRM_USER, HR_USER | no event at all |
| REVIEWER | events whose `settings.reviewerUserIds` contains the user |
| SUBMITTER | events with a Speaker row linked to the user |
| REGISTRANT | events with a Registration row linked to the user |
| API key | every event in the org |

A route that opts a restricted role in but keeps a hand-rolled org-scoped
lookup fails open. The invariant is documented on `WEBINAR_STAFF_ALLOW` and
pinned by the ONSITE cross-event isolation and WEBINARS regression tests.

---

## 4. Visibility boundaries, exact sets (pinned by test)

There is no single "can this role see it" predicate. Several exist and they
deliberately disagree; reaching for one because it is close enough is the
signal to write a new one (four of these exist because "close enough" leaked
something). The test reads this table by the backticked predicate name and
compares the role column to the code; the API-key column is checked where the
predicate takes an `isApiKey` argument.

| Boundary | Predicate | Roles | API key |
|---|---|---|---|
| Full write (every non-abstract write) | `WRITE_ROLES` | SUPER_ADMIN · ADMIN · ORGANIZER | yes (routes treat a key as admin) |
| Registration-desk opt-in | `REGISTRATION_DESK_ALLOW` | ONSITE · MEMBER · WEBINARS | n/a |
| Webinar full-control opt-in | `WEBINAR_STAFF_ALLOW` | WEBINARS | n/a |
| Generic "may this role write" (UI) | `canWrite` | SUPER_ADMIN · ADMIN · ORGANIZER | n/a |
| Money: amounts, invoices, prices, payments | `canViewFinance` | SUPER_ADMIN · ADMIN · ORGANIZER · MEMBER · ONSITE · WEBINARS | yes (redaction runs only for a session role outside the set) |
| Door credentials: entry barcode, DTCM code | `canViewEntryBarcode` | SUPER_ADMIN · ADMIN · ORGANIZER · ONSITE · WEBINARS | yes |
| Contact store, read | `canViewContacts` | SUPER_ADMIN · ADMIN · ORGANIZER · MEMBER · CRM_USER | yes |
| Contact store, export | `canExportContacts` | SUPER_ADMIN · ADMIN · ORGANIZER · MEMBER | yes |
| Registrations CSV export | `canExportRegistrations` | SUPER_ADMIN · ADMIN · ORGANIZER · ONSITE · WEBINARS | yes |
| Sign-in activity and who is online | `canViewLoginActivity` | SUPER_ADMIN · ADMIN | no |
| Supporting documents (resident letters and the like) | `canViewSupportingDocument` | SUPER_ADMIN · ADMIN · ORGANIZER | no |
| Zoom host credentials (start URL, passcode, stream key) | `canViewZoomHostCredentials` | SUPER_ADMIN · ADMIN · ORGANIZER · WEBINARS | yes |
| Speaker reimbursements (passports, bank details) | `canManageReimbursements` | SUPER_ADMIN · ADMIN · ORGANIZER | no |
| CRM, read the board | `canViewCrm` | SUPER_ADMIN · ADMIN · ORGANIZER · MEMBER · CRM_USER | yes |
| CRM, own deals and write | `canOwnDeals` | SUPER_ADMIN · ADMIN · ORGANIZER · CRM_USER | yes |
| CRM, see deal values | `canViewDealValues` | SUPER_ADMIN · ADMIN · ORGANIZER · CRM_USER | yes |
| CRM, archive and restore | `canDeleteCrm` | SUPER_ADMIN · ADMIN · CRM_USER | yes |
| CRM, CSV export | `canExportCrm` | SUPER_ADMIN · ADMIN | yes |
| CRM, default quote terms | `canManageCrmQuoteDefaults` | SUPER_ADMIN · ADMIN | no |
| CRM, permanent purge | `canPurgeCrm` | SUPER_ADMIN | no |
| Staff (appears in Settings, Users; may hold a signature) | `TEAM_ROLES` | SUPER_ADMIN · ADMIN · ORGANIZER · MEMBER · ONSITE · CRM_USER · WEBINARS · HR_USER | n/a |
| Grantable by an invite or a role change | `ASSIGNABLE_USER_ROLES` | ADMIN · ORGANIZER · MEMBER · ONSITE · CRM_USER · WEBINARS · HR_USER · REVIEWER | n/a |

Two boundaries take a user object rather than a role and are described in §7:
HR (`canViewHr`: SUPER_ADMIN, HR_USER, or any staff account with the per-person
HR access tick; API keys refused) and Budgets and Procurement
(`procurement-visibility.ts`: role sets plus person grants plus custom roles).

The consequences worth remembering: MEMBER sees money but not barcodes, ONSITE
sees both, CRM_USER reads the contact store but never an event, and an API key
is treated as an administrator everywhere except the per-person surfaces.

---

## 5. Actions kept to SUPER_ADMIN, ADMIN and ORGANIZER

Each of these runs the write guard with **no** allow-list, so the desk and
webinar roles are refused even on their own events:

- Refund, credit note, cancel with refund (also behind the money boundary).
- Delete a registration (a desk role may add and edit, never delete).
- Delete or clone an event.
- Certificates: templates, issue runs, resend, revoke.
- Speaker reimbursements and travel grants.
- Reset a submitted survey.
- Reviewer pool and per-abstract reviewer assignment.
- Bulk email and email templates on conference events (WEBINARS holds these on webinar events only).
- Promo codes (a webinar-hidden module anyway).

---

## 6. Organisation administration and operator surfaces

- **Settings tabs.** General and Team open for the org roles that reach Settings; org-setting writes are ADMIN and above. Onsite Staff and Billing: ORGANIZER and above. Integrations and API keys: ADMIN and above (an INTERNAL-tier key: SUPER_ADMIN). Roles: SUPER_ADMIN, while the procurement module is on. System: SUPER_ADMIN.
- **Inviting and changing roles.** ADMIN and above invite any assignable role and change an existing account's role. An ORGANIZER may create ONSITE accounts only (`ONSITE_ONLY`). HR_USER is grantable only when the HR module is on. SUPER_ADMIN is never grantable from the app. Inviting an existing external account (reviewer, submitter, registrant) promotes it in place, keeping its password and registrations.
- **Activity page** (the org audit trail) and **sign-in activity**: SUPER_ADMIN and ADMIN.
- **Operator surfaces** (`denyNonOperator`: SUPER_ADMIN only, and org API keys refused): Logs and the log archive, ID lookup, Backups, Help queries, the Docs viewer, alert silencing, the organisation list. Infra / Ops opens for ADMIN with its own org's scope and for the operator across tenants.
- **AI Agent** (per event): SUPER_ADMIN, ADMIN, ORGANIZER, MEMBER. MEMBER gets read-only tools; finance-only tools and roster-PII tools are refused for it.
- **Help assistant**: every signed-in role; its answers are role-aware.
- **Profile** (name, email signature): staff roles only; external roles edit their details on My Details or their registration.

---

## 7. Modules with their own predicates

### 7.1 CRM (`src/crm/lib/crm-roles.ts`)

See the CRM rows in §4. Two deliberate asymmetries: an ORGANIZER may edit and
archive deals but not export them; CRM_USER may export nothing and purge
nothing. The sidebar hides CRM from ORGANIZER since Sep 15, 2026 by owner
decision; the API still answers.

### 7.2 HR (`src/lib/hr-visibility.ts`)

Behind `HR_MODULE_ENABLED`. Readable and writable by SUPER_ADMIN, HR_USER, and
any staff account whose per-person HR access tick is set (Settings, Users).
ADMIN alone is not enough, because the module holds colleagues' sick-leave
records. API keys are refused. HR audit rows are excluded from the org Activity
feed and shown on their own tab to the same population.

### 7.3 Budgets and Procurement (`src/lib/procurement-visibility.ts`)

Behind `PROCUREMENT_MODULE_ENABLED`. Access is a role set, plus three
per-person grants, plus custom roles; a custom role or a grant admits a person
whatever their base role.

| Capability | Who |
|---|---|
| Read budgets, requests, orders | SUPER_ADMIN · ADMIN · ORGANIZER · MEMBER, or anyone holding a grant or a custom role |
| Author a budget (create, edit, submit, new version) | SUPER_ADMIN · ADMIN · ORGANIZER, or `procurement.budgets.create` / `.edit` |
| Manage the product catalogue | SUPER_ADMIN · ADMIN, or `procurement.catalogue.manage` |
| Raise a spend request | the per-person request grant, or `procurement.requests.create` (the final approver's account is refused as a requester) |
| Approve or reject | the per-person approval ceiling in AED, or unlimited; the ceiling always lives on the person, never on a role |
| Sign off a closed budget | the per-person settle grant, or `procurement.budgets.signoff` |
| Decide a proposed supplier | the settle grant, SUPER_ADMIN, an unlimited approver, or `procurement.suppliers.decide` |
| See a supplier's bank details and tax number | SUPER_ADMIN · ADMIN · ORGANIZER, the settle grant, or `procurement.suppliers.financials.view` |
| Create and edit custom roles, tag them on people | SUPER_ADMIN only |

Custom roles: twenty permission keys, four starter roles seeded on first open
(PO Author, PO Approver, Requester, Finance Settle), several roles on one
person add up, and two combinations are refused at save time and again at the
route: the final approver cannot also raise requests, and signing off a closed
budget cannot sit beside approving. The sidebar shows Budgets to an ORGANIZER
only when they hold a grant or a custom role (owner decision, Sep 15, 2026);
the API answers regardless. Design record: [PROCUREMENT_ROLES_PLAN.md](PROCUREMENT_ROLES_PLAN.md).

---

## 8. What the middleware does with a URL (`src/proxy.ts`)

The API layer is the authoritative gate; the middleware confines the UI so a
typed URL lands somewhere sensible.

| Role | Allowed | Everything else |
|---|---|---|
| REGISTRANT | `/my-registration`, `/api/*` | redirected to `/my-registration` |
| CRM_USER | `/crm*`, `/api/*` | redirected to `/crm` |
| HR_USER | `/hr*`, `/api/*` | redirected to `/hr` |
| ONSITE | `/events` (list), an event's `/registrations*` and `/check-in*`, `/api/*` | dashboard, settings, logs, contacts redirect to `/events`; any other event page redirects to that event's registrations |
| WEBINARS | `/events*` including `/events/new`, `/api/*` | dashboard, settings, logs, contacts, crm, admin, invoices redirect to `/events` |
| REVIEWER, SUBMITTER | an event's `/abstracts*`, `/session-proposals*`, `/my-details`, `/my-reviews`, `/api/*` | dashboard, settings, logs, profile redirect to `/events`; any other event page redirects to that event's abstracts |
| everyone else | no confinement | |

---

## 9. Known gaps and deliberate differences

- Two exports are reachable more widely than the boundaries above intend
  (recorded in [DATA_EXPORTS.md](DATA_EXPORTS.md) §6): the webinar attendance
  CSV answers any org-bound role, and the analytics CSV with the per-attendee
  check-in log answers anyone linked to the event, external roles included.
- Sidebar and API disagree for ORGANIZER on CRM and Budgets, by owner decision
  (§7.1, §7.3): the entries are hidden, the routes answer.
- WEBINARS still resolves about 59 event GETs (agenda, speakers, tickets,
  analytics) on the manage surface, so a conference's agenda answers 404 for
  it; widening them one by one is the read sweep in ROADMAP.
- MEMBER and ONSITE can both record payments and see amounts although one is
  internal and the other a contractor; that is the June 17, 2026 "desk staff
  record payments" decision, and it is why the barcode and supporting-document
  boundaries exclude MEMBER on a different axis.

---

## 10. Where else roles are described

- [AGENTS.md](../AGENTS.md), "Roles and visibility": the invariants, for anyone changing a guard.
- [DATA_EXPORTS.md](DATA_EXPORTS.md): every file that leaves the system, by role.
- [IDENTITY_AND_ROLES.md](IDENTITY_AND_ROLES.md): one person, many hats; what a role change gains and loses.
- [CUSTOM_ROLES_PLAN.md](CUSTOM_ROLES_PLAN.md) §5: the same matrix in permission-catalogue terms, written for the org-wide custom-roles plan.
- [SECURITY_AND_PRIVACY_POSTURE.md](SECURITY_AND_PRIVACY_POSTURE.md) §4: the client-facing summary.
- `public/user-guide.html` chapter 15: the operator-facing summary the help assistant reads.
