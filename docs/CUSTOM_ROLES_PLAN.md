# Customizable Roles: permission-based access for org staff

> **Status: PLANNED, NOT BUILT (Sep 15, 2026).** Do not start without owner
> go-ahead on the decisions in §10. Every phase before Phase 5 is designed to
> change nothing a user can see, because production is live.
>
> **The ask (owner, Sep 15 2026):** *"I want customizable roles. No longer
> WEBINARS and MEMBER, completely customizable based on read, write and delete
> of all operations."*
>
> **The verdict in one paragraph.** Yes, and it is the right end state for the
> platform instance, where tenants will want roles of their own. It is not
> read/write/delete alone: EA-SYS permissions have four dimensions (the action,
> which events it covers, which sensitive fields are visible, and module
> access), and roughly a third of the operations are verbs that are not CRUD
> (check in, refund, export, send, issue, approve). Measured effort is **14 to
> 18 weeks**, most of it a route-by-route sweep of the kind the tenancy work
> already proved out. Phase 0 is worth doing even if the rest never is: it
> fixes the two places where a new role today gets MORE access than intended.

---

## 1. Scope

**In:** the eight org staff roles, which become system roles built from
permissions, plus custom roles an admin composes from the same permissions.

| Today | Accounts on prod (Sep 15, read-only) | After |
|---|---|---|
| SUPER_ADMIN | 1 | Fixed system role, not editable, never assignable from Settings |
| ADMIN | 3 | System role |
| ORGANIZER | 3 (+1 `mcp-remote` system user) | System role |
| MEMBER | 2 | System role |
| ONSITE | 1 | System role |
| WEBINARS | 1 | System role |
| CRM_USER | 2 | System role |
| HR_USER | 0 | System role |
| **Custom** | n/a | Any composition of the catalogue in §4 |

**Out, deliberately:**

- **REVIEWER, SUBMITTER, REGISTRANT (266 of 281 accounts).** They are not org
  staff. Their access comes from being linked to specific rows (a reviewer
  pool, a speaker record, a registration), not from a role, and the Aug 6
  identity ruling keeps them org-null on master. They keep their enum values and
  their `buildEventAccessWhere` branches unchanged.
- **Platform operator.** `denyNonOperator` / `canActAsPlatformOperator` stay a
  fixed, code-defined boundary. A tenant must never be able to compose a role
  that crosses tenants.
- **Per-record ACLs** ("this user may edit these 12 registrations"). Scope is
  per event, never per row.
- **Several roles per user.** One role per user. §7.3 explains why a union is
  the trap, and a custom role already covers "MEMBER plus webinar control".

---

## 2. What exists today (measured Sep 15, 2026)

### 2.1 The route surface

**386 route files, 583 handlers** (GET 221, POST 211, PUT 38, PATCH 44,
DELETE 69). Guard patterns in use:

| Pattern | Handlers | Notes |
|---|---|---|
| `denyReviewer` with no allow-list | 145 | Admits SUPER_ADMIN, ADMIN, ORGANIZER by exclusion |
| `denyReviewer` + `WEBINAR_STAFF_ALLOW` | 75 | Must pair with a manage-surface `buildEventAccessWhere` |
| `denyReviewer` + `REGISTRATION_DESK_ALLOW` | 13 | ONSITE, MEMBER, WEBINARS |
| `denyReviewer` + a one-off allow | 3 | `["MEMBER"]`, `["SUBMITTER"]` |
| `denyFinance` | 23 | Overlaps with the above |
| Module guards (CRM, HR, procurement, operator) | 155 | Already predicate-based |
| Inline `role ===` comparisons | ~57 | Settings credentials, org users, activity, agent, abstracts, WEBINARS narrowings |
| No role guard (public, token, registrant, cron, MCP bearer) | ~110 | Out of scope; unchanged |

### 2.2 The predicates

