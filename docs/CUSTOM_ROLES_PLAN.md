# Customizable Roles: permission-based access for org staff

> **Status: PHASE 0 COMPLETE, PHASE 1 IN BUILD. Revision 4 (Sep 30, 2026).** Owner rulings this
> revision: roles are **several and additive**, unioned over whole
> (permission, scope) pairs, which reverses revision 2's D3 (§7.3 explains why
> that section argued for scope-on-the-grant, not for one role); and the build
> starts with **Phase 0 alone**. Revision 2 (Sep 15, 2026) followed an
> independent review verified against the code (§12).** Do not start without owner go-ahead
> on the decisions in §10. Every phase before Phase 5 is designed to change
> nothing a user can see, because production is live, and §6 says how each one
> proves that.
>
> **The ask (owner, Sep 15 2026):** *"I want customizable roles. No longer
> WEBINARS and MEMBER, completely customizable based on read, write and delete
> of all operations."*
>
> **The verdict.** Yes, and it is the right end state for the platform
> instance, where tenants will want roles of their own. It is not
> read/write/delete alone: EA-SYS permissions have four dimensions (the action,
> which events it covers, which sensitive fields are visible, and module
> access), roughly a third of the operations are verbs that are not CRUD (check
> in, refund, export, send, issue, approve), and a handful are bound to a
> PERSON rather than a role on purpose (HR access, procurement request, settle
> and approve). Estimated effort is **15 to 21 weeks**, most of it a
> route-by-route sweep of the kind the tenancy work proved out. **Phase 0 is
> worth doing even if the rest never is**: it closes nine gaps that exist today
> (§2.4), two of which give a newly added role more access than intended.

---

> **Revision 4 (Sep 30, 2026).** Phase 0 is complete (G1 to G9 and step 9,
> `no-inline-role-lists.test.ts`). The owner ruled D1, D2, D4, D5, D7, D8, D9,
> D10 as recommended and D15 as "No base access" (§10), and one design
> correction was made before Phase 1 code: **the tables §3.3 proposed already
> exist**, shipped on Sep 16 as `PermissionSet`, `PermissionSetGrant` and
> `UserPermissionSet` by the procurement roles plan, so Phase 1 extends them
> instead of building a second role system (§3.3). Phase 1 slice 1 is built:
> the whole-application catalogue, the system roles as data, `can()` and
> `eventWhereFor()`, and safety net 1 (§6 Phase 1). Nothing in production
> calls them yet.

## 1. Scope

**In:** the eight org staff roles, which become system roles, plus custom
roles an admin composes from the same permission catalogue.

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
| **Custom** (new `UserRole.CUSTOM`) | n/a | Any composition of the catalogue in §4 |

**Out, deliberately:**

- **REVIEWER, SUBMITTER, REGISTRANT (266 of 281 accounts).** They are not org
  staff. Their access comes from being linked to specific rows (a reviewer
  pool, a speaker record, a registration), not from a role, and the Aug 6
  identity ruling keeps them org-null on master. They keep their enum values,
  their `buildEventAccessWhere` branches and their session-only surfaces.
- **Platform operator** (`denyNonOperator`, `canActAsPlatformOperator`) and the
  SUPER_ADMIN-only platform switches (the INTERNAL rate-limit tier on API keys
  and OAuth clients). A tenant must never compose a role that crosses tenants or
  lifts its own ceiling.
- **Per-person grants** (§3.4): `hrAccess`, procurement request, settle and the
  approval ceiling stay on the person, beside the role.
- **Per-record ACLs** ("may edit these 12 registrations"). Scope is per event.

---

## 2. What exists today (measured Sep 15, 2026)

### 2.1 The route surface

**386 route files, 583 handlers** (GET 221, POST 211, PUT 38, PATCH 44,
DELETE 69).

| Guard pattern | Handlers | Notes |
|---|---|---|
| `denyReviewer` with no allow-list | 145 | Admits SUPER_ADMIN, ADMIN, ORGANIZER by exclusion |
| `denyReviewer` + `WEBINAR_STAFF_ALLOW` | 75 | Must pair with a manage-surface `buildEventAccessWhere` |
| `denyReviewer` + `REGISTRATION_DESK_ALLOW` | 13 | ONSITE, MEMBER, WEBINARS |
| `denyReviewer` + a one-off allow | 3 | `["MEMBER"]`, `["SUBMITTER"]` |
| `denyFinance` | 23 | Overlaps; every call site is session-only (API keys never reach it) |
| Module guards (CRM, HR, procurement, operator) | 155 | Already predicate-based |
| Inline `role ===` comparisons | ~57 | Settings credentials, org users, activity, agent, abstract delete, WEBINARS narrowings |
| No role guard (public, token, registrant, cron, MCP bearer) | ~110 | Out of scope |

**13 route files combine an allow-list with a second role predicate.** The
canonical case is `dtcm-pool/route.ts:56-62`: the desk allow-list admits
MEMBER, then `canViewEntryBarcode` refuses it, because a DTCM code is a door
credential. The registrations list and detail routes carry four such checks
each. This is why the parity test alone cannot protect the sweep (§6 Phase 1).

### 2.2 The predicates

Fourteen files hold role sets. The findings that shape this plan:

1. **One deny-list among allow-lists.** `RESTRICTED_WRITE_ROLES`
   (`auth-guards.ts:24`) names the roles that may NOT write. A role absent from
   it passes all 145 `denyReviewer`-only handlers.
2. **An org-wide default.** `buildEventAccessWhere` (`event-access.ts:184`)
   sends any unrecognised role, and API keys (`role: ""`), to the org-wide
   `where`.
3. **The same set, many names.** {SA, ADMIN, ORGANIZER} is `canWrite`,
   `SUPPORTING_DOCUMENT_ROLES`, `BUDGET_AUTHOR_ROLES`,
   `SUPPLIER_FINANCIALS_ROLES`, `TRAVEL_GRANT_MANAGE_ROLES`.
   {SA, A, O, ONSITE, WEBINARS} is both `BARCODE_ROLES` and `EXPORT_ROLES`.
   {SA, A} is login activity, CRM export, procurement admin. Permissions that
   were never named.
4. **API keys.** Admin-equivalent on the event surfaces and in MCP; refused on
   the per-person surfaces (HR, procurement, login activity, supporting
   documents, operator, CRM purge), which is deliberate. One exception is an
   accident (G9).
5. **Role lists outside the predicate files**, in at least 20 places (five
   public Zoom routes, activity, the agent route, CRM notes and reps, three
   components, the help chat, the header, `abstract-service`, notifications,
   accept-invitation, the MCP consent screen twice).
6. **`isTeamRole` makes 11 decisions**, not just list membership: per-request
   session revalidation (`auth.ts:359`), which event fields come back
   (`event-visibility.ts:60`), speakers own-row-only (`speakers/route.ts:143`),
   profile access, user promotion, and grant eligibility. 121 files read the
   role string.

### 2.3 Outside the routes

- **Middleware** (`src/proxy.ts:146-313`): per-role path confinement, and any
  role it does not name passes through to every page (`:258-262`).
- **Sidebar**: six nav flags, role equality checks, `WEBINAR_HIDDEN_MODULES`
  (event type) and `WEBINARS_ROLE_HIDDEN_MODULES` (role).
- **61 client files** branch on the role or a role predicate.
- **MCP**: about 101 tools, gated only at registration; the ~87 core tools have
  no role check.
- **In-app agent**: role allow-list, MEMBER read-only gate, finance and roster
  refusals.
- **Per-event assignment**: `settings.onsiteUserIds` and
  `settings.reviewerUserIds`, JSON id arrays. No grant table.
- **Mobile access tokens** are verified by signature only, a recorded decision
  (`api-auth.ts:50-66`); deactivation bites within the 24h token life.
- **Tests**: about 30 files pin role behaviour, including a route-level status
  matrix (`webinars-role-regression-matrix.test.ts`) that is the template for
  §6's sweep harness.

### 2.4 Gaps found (Phase 0 closes them)

| # | Gap | Where |
|---|---|---|
| G1 | New role writes everywhere by default | `RESTRICTED_WRITE_ROLES` deny-list |
| G2 | New role or API key gets org-wide events | `buildEventAccessWhere` default branch |
| G3 | GETs with no role check, org-scoped only (readable by CRM_USER, HR_USER, unassigned ONSITE, WEBINARS on conferences) | hotels/[hotelId], hotels/[hotelId]/rooms, review-criteria, speaker-agreement-template |
| G4 | Webinar attendance CSV (attendee PII) has no export predicate | `webinar/attendance?export=csv` |
| G5 | ~57 `denyReviewer`-only handlers resolve the event by hand (`event: { organizationId }`). Safe while only ADMIN and ORGANIZER pass; org-wide the moment a scoped permission replaces the role gate. Their separate org-null check (`!session.user.organizationId` → 403, or `requireOrgId`) is independent and stays | certificates, accommodation, abstract and proposal themes, review criteria, imports, promo detail |
| G6 | MCP OAuth token keeps working after the grantee is deactivated or signed out everywhere | `mcp/route.ts:72-75`. **CLOSED Sep 30, 2026:** the route refuses a deactivated grantee on every request, and Sign out everywhere, deactivation and password reset revoke the person's OAuth rows (`revokeUserOAuthTokens`) |
| G7 | Three home-made gates duplicating the shared ones | `requireAdmin` (ai, stripe credentials), `requireSuperAdmin` (logs/archive), `denyNonStaff` (profile). **CLOSED Sep 30, 2026, and the finding was partly wrong:** `requireSuperAdmin` and `denyNonStaff` already wrap shared predicates (`denyNonOperator`, `isTeamRole`) and stay. There was no shared org-admin gate at all; the SUPER_ADMIN/ADMIN line was copied into 16 handlers across 9 organisation settings routes, none logged. They now call `denyNonOrgAdmin` (auth-guards.ts), held to `check-guard-route.sh` |
| G8 | Session-only POSTs any signed-in account can call. Used today by SUBMITTERs (photo on My Details) and by REVIEWERs and SUBMITTERs (help chat); registrants have neither (no sidebar, no photo control) | `upload/photo`, `help-chat` |
| G9 | API key refused on the sponsor filter while the same route returns unredacted sponsor fields to API keys. The refusal's own comment ("a redacted field must not stay filterable") does not apply to an unredacted caller | `registrations/route.ts:278` vs `:553`. **CLOSED Sep 30, 2026:** one `redactsFinance` value now decides both |

---

## 3. The model

A **permission** is a key naming one operation on one resource. A **role** is a
named set of **grants**; a grant is a permission plus, for event-bound
permissions, a **scope**. A user keeps a **base role** and may hold **any number
of further roles** on top; their access is the **union of every held role's
grants, taken pair by pair** (§7.3). A few permissions also require a **person
grant** (§3.4).

```
permission  = "registrations.checkin"
scope       = ALL | ASSIGNED | WEBINAR      (event-bound permissions only)
role        = { key, name, organizationId, isSystem, grants: [(permission, scope)] }
access      = union over every held role's grants, whole pairs only
check       = can(principal, "registrations.checkin", { eventId })
```

### 3.1 Four dimensions, one catalogue

1. **Action on a resource.** CRUD plus the non-CRUD verbs, each its own key.
   Refund is not "write". Export is not "read". Delete is never implied by write.