Fourteen files hold role sets (`src/lib/*-visibility.ts`, `can-write.ts`,
`platform-operator.ts`, `team-roles.ts`, and the CRM, HR and procurement role
files). The findings that shape this plan:

1. **One deny-list among allow-lists.** `RESTRICTED_WRITE_ROLES`
   (`src/lib/auth-guards.ts:24`) names the roles that may NOT write. A role
   absent from it passes all 145 `denyReviewer`-only handlers. Every other
   predicate is an allow-list and fails closed for a new role.
2. **An org-wide default.** `buildEventAccessWhere`
   (`src/lib/event-access.ts:184`) sends any unrecognised role, and API keys
   (`role: ""`), to the org-wide `where`. Combined with (1), a new role added
   carelessly today can write to every event in the org.
3. **The same set, many names.** {SA, ADMIN, ORGANIZER} is `canWrite`,
   `SUPPORTING_DOCUMENT_ROLES`, `BUDGET_AUTHOR_ROLES`,
   `SUPPLIER_FINANCIALS_ROLES` and `TRAVEL_GRANT_MANAGE_ROLES`.
   {SA, A, O, ONSITE, WEBINARS} is both `BARCODE_ROLES` and `EXPORT_ROLES`.
   {SA, A} is login activity, CRM export and procurement admin. These are
   permissions that were never named.
4. **API keys have no rule.** Some predicates take an `isApiKey` flag and allow
   (barcode, contacts, export, zoom, CRM), some refuse (login, supporting
   documents, HR, operator, procurement, CRM purge), `canViewFinance` has no
   flag so `denyFinance` refuses, and `denyReviewer` admits.
5. **Role lists outside the predicate files**, in at least 20 places: five
   public Zoom routes (`ORG_STAFF_ROLES`), activity, the agent route, CRM notes
   and reps, three components, the help chat, the header, `abstract-service`,
   notifications, accept-invitation, and the MCP consent screen twice.
6. **Grants already sit beside roles.** `hrAccess` and the four procurement
   columns ride the JWT and are re-read on revalidation. They are permissions
   stored as columns.

### 2.3 Outside the routes

- **Middleware** (`src/proxy.ts:146-313`): a third encoding of which roles are
  confined to which paths.
- **Sidebar**: six nav flags plus role equality checks plus
  `WEBINAR_HIDDEN_MODULES` (keyed on event type) and
  `WEBINARS_ROLE_HIDDEN_MODULES` (keyed on role).
- **61 client files** branch on the role or a role predicate.
- **MCP**: about 101 tools. Gating happens only at registration (CRM needs
  `canViewCrm`, procurement needs `canViewProcurement`); the ~87 core tools
  have no role check at all, and API keys are admin-equivalent.
- **In-app agent**: role allow-list plus a read-only gate for MEMBER plus
  finance and roster refusals.
- **Per-event assignment**: two JSON id arrays in `Event.settings`
  (`onsiteUserIds`, `reviewerUserIds`). No grant table.
- **Tests**: about 30 files pin role behaviour (rbac 68 tests, crm-visibility
  40, reviewer-access 33, contacts-read 25, auth-guards 22, webinars-isolation
  19, onsite-isolation 15, and more).

### 2.4 Gaps found on the way (Phase 0 fixes them)

| # | Gap | Where |
|---|---|---|
| G1 | New role writes everywhere by default | `RESTRICTED_WRITE_ROLES` deny-list |
| G2 | New role or API key gets org-wide events | `buildEventAccessWhere` default branch |
| G3 | GETs with no role check, org-scoped only, readable by CRM_USER, HR_USER, unassigned ONSITE, WEBINARS on conferences | hotels/[hotelId], hotels/[hotelId]/rooms, review-criteria, speaker-agreement-template |
| G4 | Webinar attendance CSV export (attendee PII) has no export predicate | `webinar/attendance?export=csv` |
| G5 | About 57 `denyReviewer`-only handlers resolve the event by hand (`event: { organizationId }`). Safe while only ADMIN and ORGANIZER pass; org-wide the moment a scoped permission replaces the role gate | all of certificates, all of accommodation, abstract and proposal themes, review criteria, imports, promo detail |
| G6 | MCP OAuth token keeps working after the grantee is deactivated or signed out everywhere (only role and org re-read) | `src/app/api/mcp/route.ts:72-75` |
| G7 | Three home-made gates duplicating the shared ones | `requireAdmin` (ai, stripe credentials), `requireSuperAdmin` (logs/archive), `denyNonStaff` (profile) |
| G8 | Session-only POSTs any signed-in account can call | `upload/photo`, `help-chat` |