2. **Scope** (event-bound permissions only):
   - `ALL`: every event in the org.
   - `ASSIGNED`: events the user is assigned to (today's ONSITE).
   - `WEBINAR`: events of type WEBINAR (today's WEBINARS manage surface).

   Scope is per grant, so WEBINARS is expressible: `registrations.checkin` at
   `ALL` beside `sessions.write` at `WEBINAR`.
3. **Sensitive-field visibility.** `finance.view`, `barcode.view`,
   `honorarium.view`, `supportingDocs.view`, `zoomHost.view`,
   `contacts.pii.view`. The redactors stay; only their predicate changes.
4. **Module access.** CRM, HR and procurement permissions. Module flags still
   gate on top: a permission for a disabled module grants nothing.

### 3.2 Scope on create and on change

A scope filters rows that exist. A create has no row, and a change can move a
row out of scope. So every scoped **create** and **update** also validates the
**resulting** object against the grant's scope: an event created or updated
under a `WEBINAR`-scoped grant must end up `eventType: WEBINAR`. This replaces
today's two special cases (`WEBINAR_ONLY` on events POST, the eventType-flip
refusal on the event PUT) with one rule in `requirePermission`.

### 3.3 Data model (additive; revised Sep 30, 2026: extend, never duplicate)

The three tables this section first proposed (`Role`, `RoleGrant`,
`UserRoleAssignment`) shipped on Sep 16, 2026 under
[PROCUREMENT_ROLES_PLAN.md](PROCUREMENT_ROLES_PLAN.md) as `PermissionSet`,
`PermissionSetGrant` and `UserPermissionSet`, with the catalogue in code, the
service (create, edit, archive, assign to a person, several per person),
the separation-of-duties checks on the union, and a `version` bumped on every
change. Revision 3 was written the day before and did not know. **Phase 1
extends those tables** (owner, Sep 30); the columns below are the whole
difference.

```prisma
model PermissionSet {          // the plan's Role
  key       String?            // "super_admin", "onsite": set on system roles only
  isSystem  Boolean  @default(false)
  // name, description, version, archivedAt, organizationId: as today
  @@unique([organizationId, key])
}

model PermissionSetGrant {     // the plan's RoleGrant
  scope     GrantScope?        // on an event-bound key; null on an organisation-wide one
}

enum GrantScope { ALL ASSIGNED WEBINAR }

// UserPermissionSet is the plan's UserRoleAssignment, unchanged (D3: several per person).
// EventStaffAssignment (Phase 4) is unchanged:
model EventStaffAssignment {   // replaces settings.onsiteUserIds (Phase 4)
  id             String   @id @default(cuid())
  organizationId String
  eventId        String
  userId         String
  assignedById   String?
  createdAt      DateTime @default(now())
  @@unique([eventId, userId])
}
```

No `UserRole.CUSTOM` and no `User.roleId` (D15, below). `User.role` stays the
base role.

**What `User.role` holds (revised for D3).** Because roles are additive, the
enum keeps its job: it is the person's **base** role, and the 121 files that
read the role string, plus the eleven `isTeamRole` decisions, carry on reading
it unchanged. Custom roles are `UserRoleAssignment` rows **on top**, so nobody's
`User.role` changes when they gain one.

A person who should hold **no** base access at all (a pure "PO Author" with
nothing else) is expressed as a system role named **"No base access"** with an
empty grant set (D15, owner, Sep 30 2026), not as a `CUSTOM` enum value. How
that base is STORED is left to Phase 5, the first phase that needs it: today
every account carries a `UserRole` value and nothing in Phases 1 to 4 changes
one. The smallest storage is a nullable `User.baseRoleKey` read ahead of
`User.role`; an enum value would touch `TEAM_ROLES`, `ASSIGNABLE_USER_ROLES`
and the compile guard, which is what D15 avoids.

After Phase 0 every predicate a route still uses is an allow-list, so a role
that grants something not yet swept fails closed. That is what makes "custom
roles stay off until the sweep is complete" structural rather than a promise.

**System roles resolve their grants from code.** `src/lib/permissions/system-roles.ts`
(built Sep 30, 2026) is the only definition. A system `Role` row exists per org for identity and the
FK, with no `RoleGrant` rows. A permission added in a later feature therefore
reaches every tenant's system roles the day it ships, which a seeded copy never
would. Cloning a system role snapshots the code grants into `RoleGrant` rows at
that moment, and the editor says so: a custom role does not follow later
additions.

**The catalogue lives in code** (`src/lib/permissions/catalogue.ts`, extended
Sep 30, 2026) with label, description, group, event-bound flag, sensitive flag
and person-grant flag, plus a **`live`** flag: a key is live when routes check
it. The system roles hold every key and `can()` answers for every key, but the
editor offers and the service stores only live keys (the 20 procurement keys
today), so a custom role can never carry a key nothing enforces. Phase 2 flips
a domain's keys to live as it sweeps it.
`RoleGrant.permission` is validated against it on write; a key later removed
from code is reported by a startup check rather than silently ignored.

**Tenancy.** `Role`, `RoleGrant` and `EventStaffAssignment` carry
`organizationId`, a policy in `prisma/rls/`, harness assertions and
`check-tenant-als.sh` entries, in the same change. See §3.5 for how the auth
path reads them without a lane.

**Lifecycle.** A role holding users cannot be deleted (FK `Restrict`); it is
archived, and archiving requires reassigning its users first. Audit rows about a
user's access snapshot `roleId`, role key and role name, since custom names
change.

### 3.4 Person grants: deliberately not role permissions

Four permissions require a grant on the person in addition to the role:

| Permission | Person grant | Why it is per person (recorded decisions) |
|---|---|---|
| `hr.read`, `hr.write` | `User.hrAccess` (SUPER_ADMIN and HR_USER exempt) | "HR is no longer implied by ADMIN precisely so that some admins can be kept out of it" (`users/[userId]/route.ts:32-38`). A role cannot express "this admin, not that one" |
| `procurement.approvals.decide` | `procurementApproveCeilingAed` / `procurementApproveUnlimited` | An AED ceiling per person |

(Revised Sep 30, 2026: the shipped procurement code lets `procurement.requests.create`
and `procurement.budgets.signoff` stand alone on a custom role, with
`User.procurementRequest` and `User.procurementSettle` as a transition arm that
grants the same keys by themselves until PROCUREMENT_ROLES_PLAN §10a retires
them. The code won; only the approval ceiling stays a person grant.)

These stay columns, SUPER_ADMIN-only to set, and **no role, system or custom,
grants them on its own**. `can()` checks both. The editor refuses a combination
that would break separation of duties (§7.7).

### 3.5 Where the permissions live at request time

The JWT does **not** carry the permission list (100 keys push an encrypted
cookie toward the 4 KB limit and go stale on the next edit).

- **Token carries:** the base role, `roleIds` for any additional roles, a
  **composite version** over them, and a short `modules` array for the Edge
  middleware and the sidebar, which cannot query the database.
- **Base role only (the common case, and every account on prod today):** grants
  come from code. **No database read** beyond today's per-request staff
  revalidation.
- **Holding one or more custom roles:** the revalidation read of `User` (which
  carries no policy) returns `organizationId`; the assignments, their `version`s and grants
  are then read **inside `runWithTenant(user.organizationId)`**. Reading `Role`
  outside a lane would return nothing under platform RLS (the tenant extension
  passes through with no store, and the policy compares against an unset
  setting), and every custom-role user would silently hold zero permissions.
  Borrowing the lane from the row keeps RLS on tenant-authored configuration.
  The RLS coverage test forces this decision either way.
- **Cache:** grants per process keyed on `roleId:version`; the union is
  recomputed from cached per-role grant sets, so N roles cost no extra reads.
  Cost: one indexed read per request for staff holding any custom role.
- **Mobile:** access tokens stay signature-only (§2.3). `mobile-refresh`
  checks the role version, so a role edit bites within the access token's life,
  the same bound deactivation has today.

---

## 4. The permission catalogue (draft, ~110 keys)

Event-bound keys take a scope. **R** = risk tier "sensitive" (editor warns).
**P** = also needs a person grant (§3.4).

| Domain | Permissions |
|---|---|
| Events | `events.read` · `events.create` · `events.update` · `events.delete` R · `events.clone` · `events.settings` · `events.staff.assign` |
| Registrations | `registrations.read` · `.create` · `.update` · `.delete` R · `.import` · `.export` R · `.checkin` (incl. undo) · `.badges.print` · `.bulk` (tags, type) · `.email` · `.promo.apply` · `dtcm.assign` |
| Money | `payments.record` · `payments.refund` R · `registrations.cancel` R · `creditNotes.issue` R · `invoices.read` · `invoices.write` · `invoices.send` · `invoices.export` R · `invoices.ledger` (org-wide) R · `billingAccounts.manage` |
| Speakers | `speakers.read` · `.create` · `.update` · `.delete` R · `.import` · `.email` · `speakers.agreements.manage` · `speakers.documents.read` · `speakers.documents.write` · `speakers.companion.grant` |
| Abstracts | `abstracts.read` · `.update` · `.decide` · `.delete` R · `.import` · `.email` · `abstracts.reviewers.assign` · `abstracts.themes.manage` · `abstracts.criteria.manage` · `reviewers.pool.manage` |
| Proposals | `proposals.read` · `proposals.decide` · `proposals.themes.manage` |
| Program | `sessions.read` · `sessions.write` · `sessions.delete` · `tracks.write` · `zoom.meetings.manage` |
| Tickets | `tickets.read` · `tickets.write` · `tickets.delete` · `promo.read` · `promo.write` · `promo.delete` |
| Accommodation | `accommodation.read` · `accommodation.write` · `accommodation.delete` · `hotels.manage` |
| Communications | `communications.send` · `communications.schedule` · `templates.manage` · `emailLogs.read` |
| Certificates | `certificates.templates.manage` · `certificates.issue` · `certificates.reissue` |
| Webinar | `webinar.manage` · `webinar.analytics.read` · `webinar.attendance.export` R · `sponsors.manage` · `media.manage` |
| Faculty extras | `reimbursements.manage` · `honorarium.manage` · `travelGrants.manage` · `rsvp.manage` · `rsvp.roster.read` R · `surveys.manage` · `surveys.export` R |
| Analytics and audit | `analytics.read` · `activity.read` (per event) · `activity.org.read` (org-wide) |
| Contacts | `contacts.read` · `contacts.write` · `contacts.delete` R · `contacts.import` · `contacts.export` R |
| CRM | `crm.read` · `crm.write` · `crm.delete` · `crm.export` R · `crm.purge` R · `crm.inbox.read` · `crm.dealValues.view` |
| HR | `hr.read` P · `hr.write` P |
| Procurement | The 20 keys the procurement roles plan shipped (`procurement.budgets.view/create/edit/discard/signoff`, `approvals.decide` P, `requests.view/create/manage`, `orders.view/receive/cancel/confirmReceipt/send`, `suppliers.view/propose/decide/edit/financials.view`, `catalogue.manage`), plus `procurement.integrations.manage` and `procurement.suppliers.transfer` for the two admin-by-role predicates. The coarse draft keys of revision 3 (`procurement.read`, `budgets.author`, `procurement.admin`) are superseded. Only `approvals.decide` is P: the code lets the request and settle keys stand alone, with the legacy columns as a transition arm (`LEGACY_PROCUREMENT_GRANTS`) |
| Organization | `org.settings` · `org.credentials` R · `users.invite` · `users.manage` R · `roles.manage` R · `apiKeys.manage` R · `loginActivity.read` · `agent.use` · `mcp.connect` (OAuth consent) |
| Field visibility | `finance.view` · `barcode.view` · `honorarium.view` · `supportingDocs.view` · `zoomHost.view` (`contacts.pii.view` dropped: no predicate exists for it) |

**Not in the catalogue:** the platform operator, the INTERNAL rate-limit tier,
and the public, token, registrant and cron routes. `upload/photo` and
`help-chat` stay session-only (G8): the REVIEWERs and SUBMITTERs who use them
hold no role, so no permission could express them.

**Agent and MCP tools carry no keys of their own.** Each tool maps to the
permission of its operation (`list_registrations` → `registrations.read`), so
the MEMBER read-only agent becomes "a role holding only read permissions".

---

## 5. System roles, as the code behaves today

Taken from the predicates and route guards (verified Sep 15), **not from the
docs**. Where the docs and the code differ (CLAUDE.md calls ORGANIZER "assigned
events only"; the code is org-wide), the code wins and the difference is
recorded, never "fixed" inside the migration. Phase 1 generates the exact matrix
as data; this table is the reviewable summary.

| System role | Holds | Does NOT hold (the cells the first draft got wrong are here) |
|---|---|---|
| **Super Admin** | Every catalogue key at `ALL`, incl. `crm.purge`, `activity.org.read`, `loginActivity.read`, `org.credentials`, `users.manage`; HR without a person grant; plus the fixed operator boundary | `procurement.request`, `.settle`, `.approve` without the person grant (grant-only for everyone, §3.4) |
| **Admin** | Every event, money, speaker, program, communications, certificates, webinar, faculty-extras, contacts key at `ALL`; `crm.read/write/delete/export/inbox/dealValues`; `procurement.budgets/requests/orders/suppliers.view`, `budgets.create/edit/discard`, `requests.manage`, `catalogue.manage`, `integrations.manage`, `suppliers.transfer`, `suppliers.financials.view`, `orders.send/receive/cancel`; `org.settings`, `org.credentials`, `users.invite`, `users.manage`, `apiKeys.manage`, `loginActivity.read`, `activity.org.read`, `agent.use`, `mcp.connect`; all six field keys | `crm.purge`; `abstracts.delete` (SUPER_ADMIN only today); `hr.*` without `hrAccess`; procurement P keys without person grants |
| **Organizer** | The same event-domain keys as Admin at `ALL`, incl. refund, cancel, credit notes, certificates, reimbursements, travel grants, supporting documents, registrations export; `activity.read` per event; `contacts.read/write/delete/import/export`; `crm.read/write/inbox/dealValues`; `procurement.*.view`, `budgets.create/edit/discard`, `suppliers.financials.view`; `events.staff.assign` (the Onsite Staff tab, D9); `agent.use`, `mcp.connect`; `finance`, `barcode`, `zoomHost`, `supportingDocs`, `honorarium` field keys | `crm.delete`, `crm.export`, `crm.purge`; `procurement.admin`; `org.settings`, `org.credentials`, `apiKeys.manage`, `users.manage`, `loginActivity.read`, `activity.org.read`; `abstracts.delete`; `hr.*` without `hrAccess` |
| **Member** | Most `*.read` at `ALL`; the desk at `ALL` (`registrations.create`, `.update`, `.checkin`, `.badges.print`, `payments.record`); `invoices.read`, `invoices.ledger`, `invoices.export`; `finance.view`; `contacts.read`, `contacts.export`; `crm.read`; `procurement.*.view`; `billingAccounts.read`; `agent.use` (read tools only, by consequence of holding no writes) | Every write outside the desk; `barcode.view`, `zoomHost.view`, `supportingDocs.view`, `honorarium.view`; `registrations.export`; `dtcm.assign`; `rsvp.roster.read`; `crm.inbox.read`, `crm.dealValues.view`; `loginActivity.read`, `activity.org.read` |
| **Onsite** | Desk at `ASSIGNED`: `registrations.read`, `.create`, `.update`, `.checkin`, `.badges.print`, `.export`, `payments.record`, `dtcm.assign`; `finance.view`, `barcode.view` | Everything else, incl. any event it is not assigned to |
| **Webinars** | Desk at `ALL` (as Member, plus `barcode.view`, `dtcm.assign`, `registrations.export`); full event control at `WEBINAR`: `events.create` and `events.update` (resulting type must be WEBINAR, §3.2), sessions, speakers, communications and templates, webinar, sponsors, media, surveys, tickets, registrations incl. import; `finance.view`, `zoomHost.view` | `registrations.delete` (L-4), refunds, cancel, credit notes, certificates, reimbursements, contacts, `invoices.ledger`, `emailLogs.read` beyond the desk, `events.delete`, `events.clone`, promo codes, `agent.use` |
| **CRM User** | `crm.read`, `crm.write`, `crm.delete`, `crm.inbox.read`, `crm.dealValues.view`; `contacts.read` | Every event key; `crm.export`, `crm.purge`; `contacts.export` |
| **HR User** | `hr.read`, `hr.write` (no person grant needed) | Everything else |
| **API key (full)** | What a key reaches, derived (`tool-permissions.ts`, `api-key-reach.test.ts`): the MCP tools (reads and writes across events, registrations, invoices, speakers, abstracts, programme, tickets, promo codes, accommodation, communications, templates, certificate templates, sponsors) and the key-capable REST routes (contacts, CRM, four event reads), at `ALL`; `finance`, `barcode` and `zoomHost` field keys. No deletes beyond promo codes and room types, no refunds, cancels or credit notes, no certificate issue, no payments, badges, DTCM, imports, exports beyond registrations and contacts | The per-person and person-scoped surfaces it is refused today: `hr.*`, procurement, `loginActivity.read`, `supportingDocs.view`, `crm.purge`, `users.manage`, `roles.manage`; the operator |

**Recorded on Sep 30, 2026 while writing the matrix as data** (`system-roles.ts`;
the code won each time, per §7.6):

- ORGANIZER holds `contacts.delete` and `contacts.import` (`denyReviewer` on
  the contacts routes admits it), not only read, write and export as the table
  said.
- ORGANIZER's ONSITE-only invite is modelled as `events.staff.assign` (the
  Onsite Staff tab: create, assign, remove), and `users.invite` / `users.manage`
  are ADMIN and above, which is what `isOrgAdmin` decides on the users routes.
- The API key does not hold `activity.read` (a session-only route) beside the
  three faculty-money keys its predicate refuses; everything else event-domain
  it holds at `ALL`, as the table said.
- **A gap to decide (not fixed):** the org-wide invoice ledger
  (`/api/invoices`) refuses WEBINARS by name but not ONSITE, whose `denyFinance`
  answer is yes, so a contractor account can read every event's invoices
  through the API (the UI confines it). The ONSITE system role does not hold
  `invoices.ledger`; the route is pinned when the money domain is swept.
- `canViewHr` reads the per-person tick on ANY role, staff or not; an org-null
  account never reaches the org-scoped module, so the HR rows of the matrix are
  stated for staff roles and parity is tested on those.
- Grant-only keys, held by no system role: `approvals.decide`, `requests.create`,
  `budgets.signoff`, `orders.confirmReceipt`, `suppliers.propose/edit`. The
  super admin is never an approver, the final approver never requests,
  settlement is a named person: these come from the person's grants or a
  custom role, and the parity test pins the list. ADMIN and SUPER_ADMIN send,
  receive and cancel orders by role (`commitment-service` `actsOnOrder`); a
  request holder sends and receives their OWN order only, a row rule no key
  carries, which the service keeps.
- Found by the first adversarial review of the matrix (Sep 30, 2026) and
  corrected: MEMBER does not read email logs (`email-logs` and `email-activity`
  are `WRITE_ROLES` plus `WEBINAR_STAFF_ALLOW`); the API key row had been
  written as "admin if it could reach" and was some forty cells wider than the
  code, so it is now derived from the tool registry and the key-capable routes
  and pinned by `api-key-reach.test.ts`; seven read keys were missing
  (`templates.read`, `media.read`, `sponsors.read`, `certificates.read`,
  `billingAccounts.read`, `surveys.read`) and `registrations.promo.apply` had
  been dropped without a note.
- **Under-claims left for the Phase 2 route matrix** (a swept route would
  refuse, never leak, so they are recorded rather than guessed): ONSITE today
  reads its assigned event's speakers, sessions, tickets, promo codes, invoices,
  analytics, abstracts, proposals, webinar attendance, email templates and
  sponsors through routes with no desk gate; WEBINARS reads promo codes,
  invoice exports, abstracts and proposals on webinar events; MEMBER reads
  speaker documents (`allow: ["MEMBER"]`); accommodation and hotel GETs are
  org-scoped with no role gate (G5), so ONSITE and WEBINARS read every org
  event's bookings today. The survey reset is `denyReviewer` with no
  allow-list although WEBINARS holds `surveys.manage` at `WEBINAR`.
- **Found by the route matrix (Oct 1, 2026), FIXED the same day:** `GET
  /api/events/[eventId]/promo-codes/[promoCodeId]` looked the event up by id
  and organisation only, with no role gate, so ONSITE, WEBINARS, CRM_USER and
  HR_USER reached any org event's promo code detail, including up to 50
  redemptions with attendee names and emails (amounts redacted for the last
  two), given a promo code id the list route would not have shown them. It now
  resolves the event through `buildEventAccessWhere`, as the list route does;
  the four matrix rows changed on purpose and now equal the list route's.

---

## 6. Build order

Each phase ships on its own, passes the full gate, and is **behaviour-identical
for every existing user** until Phase 5 turns on the editor behind
`CUSTOM_ROLES_ENABLED`. Every phase states its rollback.

### Phase 0: Harden what exists (1 to 2 weeks)

Closes G1 to G9 without introducing permissions.

1. Invert `RESTRICTED_WRITE_ROLES` to an allow-list (`WRITE_ROLES`). Same
   answer for all eleven roles, pinned by test.
2. `buildEventAccessWhere`: the default branch serves ADMIN, ORGANIZER,
   SUPER_ADMIN-with-org and API keys **by name**; any other role gets
   `{ id: { in: [] } }` and a warn log.
3. Gate G3's GETs and G4's export.
4. G5: replace the hand-rolled event lookups with `buildEventAccessWhere`,
   **keeping each route's org-null check where it is**.
5. G6: the MCP OAuth path runs `decideSessionValidity` on the grantee.
6. G7: delete the three home-made gates.
7. G8: record `upload/photo` and `help-chat` as session-only by design (owner
   tick, D10).
8. G9: let API keys use the sponsor filter (they already receive the field).
9. Collapse the identical role sets (§2.2 item 3) into named predicates and
   move the 20+ inline role lists onto them.
   **DONE Sep 30, 2026.** The two base pairs, `WRITE_ROLES` and
   `ORG_ADMIN_ROLES` with `isOrgAdmin`, live in the browser-safe
   `team-roles.ts` (`auth-guards` re-exports them); `canWrite` reads
   `WRITE_ROLES`. About 45 inline copies moved onto `canWrite`, `isOrgAdmin`
   or `denyNonOrgAdmin`, including 13 refusals that never logged (API keys x3,
   OAuth clients, organisation PUT, the user editor x2, invite, delete user,
   activity, event activity, and the MCP consent page and decision), the
   `["ONSITE", "WEBINARS"]` pair (`ONSITE_ACCOUNT_ROLES`) and the recipient
   queries. The two infrastructure routes already logged; their log names
   changed to `auth-guard:org-admin-denied` with a `route` field. The
   `*-visibility` sets stay as they are: each is a named predicate that becomes
   its own permission in Phase 1. `no-inline-role-lists.test.ts` scans `src/`
   and `worker/` for the forms it can recognise (an array of two or more STAFF
   role names, two comparisons on one variable, a comparison joined to an
   `is…Admin` helper, consecutive `case` labels, all across line breaks) and
   passes a hit only on a `const` definition in the named-predicate files.
   A role name held in a variable and compared later is outside what it sees.
   Outside-user roles (REVIEWER, SUBMITTER, REGISTRANT) route portals and are
   not scanned.

**Proof:** the existing ~30 role test files pass unchanged, plus one new test
per step. **Rollback:** revert the commit; no data changes.

### Phase 1: Catalogue, system roles, `can()`, the two safety nets (3 weeks)

Cut into four slices (Sep 30, 2026), each shippable dark:

1. **Catalogue, system roles as data, `can()`, safety net 1. BUILT Sep 30, 2026.**
   `catalogue.ts` grew from 20 procurement keys to 146 with the event-bound,
   sensitive, person-grant and `live` flags; `system-roles.ts` is the §5
   matrix as data (eight staff roles and the API key, `impliedPersonGrants`,
   `LEGACY_PROCUREMENT_GRANTS`); `can.ts` is `systemPrincipal()`, `can()` on
   whole (permission, scope) pairs and `eventWhereFor()`.
   `system-roles-parity.test.ts` runs every predicate a route asks today,
   for every role in the Prisma enum and the API key, and every legacy
   procurement grant combination, and deep-equals `buildEventAccessWhere` per
   role and surface against `eventWhereFor`; `api-key-reach.test.ts` derives
   the API key row from the tool registry (`tool-permissions.ts`) and the
   key-capable routes. Six deliberate wrong cells (MEMBER with barcodes,
   WEBINARS controlling every event, ONSITE unassigned, the key with sign-in
   activity, SUPER_ADMIN without the HR tick, a legacy grant without the
   views) each failed parity. Its blind spots are stated in the test header:
   route-decided cells are the matrix's reading until Phase 2 pins them.
   No migration, no behaviour change, nothing calls it.
2. **Schema. BUILT Oct 1, 2026.** `GrantScope` enum, `scope` on
   `PermissionSetGrant`, `key` and `isSystem` on `PermissionSet` with a unique
   on (organisation, key); migration `20261001090000`, additive and
   idempotent (re-applied to the local copy with notices only). The existing
   RLS policies are flat on `organizationId` and the three tables were already
   in the harness and `check-tenant-als.sh`, so no tenancy change was needed.
   The service accepts a grant as a key or a key with a scope, and refuses a
   scope on an organisation-wide key (`SCOPE_NOT_ALLOWED`) or none on an
   event-bound one (`SCOPE_REQUIRED`); `readUserGrants()` returns the union as
   pairs for slice 3. `ensureSystemPermissionSets()` upserts one system row per
   system role (key, name, `isSystem`, no grants) and is CALLED BY NOTHING yet;
   the list, edit, archive and assign paths all refuse a system row
   (`SYSTEM_ROLE`), so when a later slice seeds them nothing a user sees
   changes. Every live key is organisation-wide, so the Roles tab's requests
   and storage are byte-for-byte what they were.
3. **Request-time resolution (§3.5). BUILT Oct 1, 2026.** The token carries
   the held custom roles as `heldRoles: [id, version][]` instead of the key
   list; the Node session callback resolves the keys through
   `session-permissions.ts`, a per-process cache keyed on `id:version` (an edit
   or archive bumps the version, so no invalidation is needed; a miss reads
   only the missing roles, inside the tenant lane). The Edge mapper no longer
   maps keys (the middleware reads none). Old cookies drop the key list on
   their next refresh. A warn log `auth:session-cookie-large` fires above an
   estimated 3,000 bytes. Absorbs ROADMAP §"Session cookie size" options 2
   and 4. Verified in a headed browser on the standalone build: a MEMBER with
   no role has no keys (cookie 969 bytes); given PO Author, 10 keys and "New
   budget" appear on the next request (cookie 1,011 bytes); an edit to the
   role shows at once; archiving it empties the keys; an admin signs in
   unchanged. The tenant-ALS guard entry moved from `auth.ts` to the new
   module with the read (mutation-checked).
4. **`requirePermission()` (with the §3.2 resulting-object rule), `eventWhereFor`
   at the route boundary, and safety net 2.** The route status matrix harness
   extends the shape of `webinars-role-regression-matrix.test.ts`: per handler,
   the status for each of the eight staff roles, the three external roles, an
   API key and no session, with the event lookup's `where` captured. It proves
   the **routes** check the right keys, which parity cannot (§2.1). Built with
   the first two domains snapshotted; every later domain is snapshotted before
   it is swept. **BUILT Oct 1, 2026.** `src/lib/permissions/require-permission.ts`:
   `requirePermission(sessionOrPrincipal, key, { route, eventId, resulting })`
   answers 401 (nobody), 403 `{ error: "Forbidden" }` (the key is not held,
   the same body `denyReviewer` gives) or passes with the principal and
   `eventWhere`, which is `eventWhereFor` of the same key, so a route cannot
   look up events wider than the grant that let it in. `resulting` carries the
   event's facts after a create or update and must be admitted by a held grant
   of the key (§3.2): a `WEBINAR`-scoped `events.create` of a conference is a
   403 `OUT_OF_SCOPE`. Callers are not swept (Phase 2). The harness is
   `__tests__/api/route-matrix/`: 14 callers (the eight staff roles, the
   platform operator, the three external roles, an API key, no session)
   against four fixture events (an unlinked conference, a conference carrying
   every per-event link, a webinar, another organisation's conference with the
   same links). The captured `where` is EVALUATED against the fixtures rather
   than snapshotted as a shape, so a sweep that spells a filter differently
   and means the same passes, and an unknown filter key throws. A cell is the
   status plus `r` (an event read matched) and `w` (a write was attempted;
   writes throw). Snapshotted: events core (7 cases) and registration types,
   tiers and promo codes (13 handlers), in `__snapshots__/*.matrix.txt`.
   Mutation-checked: dropping WEBINARS from the tickets POST allow-list fails
   the matrix on exactly that row.

Nothing in production calls `can()` until Phase 2. **Rollback:** revert; the
new columns are unused.

### Phase 2: The route sweep (6 to 9 weeks)

Domain by domain:

1. Snapshot the domain's status matrix (safety net 2) on the unswept code.
2. Replace `denyReviewer(...)`, allow-lists, `denyFinance` and inline role
   comparisons with `requirePermission(session, "<key>", { route, eventId })`.
   Where a route combined predicates, it requires every corresponding key.
3. Replace the event lookup with `eventWhereFor(principal, "<key>")`; the
   permission and its scope come from the same grant.
4. The snapshot must match byte for byte.
5. Add the directory to `scripts/check-permission-guards.sh` (new, gating): in
   a swept directory, `denyReviewer(`, `role ===`, `role !==` or `*_ALLOW`
   fails CI naming the file. The list only grows.

Order, lowest risk first: events core · tickets and promo · sessions and
program · speakers · abstracts and proposals · accommodation · communications ·
certificates · webinar · faculty extras · contacts · registrations desk ·
money · org settings and users · CRM · HR · procurement. The desk and money
domains go late so the recipe is settled before it reaches what a live event
depends on. About 470 handlers, each with a matrix snapshot, is why this is 6
to 9 weeks and not 5 to 7. **Rollback:** per domain, revert the commit.

### Phase 3: Middleware, sidebar, UI, MCP, agent (2 weeks)

- `src/proxy.ts`: confinement from the token's `modules`, replacing the
  per-role branches; an unrecognised role (and `CUSTOM` without modules) gets
  the events list only, instead of today's pass-through (`:258-262`). The route
  layer stays authoritative.
- Sidebar: one filter from `modules` and `can()`.
- `useCan(permission, eventId?)` hook; sweep the 61 client files.
- MCP: register each tool when its permission is held **and** check at call
  time, since a role can change while a client is connected.
- Agent: drop the role allow-list and read-only gate.
- **MCP clients reconnect**; bump `package.json` and the lockfile.
- **Rollback:** revert; the route layer is unaffected.

### Phase 4: Event staff assignment (1 week)

- `EventStaffAssignment` replaces `settings.onsiteUserIds`: backfill, dual-read
  for one release, then drop the JSON reader.
- Settings → Onsite Staff becomes Settings → Event Staff: assign any user whose
  role holds an `ASSIGNED` grant.
- `reviewerUserIds` untouched (reviewers are external).
- **Rollback:** the JSON stays written during the dual-read release.

### Phase 5: The role editor (1 to 2 weeks)

- Before the editor ships: split the application descriptors out of the module
  the Settings client chunk imports (`permission-sets-card.tsx` reaches
  `catalogue.ts`), or accept the roughly 10 KB of labels it carries today.

Behind `CUSTOM_ROLES_ENABLED`, and only once Phase 2's gate covers every
directory (§7.1).

- Settings → Roles: system and custom roles with user counts; clone (with the
  snapshot notice, §3.3); a matrix editor grouped by domain with a scope per
  event-bound row; archive with forced reassignment.
- Settings → Users: the role picker lists system and custom roles; choosing a
  custom role sets `role: CUSTOM` and `roleId` together.
- API keys: pick a role per key; existing keys keep "API key (full)".
- Guardrails (§7.4, §7.7, §8.3), audit rows (`ROLE_CREATED`,
  `ROLE_GRANT_CHANGED`, `ROLE_ARCHIVED`, `ROLE_ASSIGNED`) with before and after,
  and **"View as role"**.
- **Rollback:** turn the flag off. Users already on custom roles fail closed to
  nothing and must be moved back to a system role, so the flag is turned on
  master with one test user first (D8).

### Phase 6: Retire the old model (1 to 2 weeks)

- Delete the staff branches from `buildEventAccessWhere`, the role sets from the
  visibility files, `canWrite`, `REGISTRATION_DESK_ALLOW`,
  `WEBINAR_STAFF_ALLOW`, `WRITE_ROLES`.
- **Keep the staff `UserRole` values**: Postgres cannot drop an enum value, and
  a system-role user's `role` still names the system role.
- Rewrite the ~30 role test files as parity, matrix and scenario tests.
- Independent adversarial review of the whole boundary before the flag turns on
  anywhere external tenants live.
- **Rollback:** revert; nothing is dropped from the schema in this phase.

### Effort

| Phase | Weeks |
|---|---|
| 0 Harden | 1 to 2 |
| 1 Catalogue, system roles, parity, matrix harness | 3 |
| 2 Route sweep | 6 to 9 |
| 3 UI, middleware, MCP | 2 |
| 4 Event staff assignment | 1 |
| 5 Role editor | 1 to 2 |
| 6 Retire, review | 1 to 2 |
| **Total** | **15 to 21** |

---

## 7. The traps

### 7.1 Deny-lists fail open

`RESTRICTED_WRITE_ROLES` is why a role added and forgotten can write to every
non-HR route. A permission model is allow-by-grant, but only once every handler
checks a permission; until then a custom role is judged by whatever predicate
the route still uses. Phase 0 makes those predicates fail closed for `CUSTOM`,
and **the editor stays off until Phase 2's gate covers every directory**.

### 7.2 Hand-rolled event lookups become org-wide

Replace G5's role gate with `requirePermission(..., "certificates.issue")` while
keeping `event: { organizationId }`, and a custom role holding that permission
at `ASSIGNED` issues certificates on every event. `eventWhereFor` exists so the
scope cannot be separated from the permission.

### 7.3 Unions pair the wrong halves

Today's code asks *may this role do X* and *which events* separately. Answered
role by role and then OR'd, a user holding MEMBER and WEBINARS would take
MEMBER's scope (all events) and WEBINARS' capability (full control) and hold
full control on conferences, which neither role grants.

**The trap is the recombination, not the second role.** Once scope belongs to
the grant, the unit of union is the whole pair, and that same user holds
`sessions.write @ WEBINAR` beside `registrations.checkin @ ALL`: full control on
webinars, desk on conferences, which is exactly what holding both should mean.
So this section argues for scope-on-the-grant (§3.1) and for `can()` taking the
pair. It is **not** an argument for one role per user, and was read as one in
revision 1 (D3, reversed Sep 16 2026).

The general class: **never union two answers that were computed as separate
questions.** Make the unit of union the complete decision. The tell that a
permission is safe to union naively is a guard that takes only a principal;
procurement's does (`denyNonProcurement(session, { need })`, no event, and no
procurement route imports `buildEventAccessWhere`), which is why the flat
module can adopt additive roles ahead of the sweep.

Two things must then hold, and both are already required elsewhere (§7.7,
§7.4): separation-of-duties rules are checked on the **union**, not per role,
and the editor's "grant only what you hold" bound reads the grantor's union.

### 7.4 Privilege escalation through the editor

- You can grant only permissions you hold, at a scope no wider than your own.
- You cannot change your own role or edit the role you hold.
- `roles.manage`, `users.manage` and `org.credentials` are grantable only by a
  holder of all three.
- Assigning a role to a user is itself bounded: you cannot assign a role wider
  than your own (this generalizes ORGANIZER's "may invite ONSITE only", D9).
- Every grant change bumps `Role.version`.

### 7.5 A route that combined predicates

Covered by safety net 2 (§6 Phase 1). Without it, sweeping
`dtcm-pool/route.ts` to the desk key alone would let MEMBER hold DTCM door
credentials, and every test that exists today would still pass.

### 7.6 Docs describe intent, code describes behaviour

§5 is taken from the code. Where a system role's real behaviour looks wrong, it
is recorded and decided separately.

### 7.7 Separation of duties

Procurement's spec §8.8 (the final approver never requests) and the per-person
HR decision survive only because §3.4 keeps those grants on the person. The
editor and the users API also refuse, for one person, `procurement.request`
together with unlimited approval, the same check
`isFinalApproverHoldingRequestGrant` makes today.

---

## 8. Design details

### 8.1 API keys

A key becomes a principal holding a role. Existing keys get the system role
**"API key (full)"** (§5), which matches today's behaviour after G9 is fixed. It
is not "everything": the per-person surfaces refuse keys today by design and
keep refusing. Phase 5 lets an admin choose a narrower role per key, which is
what a leaked integration key should have had.

### 8.2 Delete

`*.delete` is its own permission, never implied by `*.write`. Deletes that move
money or seats sit in tier R and follow the L-4 rule in the system roles: no
refund powers, no row deletion.

### 8.3 Editor warnings

Before save, the editor flags:

- any tier R permission;
- `finance.view` or `barcode.view` together with any `*.export` at `ALL`;
- `payments.refund` without `creditNotes.issue` (the refund route requires a
  credit note, so the role could never complete one);
- a desk permission without `registrations.read` at the same scope;
- an `ASSIGNED` grant on a role no user has event assignments for;
- a P permission on a role whose users hold no matching person grant ("this
  permission does nothing for 3 of 3 users").

---

## 9. Testing

- **Predicate parity** (Phase 1, BUILT Sep 30 2026: `system-roles-parity.test.ts`,
  `api-key-reach.test.ts`): every system role × every predicate, plus every
  legacy procurement grant combination, the event `where` per surface, and the
  API key row derived from the tool registry. Route-decided cells (about half
  the keys) are outside it by construction: see the route status matrix.
- **Route status matrix** (Phase 1 harness, one snapshot per domain in Phase 2):
  every handler × eight staff roles × three external roles × API key × no
  session, status and event `where`.
- **Catalogue integrity:** every key used in code exists in the catalogue; every
  catalogue key is used; every custom `RoleGrant` names a real key.
- **Scope isolation:** the ONSITE and WEBINARS isolation suites re-run against
  custom roles with `ASSIGNED` and `WEBINAR` grants, with mutation checks that
  widening a scope fails them; the §3.2 resulting-object rule on create and
  update.
- **Escalation and separation of duties:** each §7.4 and §7.7 rule as a route
  test.
- **Auth path under RLS:** a custom-role user on the tenancy harness holds their
  grants (the §3.5 lane), and holds nothing if the lane is removed.
- **RLS harness:** `Role`, `RoleGrant`, `EventStaffAssignment` isolated across
  two tenants sharing a role key.
- **CI gate:** `check-permission-guards.sh`, mutation-verified both ways.

---

## 10. Decisions for the owner

| # | Question | Recommendation |
|---|---|---|
| D1 | System roles editable, or clone-only? | Clone-only; their grants live in code (§3.3) **Ruled as recommended (owner, Sep 30, 2026).** |
| D2 | Scopes `ALL`, `ASSIGNED`, `WEBINAR`: enough? | Yes; generalize to any event type only when a tenant asks **Ruled as recommended (owner, Sep 30, 2026).** |
| D3 | One role per user, or several? | **Several** (owner, Sep 16 2026). Additive on top of a base role, unioned over (permission, scope) pairs (§7.3) |
| D4 | API keys hold a role? | Yes, defaulting to "API key (full)" (§8.1) **Ruled as recommended (owner, Sep 30, 2026).** |
| D5 | Who manages roles: SUPER_ADMIN only, or ADMIN too? | ADMIN too, under §7.4 **Ruled as recommended (owner, Sep 30, 2026).** |
| D6 | Procurement approval ceiling: user attribute or role parameter? | User attribute (§3.4) |
| D7 | Fold `hrAccess` and the procurement grants into roles? | **No** (changed in revision 2): they are per person on purpose (§3.4) **Ruled as recommended (owner, Sep 30, 2026).** |
| D8 | Enable the editor on master, the platform, or both? | Build once; enable on master first with one test user, then the platform **Ruled as recommended (owner, Sep 30, 2026).** |
| D9 | ORGANIZER may invite ONSITE only. Generalize as "may assign roles no wider than your own"? | Yes (§7.4) **Ruled as recommended (owner, Sep 30, 2026).** |
| D10 | `upload/photo` and `help-chat` stay session-only for any signed-in account? | Yes; the reviewers and submitters using them hold no role (G8) **Ruled as recommended (owner, Sep 30, 2026).** |
| D11 | Start with Phase 0 alone and decide on the rest after? | Yes |
| D12 | A custom-role user's `User.role` holds a new `CUSTOM` value? | Yes (§3.3) **Superseded Sep 30, 2026 by D15: no `CUSTOM` value.** |
| D13 | Custom-role grants read in a lane borrowed from the user row, or exempt the role tables from RLS? | Borrow the lane (§3.5) |
| D17 | Checkboxes on a named role or directly on the person? | **Named role** (owner, Sep 16 2026); see PROCUREMENT_ROLES_PLAN §8a |
| D15 | A person with no base access: add `UserRole.CUSTOM`, or seed a "No base access" system role? | Open; the seeded role is smaller (§3.3) **Ruled: "No base access" system role (owner, Sep 30, 2026); storage decided in Phase 5, §3.3.** |
| D16 | Build order | **Reversed the same day.** Procurement roles first (PROCUREMENT_ROLES_PLAN §0: three staff are blocked or over-permissioned today and Phase 0 fixes none of it). Phase 0 step 1 shipped on its own; the rest follows |
| D14 | Should the org-wide ORGANIZER scope be recorded as intended, since the docs say "assigned events only"? | Owner call; the migration preserves the code either way |

---

## 11. Out of scope

- External roles (§1) and cross-tenant membership (PLATFORM_DECISIONS §6).
- Per-row permissions, time-limited grants, approval workflows for role edits.
- Field-level visibility beyond the six named sensitive-field permissions.
- Renaming or dropping enum values.

---

## 12. Review log

**Revision 1** (Sep 15, 2026): drafted from three read-only inventories (roles
and predicates, routes by domain, non-route consumers).

**Review** (Sep 15, 2026), each finding then verified against the code:

| Finding | Verdict | What changed in revision 2 |
|---|---|---|
| H1: predicate parity cannot catch a route swept to the wrong key | Confirmed: 13 files combine an allow-list with a second predicate (`dtcm-pool/route.ts:56-62`) | Safety net 2, the route status matrix (§6 Phase 1, §7.5) |
| H2: what `User.role` holds for a custom-role user | Confirmed: `isTeamRole` drives 11 decisions, 121 files read the role | `UserRole.CUSTOM` in `TEAM_ROLES` (§3.3, D12) |
| H3: role tables unreadable on the auth path under RLS | Confirmed: the tenant extension passes through with no store; the RLS coverage test forces the choice | Lane borrowed from the user row (§3.5, D13) |
| H4: seeded system-role grants miss later permissions | Confirmed by construction | System-role grants in code (§3.3, D1) |
| M1: §5 cells wrong | Confirmed and wider: ADMIN lacks HR without `hrAccess`; ORGANIZER lacks users.manage, org settings, credentials, org-wide activity; MEMBER is refused the RSVP roster and CRM inbox; SUPER_ADMIN lacks the procurement P keys; `abstracts.delete` is SUPER_ADMIN only | §5 rewritten from the code with a "does not hold" column |
| M2: scope cannot express create-time limits | Confirmed (`events/route.ts:157`, `[eventId]/route.ts:241-248`) | Resulting-object rule (§3.2) |
| M3: API-key finance parity | Partly wrong: all 19 `denyFinance` sites are session-only, but the sponsor filter refuses keys while the route returns them unredacted | G9 fixed in Phase 0; §8.1 rewritten |
| M4: role deletion and reassignment absent | Design gap | Lifecycle (§3.3), editor archive flow (Phase 5) |
| M5: D10 cannot be expressed through roles | Confirmed, with a correction: registrants use neither surface; reviewers and submitters do | G8 and D10 rewritten |
| LOW: Phase 0 widens an org-null SUPER_ADMIN on G5 routes | **Overturned**: those routes keep a separate org check | Phase 0 step 4 says keep it |
| LOW: mobile path gains a per-request read | Confirmed as contradicting a recorded decision | Version checked on `mobile-refresh` (§3.5) |
| LOW: header numbers, Phase 2 estimate, rollback | Confirmed | Header, effort table, per-phase rollback |

**Found during verification, not in the review:** the middleware passes any
unrecognised role through to every page (`proxy.ts:258-262`, Phase 3); the
`ASSIGNABLE_USER_ROLES` compile guard will require `CUSTOM` (§3.3); and the HR
and procurement grants are per person by recorded decision, which reversed D7
(§3.4, §7.7).