---

## 3. The model

A **permission** is a key naming one operation on one resource. A **role** is a
named set of permissions, each carrying a **scope** where the permission is
event-bound. A user holds exactly one role.

```
permission  = "registrations.checkin"
scope       = ALL | ASSIGNED | WEBINAR      (event-bound permissions only)
role        = { name, organizationId, isSystem, grants: [(permission, scope)] }
check       = can(principal, "registrations.checkin", { eventId })
```

### 3.1 Four dimensions, one catalogue

1. **Action on a resource.** CRUD plus the non-CRUD verbs, each its own key.
   Refund is not "write". Export is not "read".
2. **Scope** (event-bound permissions only):
   - `ALL`: every event in the org (today's ADMIN, ORGANIZER, MEMBER).
   - `ASSIGNED`: events the user is assigned to (today's ONSITE).
   - `WEBINAR`: events of type WEBINAR (today's WEBINARS manage surface).

   Scope is per grant, not per role, which is exactly what WEBINARS needs:
   `registrations.checkin` at `ALL` beside `sessions.write` at `WEBINAR`.
3. **Sensitive-field visibility.** `finance.view`, `barcode.view`,
   `honorarium.view`, `supportingDocs.view`, `zoomHost.view`,
   `contacts.pii.view`. These replace the redaction role sets; the redactors
   stay, only their predicate changes.
4. **Module access.** CRM, HR and procurement permissions. The module flags
   (`HR_MODULE_ENABLED`, `PROCUREMENT_MODULE_ENABLED`) still gate on top: a
   permission for a disabled module grants nothing.

### 3.2 Data model (additive)

```prisma
model Role {
  id             String   @id @default(cuid())
  organizationId String
  key            String            // "admin", "onsite", "custom-a1b2"
  name           String
  description    String?
  isSystem       Boolean  @default(false)   // seeded, clone-only (decision D1)
  version        Int      @default(1)       // bumped on every edit
  grants         RoleGrant[]
  users          User[]
  createdAt      DateTime @default(now())
  updatedAt      DateTime @updatedAt
  @@unique([organizationId, key])
}

model RoleGrant {
  id         String      @id @default(cuid())
  roleId     String
  permission String                 // validated against the code catalogue
  scope      GrantScope?            // null for non-event permissions
  role       Role @relation(fields: [roleId], references: [id], onDelete: Cascade)
  @@unique([roleId, permission])
}

enum GrantScope { ALL ASSIGNED WEBINAR }

model EventStaffAssignment {          // replaces settings.onsiteUserIds (Phase 4)
  id             String @id @default(cuid())
  organizationId String
  eventId        String
  userId         String
  assignedById   String?
  createdAt      DateTime @default(now())
  @@unique([eventId, userId])
}

// User gains:  roleId String?   (null for REVIEWER / SUBMITTER / REGISTRANT)
// User.role (enum) stays: it still carries the external roles, and during the
// migration it is the fallback for any staff user not yet given a roleId.
```

- **The catalogue lives in code**, not the database (`src/lib/permissions/catalogue.ts`),
  as a typed `const` with a label, a description, a domain, whether it is
  event-bound, and a risk tier. `RoleGrant.permission` is validated against it
  on write, so a typo cannot be saved and a permission removed from code is
  reported rather than silently ignored.
- **Born tenancy-compliant.** `Role`, `RoleGrant` and `EventStaffAssignment`
  carry `organizationId`, a policy in `prisma/rls/`, harness assertions and
  `check-tenant-als.sh` entries, in the same change.
- **Approval ceilings stay user attributes.** `procurementApproveCeilingAed`
  is a number per person, not a permission. The role grants
  `procurement.approve`; the ceiling limits it (decision D6).

### 3.3 Where the permissions live at request time

The JWT does **not** carry the permission list: 100 strings in an encrypted
cookie pushes toward the 4 KB limit and goes stale the moment a role is edited.

- **Token carries:** `roleId`, `roleVersion`, and a short `modules` array
  (for example `["events","crm"]`) that the Edge middleware and the sidebar
  need without a database.
- **Server resolves:** `can()` reads the role's grants from a per-process cache
  keyed on `roleId:version`. Staff sessions are already re-validated on every
  request (`auth.ts:359`); that read gains `role.version`, so an edited role
  bites on the next request and the cache entry is replaced.
- **Performance:** one extra joined column on a query that already runs, and a
  map lookup per check. No new query per request.

---

## 4. The permission catalogue (draft, ~105 keys)

Event-bound keys take a scope. Keys marked **R** are risk tier "sensitive": the
role editor warns when granting them (§8.4).

| Domain | Permissions |
|---|---|
| Events | `events.read` · `events.create` · `events.update` · `events.delete` R · `events.clone` · `events.settings` · `events.staff.assign` |
| Registrations | `registrations.read` · `.create` · `.update` · `.delete` R · `.import` · `.export` R · `.checkin` (incl. undo) · `.badges.print` · `.bulk` (tags, type) · `.email` · `.promo.apply` |
| Money | `payments.record` · `payments.refund` R · `registrations.cancel` R · `creditNotes.issue` R · `invoices.read` · `invoices.write` · `invoices.send` · `invoices.export` R · `invoices.ledger` (org-wide) R · `billingAccounts.manage` |
| Speakers | `speakers.read` · `.create` · `.update` · `.delete` R · `.import` · `.email` · `speakers.agreements.manage` · `speakers.documents.read` · `speakers.documents.write` · `speakers.companion.grant` |
| Abstracts | `abstracts.read` · `.update` · `.decide` · `.delete` R · `.import` · `.email` · `abstracts.reviewers.assign` · `abstracts.themes.manage` · `abstracts.criteria.manage` · `reviewers.pool.manage` |
| Proposals | `proposals.read` · `proposals.decide` · `proposals.themes.manage` |
| Program | `sessions.read` · `sessions.write` · `sessions.delete` · `tracks.write` · `zoom.meetings.manage` |
| Tickets | `tickets.read` · `tickets.write` · `tickets.delete` · `promo.read` · `promo.write` · `promo.delete` |
| Accommodation | `accommodation.read` · `accommodation.write` · `accommodation.delete` · `hotels.manage` |
| Communications | `communications.send` · `communications.schedule` · `templates.manage` · `emailLogs.read` |
| Certificates | `certificates.templates.manage` · `certificates.issue` · `certificates.reissue` |
| Webinar | `webinar.manage` (room, provision, sequence, recording) · `webinar.analytics.read` · `webinar.attendance.export` R · `sponsors.manage` · `media.manage` |
| Faculty extras | `reimbursements.manage` · `honorarium.manage` · `travelGrants.manage` · `rsvp.manage` · `rsvp.roster.read` R · `surveys.manage` · `surveys.export` R |
| Analytics | `analytics.read` · `activity.read` |
| Contacts | `contacts.read` · `contacts.write` · `contacts.delete` R · `contacts.import` · `contacts.export` R |
| CRM | `crm.read` · `crm.write` · `crm.delete` · `crm.export` R · `crm.purge` R · `crm.inbox.read` · `crm.dealValues.view` |
| HR | `hr.read` · `hr.write` |
| Procurement | `procurement.read` · `budgets.author` · `procurement.admin` · `procurement.request` · `procurement.settle` · `procurement.approve` · `suppliers.financials.view` |
| Organization | `org.settings` · `org.credentials` R · `users.invite` · `users.manage` R · `roles.manage` R · `apiKeys.manage` R · `loginActivity.read` · `agent.use` |
| Field visibility | `finance.view` · `barcode.view` · `honorarium.view` · `supportingDocs.view` · `zoomHost.view` · `contacts.pii.view` |

**Not in the catalogue:** `platform.operator` (code-defined, §1), and anything
reached by the public, token, registrant and cron routes.

**The agent and MCP need no keys of their own.** Each tool maps to the
permission of the operation it performs (`list_registrations` →
`registrations.read`), so "read-only agent for MEMBER" stops being a special
case: MEMBER's role simply holds no write permissions.

---

## 5. System roles, expressed as permissions

The eight staff roles are seeded as system roles whose grants reproduce **what
the code does today, not what the docs say**. Two examples where they differ:
CLAUDE.md calls ORGANIZER "assigned events only", but the code gives it the
org-wide default branch; MEMBER is described as read-only, but it holds the
registration desk (create, check in, badges, record payment).

| System role | In permission terms |
|---|---|
| Super Admin | Everything in the catalogue at `ALL`; plus the fixed operator boundary where `PLATFORM_ORG_ID` applies |
| Admin | Everything at `ALL` except `crm.purge` |
| Organizer | Everything at `ALL` except: `crm.delete`, `crm.export`, `crm.purge`, `procurement.admin`, `loginActivity.read`, `org.credentials`, `apiKeys.manage`, `roles.manage`; `users.invite` limited to the Onsite role (decision D9) |
| Member | All `*.read` at `ALL`; desk at `ALL` (`registrations.create`, `.checkin`, `.badges.print`, `payments.record`); `finance.view`; `contacts.read`, `contacts.export`; `crm.read`; `procurement.read`; `agent.use`. No `barcode.view`, no `zoomHost.view`, no `registrations.export` |
| Onsite | Desk at `ASSIGNED`: `registrations.read`, `.create`, `.checkin`, `.badges.print`, `.export`, `payments.record`; `finance.view`, `barcode.view` |
| Webinars | The Member-parity desk at `ALL`; full event control at `WEBINAR` (`events.create`, `events.update`, sessions, speakers, communications, templates, webinar, sponsors, media, surveys, tickets, registrations incl. import); `finance.view`, `barcode.view`, `zoomHost.view`, `registrations.export`. No `registrations.delete` (the L-4 ruling), no refunds, no certificates, no contacts, no `invoices.ledger`, no `agent.use` |
| CRM User | `crm.read`, `crm.write`, `crm.delete`, `crm.inbox.read`, `crm.dealValues.view`, `contacts.read`. No events |
| HR User | `hr.read`, `hr.write`. No events |

The exact matrix is written as code in Phase 1 and pinned by the parity test
(§6, Phase 1), which is the only authority. This table is the summary.

---

## 6. Build order

Each phase ships on its own, passes the full gate, and is behaviour-identical
for every existing user until Phase 5 turns on the editor behind
`CUSTOM_ROLES_ENABLED`.

### Phase 0: Harden what exists (1 to 2 weeks, worth doing regardless)

Closes G1 to G8 without introducing permissions.

1. Invert `RESTRICTED_WRITE_ROLES` to an allow-list (`WRITE_ROLES`). Same
   results for all eleven roles, pinned by test; a new role now fails closed.
2. `buildEventAccessWhere`: the default branch serves ADMIN, ORGANIZER,
   SUPER_ADMIN-with-org and API keys **by name**; any other role gets
   `{ id: { in: [] } }` and a warn log.
3. Gate G3's GETs and G4's export.
4. Replace G5's hand-rolled event lookups with `buildEventAccessWhere`. No
   visible change today (only ADMIN and ORGANIZER reach them), and it removes
   the trap before any scope exists.
5. G6: the MCP OAuth path reads `deactivatedAt` and `tokenVersion` through
   `decideSessionValidity`, the same function web and mobile use.
6. G7: delete the three home-made gates in favour of the shared ones.
7. G8: an owner call (should any signed-in account upload a photo and use the
   help chat? Registrants and submitters do use both today).
8. Collapse the identical role sets in §2.2(3) into named predicates, and move
   the 20+ inline role lists onto them. This is the dress rehearsal for
   Phase 2 at a fraction of the size.

### Phase 1: Catalogue, schema, `can()`, parity (2 weeks)

- Additive migration: `Role`, `RoleGrant`, `GrantScope`, `User.roleId`.
- `src/lib/permissions/catalogue.ts`, `system-roles.ts` (the §5 matrix as data),
  `can.ts` (`can`, `requirePermission`, `eventWhereFor`).
- Seed script, idempotent, run per org: creates the eight system roles and sets
  `roleId` on every staff user from their enum. Prod: 15 accounts.
- **The parity test, the load-bearing artefact of the whole plan.** For every
  system role × every existing predicate (`canViewFinance`,
  `canViewEntryBarcode`, `denyReviewer` with each allow-list, `canViewCrm`, and
  the other 30-odd), assert `oldPredicate(role) === can(systemRole, mappedPermission)`,
  and for `buildEventAccessWhere` assert the generated `where` is identical per
  role and surface. It is generated from both sources, so the day the two
  disagree it fails with the role and the permission named.
- Nothing calls `can()` yet in production code.

### Phase 2: The route sweep (5 to 7 weeks)

Domain by domain, the tenancy-sweep recipe:

1. Replace `denyReviewer(...)`, allow-lists, `denyFinance` and inline role
   comparisons with `requirePermission(session, "<key>", { route, eventId })`.
2. Replace the event lookup with `eventWhereFor(principal, "<key>")`, which
   derives the `where` from the grant's scope and returns
   `{ id: { in: [] } }` when there is no grant. **The permission and the scope
   come from the same grant**, so the §7.3 trap cannot be written.
3. Add the domain to `scripts/check-permission-guards.sh` (new, gating): in a
   swept directory, any `denyReviewer(`, `role ===`, `role !==` or
   `*_ALLOW` fails CI naming the file. The list only grows.
4. Behaviour stays identical: the principal is still a system role.

Order, lowest risk first: events core · tickets and promo · sessions and
program · speakers · abstracts and proposals · accommodation · communications ·
certificates · webinar · faculty extras · contacts · registrations desk ·
money (payments, refunds, invoices) · org settings and users · CRM · HR ·
procurement. The desk and money domains go late so the recipe is settled
before it reaches the paths a live event depends on.

### Phase 3: Middleware, sidebar, UI, MCP, agent (2 weeks)

- `src/proxy.ts`: path confinement from the token's `modules`, replacing the
  per-role branches. The route layer stays authoritative.
- Sidebar: one filter, `can(module)`, replacing the six flags and two hidden
  module lists.
- `useCan(permission, eventId?)` hook; sweep the 61 client files.
- MCP: register each tool only when its permission is held, **and** check at
  call time (today's registration-only gating is fine for a fixed role, not for
  a role that can be edited while a client is connected).
- Agent: drop the role allow-list and read-only gate; tools check their own
  permission.
- **MCP clients reconnect**; bump `package.json` + lockfile.

### Phase 4: Event staff assignment (1 week)

- `EventStaffAssignment` table replaces `settings.onsiteUserIds`. Backfill from
  the JSON, dual-read for one release, then drop the reader.
- Settings → Onsite Staff becomes Settings → Event Staff: assign any user whose
  role holds `ASSIGNED` grants.
- `reviewerUserIds` is untouched: reviewers are external (§1).

### Phase 5: The role editor (1 to 2 weeks)

Behind `CUSTOM_ROLES_ENABLED`.

- Settings → Roles: list system and custom roles with user counts; clone a role;
  a matrix editor grouped by domain with a scope selector per event-bound row.
- Settings → Users: the role picker lists system and custom roles.
- **Guardrails (§8.4)**, audit rows (`ROLE_CREATED`, `ROLE_GRANT_CHANGED`,
  `ROLE_ASSIGNED`) with before and after, and **"View as role"**: renders the
  sidebar and a sample of pages with the draft role's `can()` so an admin sees
  the effect before saving.

### Phase 6: Retire the old model (1 to 2 weeks)

- Delete the staff branches from `buildEventAccessWhere`, the role sets from
  the visibility files, `canWrite`, `REGISTRATION_DESK_ALLOW`,
  `WEBINAR_STAFF_ALLOW` and `RESTRICTED_WRITE_ROLES`.
- Fold `hrAccess` and the procurement booleans into grants (the approval
  ceiling stays, D6); the migration keeps the columns until the next release.
- Rewrite the ~30 role test files as parity plus scenario tests.
- Independent adversarial review of the whole boundary before the flag turns on
  anywhere real tenants live.

### Effort

| Phase | Weeks |
|---|---|
| 0 Harden | 1 to 2 |
| 1 Catalogue, schema, parity | 2 |
| 2 Route sweep | 5 to 7 |
| 3 UI, middleware, MCP | 2 |
| 4 Event staff assignment | 1 |
| 5 Role editor | 1 to 2 |
| 6 Retire, review | 1 to 2 |
| **Total** | **13 to 18** |

---

## 7. The traps

### 7.1 Deny-lists fail open

`RESTRICTED_WRITE_ROLES` is why a role added to the enum and forgotten can write
to every non-HR route (the HR_USER sweep in August was expensive for exactly
this reason). A permission model is allow-by-grant by construction, but only
after every handler checks a permission. Until then a custom role is judged by
whichever old predicate the route still uses. **Custom roles stay off until
Phase 2's gate covers every directory.**

### 7.2 Hand-rolled event lookups become org-wide

The 57 handlers in G5 are safe because only ADMIN and ORGANIZER reach them.
Replace their role gate with `requirePermission(..., "certificates.issue")`
while keeping `event: { organizationId }`, and a custom role holding that
permission at `ASSIGNED` issues certificates on every event. `eventWhereFor`
exists so the scope cannot be separated from the permission.

### 7.3 Unions pair the wrong halves

Today's code asks two separate questions: *may this role do X* (a predicate)
and *which events* (`buildEventAccessWhere`). A user with two roles answered
role-by-role then OR'd would take MEMBER's scope (all events) and WEBINARS'
capability (full control) and produce full control on conferences, which
neither role grants. The same thing happens inside one role if permission and
scope are stored apart. **Scope belongs to the grant**, and a user holds one
role.

### 7.4 Privilege escalation through the editor

An admin who holds `roles.manage` but not `payments.refund` must not be able to
create a role with `payments.refund` and assign it to themselves. Rules:

- You can grant only permissions you hold, at a scope no wider than your own.
- You cannot change your own role, or edit the role you hold.
- `roles.manage`, `users.manage` and `org.credentials` are grantable only by a
  holder of all three.
- Every edit bumps `Role.version`, so the change bites on the next request.

### 7.5 Stale sessions and connected MCP clients

A role edit must take effect within one request for web sessions (the version
check in §3.3) and at call time for MCP (Phase 3). A mobile access token keeps
its claim for up to 24 hours today; the mobile path gains the same version read.

### 7.6 Docs describe intent, code describes behaviour

Several comments and CLAUDE.md lines disagree with the code (ORGANIZER scope,
`zoom-visibility` "matches canWrite", the CRM matrix missing three roles). The
system-role matrix is taken from the predicates and the parity test, never from
prose. Where a system role's real behaviour looks wrong, it is recorded and
decided separately, not "fixed" inside the migration.

---

## 8. Design details

### 8.1 API keys

A key becomes a principal holding a role. Existing keys get a seeded system
role **"API key (full)"** equal to today's behaviour, *including* its current
inconsistencies (allowed on barcode and contacts, refused on finance and
supporting documents), so no integration breaks. Phase 5 lets an admin pick a
narrower role per key, which is what a leaked n8n key should have had (decision
D4).

### 8.2 Delete

`*.delete` is its own permission, never implied by `*.write`. Deletes that move
money or seats (registration delete, cancel) sit in tier R and follow the Aug 4
L-4 rule in the system roles: no refund powers, no row deletion.

### 8.3 Read-only is a composition, not a flag

A role with only `*.read` keys is read-only everywhere, including the agent and
MCP. `canWrite` disappears.

### 8.4 Editor warnings

The editor flags, before save:

- any tier R permission;
- `finance.view` or `barcode.view` together with any `*.export` at `ALL`
  (bulk exfiltration of money or door credentials);
- `payments.refund` without `creditNotes.issue` (the refund route requires a
  credit note, so the role could never complete one);
- a desk permission without `registrations.read` at the same scope;
- `ASSIGNED` scope on a role nobody is assigned events for.

---

## 9. Testing

- **Parity (Phase 1):** every system role × every predicate × every surface,
  generated. This is what makes Phases 1 to 4 provably behaviour-identical.
- **Catalogue integrity:** every key used in code exists in the catalogue;
  every catalogue key is used by at least one route or tool; every seeded grant
  names a real key.
- **Scope isolation:** the ONSITE and WEBINARS isolation suites re-run against
  custom roles with `ASSIGNED` and `WEBINAR` grants, including mutation checks
  that widening a scope fails them.
- **Escalation:** each §7.4 rule as a route test.
- **RLS harness:** `Role`, `RoleGrant`, `EventStaffAssignment` isolated across
  two tenants with the same role key.
- **CI gate:** `check-permission-guards.sh`, mutation-verified both ways.

---

## 10. Decisions for the owner

| # | Question | Recommendation |
|---|---|---|
| D1 | Are system roles editable, or clone-only? | Clone-only. An edited "Admin" stops meaning Admin, and support conversations depend on the name |
| D2 | Scopes: `ALL`, `ASSIGNED`, `WEBINAR`. Enough, or should scope generalize to any event type? | The three. Generalize only when a tenant asks |
| D3 | One role per user, or several? | One (§7.3) |
| D4 | API keys hold a role? | Yes, defaulting to "API key (full)" |
| D5 | Who manages roles: SUPER_ADMIN only, or ADMIN too? | ADMIN too, under the §7.4 no-escalation rules |
| D6 | Procurement approval ceiling: a user attribute or a permission parameter? | User attribute |
| D7 | Fold `hrAccess` and the procurement grants into roles? | Yes, in Phase 6 |
| D8 | Enable the editor on master (MM Group), the platform, or both? | Build once; enable on master first, since MM Group has 15 staff and can live-test it |
| D9 | ORGANIZER may invite ONSITE only. Generalize as "may assign roles no wider than your own"? | Yes, that is §7.4's rule |
| D10 | G8: may any signed-in account upload a photo and use the help chat? | Keep, but name it: `profile.photo` and `help.use` granted to all |
| D11 | Start with Phase 0 alone and decide on the rest after? | Yes. It closes real gaps and costs nothing if the rest waits |

---

## 11. Out of scope

- External roles (§1), cross-tenant membership (PLATFORM_DECISIONS §6).
- Per-row permissions, time-limited grants, approval workflows for role edits.
- Field-level visibility beyond the six named sensitive-field permissions.
- Renaming the external enum values.
