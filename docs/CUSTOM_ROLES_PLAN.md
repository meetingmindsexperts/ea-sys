# Customizable Roles: permission-based access for org staff

> **Status (Oct 5, 2026): PHASES 0 AND 1 COMPLETE; PHASE 2 ROUTE SWEEP DONE, 18 of
> 18 domains plus the organisation-level leftovers (335 route files, every event route on `requirePermission`, pinned by
> `scripts/check-permission-guards.sh`); see §6 Phase 2 "Progress" and
> "Behaviour changes so far".** Revision 4 (Sep 30, 2026). Owner rulings this
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
| Remaining event routes | SECURITY: reviewers, submitters and registrants no longer read analytics or the per-attendee check-in log; the agreement template follows the speakers read; Webinars may import speakers from a spreadsheet on webinars |
| Organisation users | ONSITE, WEBINARS, CRM and HR no longer list the team or open colleagues' records; everyone still reads their own |
| Money | `payments.record` · `payments.refund` R · `registrations.cancel` R · `creditNotes.issue` R · `invoices.read` · `invoices.write` · `invoices.send` · `invoices.export` R · `invoices.ledger` (org-wide) R · `billingAccounts.manage` |
| Speakers | `speakers.read` · `.create` · `.update` · `.delete` R · `.import` · `.email` · `speakers.agreements.manage` · `speakers.documents.read` · `speakers.documents.open` R (added Oct 2, 2026) · `speakers.documents.write` · `speakers.companion.grant` |
| Abstracts | `abstracts.read` · `.update` · `.decide` · `.delete` R · `.import` · `.email` · `abstracts.export` R · `abstracts.reviewers.assign` · `abstracts.themes.manage` · `abstracts.criteria.manage` · `reviewers.pool.manage` · `submissions.share` (added Oct 2, 2026, with `abstracts.export`) |
| Proposals | `proposals.read` · `proposals.decide` · `proposals.export` R (added Oct 2, 2026) · `proposals.themes.manage` |
| Program | `sessions.read` · `sessions.write` · `sessions.delete` · `tracks.write` · `zoom.meetings.manage` |
| Tickets | `tickets.read` · `tickets.write` · `tickets.delete` · `promo.read` · `promo.write` · `promo.delete` |
| Accommodation | `accommodation.read` · `accommodation.write` · `accommodation.delete` · `hotels.manage` |
| Communications | `communications.send` · `communications.schedule` · `templates.manage` · `emailLogs.read` |
| Certificates | `certificates.templates.manage` · `certificates.issue` · `certificates.reissue` |
| Webinar | `webinar.manage` · `webinar.analytics.read` · `webinar.attendance.export` R · `sponsors.manage` · `media.manage` |
| Faculty extras | `reimbursements.manage` · `honorarium.manage` · `travelGrants.manage` · `rsvp.manage` · `rsvp.roster.read` R · `surveys.read` · `surveys.manage` · `surveys.export` R · `surveys.reset` (added Oct 2, 2026) |
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
| **Onsite** | Desk at `ASSIGNED`: `registrations.read`, `.create`, `.update`, `.checkin`, `.badges.print`, `.export`, `payments.record`, `dtcm.assign`; `finance.view`, `barcode.view`. Reads at `ASSIGNED` that the Phase 2 matrix found and the owner kept (Oct 1 to 2, 2026): `events.read`, `tickets.read`, `promo.read`, `sessions.read`, `speakers.read`, `abstracts.read`, `proposals.read`, `webinar.analytics.read` | Everything else, incl. any event it is not assigned to |
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

**Progress.**
- **Events core SWEPT Oct 1, 2026** (`/api/events`, `/api/events/[eventId]`):
  `events.read` (list and detail, `onMissing: "hide"`, so CRM_USER and HR_USER
  still get an empty list and a 404), `events.create`, `events.update`,
  `events.delete`. The two WEBINAR_ONLY checks are now `refuseOutOfScope`
  (§3.2), which keeps the `WEBINAR_ONLY` code for a webinar-only grant. The
  external roles keep their `buildEventAccessWhere` branch (§1) and
  `requireOrgId` stays (G5). Matrix byte for byte; the two files are the
  first entries in `scripts/check-permission-guards.sh` (gating in CI).
  Verified in a headed browser on the standalone build as ADMIN, WEBINARS,
  ONSITE, MEMBER and CRM_USER. Two 403s on those pages predate the sweep and
  come from other routes (`/api/organization/eventsair/credentials` for
  WEBINARS and MEMBER, the event activity feed for MEMBER).
- **Registration types and promo codes SWEPT Oct 1, 2026** (the six
  `tickets` and `promo-codes` route files): `tickets.read` / `.write` /
  `.delete` and `promo.read` / `.write` / `.delete`. The matrix showed three
  reads the system roles did not grant (§5 under-claims); the owner kept them
  ("proceed" on the recommendation), so ONSITE now holds `tickets.read` and
  `promo.read` at `ASSIGNED` (its desk add-registration form needs the
  types) and WEBINARS `promo.read` at `WEBINAR`. The promo create route gained
  an event check through `gate.eventWhere`: the service's own lookup is
  org-wide, equivalent only while every `promo.write` holder is org-wide.
  Matrix byte for byte; all six files are in `check-permission-guards.sh`.
  Verified on the standalone build as ADMIN (type, tier and promo create,
  edit, delete), ONSITE assigned (reads 200, writes 403), MEMBER, WEBINARS on
  a conference and CRM_USER (404s), with no failed request and no console
  message.
- **Sessions and tracks SWEPT Oct 2, 2026** (`sessions`, `sessions/[sessionId]`,
  `sessions/bulk-delete`, `tracks`, `tracks/[trackId]`; the session Zoom routes
  go with the webinar domain): `sessions.read` for every agenda read (list,
  detail, tracks), `sessions.write`, `sessions.delete` (detail and bulk) and
  `tracks.write`. Two additions to `requirePermission`: `linkedRoles: "linked"`
  lets the outside identities (REVIEWER, SUBMITTER, REGISTRANT) keep reading
  through `buildEventAccessWhere` on the reads that served them (§1), and
  `principalFromCaller` takes the session, an API key or a mobile token for the
  session list, which accepts all three. ONSITE reads its assigned event's
  agenda today, so it now holds `sessions.read` at `ASSIGNED` (same choice as
  registration types: nobody's access changes; remove it if ONSITE should not
  see the agenda). Matrix byte for byte; five files added to the guard.
  Verified in a headed browser with the chrome-devtools MCP on the standalone
  build: ADMIN created, edited and deleted a track and sessions (single and
  bulk) with every request 200/201; ONSITE (assigned) and MEMBER read 200 and
  write 403; WEBINARS on a conference and CRM_USER 404. **Recorded, not
  changed:** these routes never had `requireOrgId`, so the platform operator
  (SUPER_ADMIN with no organisation) can create, edit and delete sessions and
  tracks on ANY organisation's events, where the first two domains refuse it.
  The sweep keeps that; whether the operator should write tenant agendas is an
  owner call.
- **Speakers SWEPT Oct 2, 2026** (14 route files: the list, detail, tags,
  bulk tags, both imports, activity, agreement, documents and their files,
  email, companion registration, profile form; honorarium and reimbursement
  types go with faculty extras). Keys: `speakers.read` (list, detail,
  activity), `.create`, `.update` (edit, bulk tags, the tags list, the email
  change), `.delete`, `.import`, `.email`, `.agreements.manage`,
  `.documents.read` (the document LIST), `.documents.write` (upload, remove,
  and the profile form, which collects documents), `.companion.grant`, and a
  NEW key `speakers.documents.open` for the FILES. **Owner rulings, Oct 2,
  2026:** ONSITE keeps reading speakers on its assigned events ("they need all
  the fields to add a registration"), so it holds `speakers.read` at
  `ASSIGNED`; MEMBER keeps seeing a speaker's document list but never the
  files (passport copies among them), so it holds `speakers.documents.read`
  and only ADMIN, ORGANIZER and SUPER_ADMIN hold `.documents.open`. The tags
  list maps to `speakers.update` because MEMBER and ONSITE were refused it
  (403) before. Matrix byte for byte (21 cases); 14 files added to the guard.
  Verified with the chrome-devtools MCP on the standalone build: ADMIN read,
  edited, tagged, uploaded a document, opened it and deleted it; ONSITE
  (assigned) reads speakers and activity, 403 on tags, documents and writes;
  MEMBER also lists documents and is 403 on opening one; WEBINARS on a
  conference and CRM_USER 404 or 403 as recorded. **Recorded, not changed:**
  (1) MEMBER's speaker page requests the tags list and issued certificates and
  gets 403 for both, two console errors that predate the sweep (Phase 3: the UI
  should not ask for what the role cannot read); (2) the platform operator is
  refused (no organisation) on the list writes, detail, email, tags and profile
  form, but can act on any tenant's speaker activity, agreement, documents and
  companion registration, which never had `requireOrgId`. Preserved as found;
  part of the same owner call as the agenda.
- **Abstracts and proposals, staff side SWEPT Oct 2, 2026 (part A)** (16
  files: abstract themes and sub-themes, proposal themes, review criteria, the
  reviewer pool, an abstract's reviewer assignment, resend confirmation, the
  presenter-agreement email, the submission share links). Keys:
  `abstracts.read` / `proposals.read` (theme lists, attendee-side roles
  `linked`; review criteria), `abstracts.themes.manage`,
  `proposals.themes.manage`, `abstracts.criteria.manage`,
  `reviewers.pool.manage`, `abstracts.reviewers.assign` (with an event check
  ahead of the org-only services), `abstracts.email`, and a NEW key
  `submissions.share` for the share links (Admin and Organizer). ONSITE (at
  `ASSIGNED`) and WEBINARS (at `WEBINAR`) now hold `abstracts.read` and
  `proposals.read`, keeping what the matrix recorded (and §5 listed), part B
  included. **One change on purpose:** the review criteria GET was org-scoped
  with no role check (G3), so CRM_USER, HR_USER, unassigned ONSITE and WEBINARS
  on conferences read any event's criteria; it now resolves through
  `abstracts.read`, and those four matrix rows were re-recorded. The harness
  learned nested `event: { ... }` filters (`e` in a cell) to pin the sub-theme
  routes; the guard now flags staff role names only, as plan §1 keeps the
  outside identities' own checks. Verified with the chrome-devtools MCP:
  ADMIN created, edited and deleted themes, sub-themes, proposal themes and
  criteria, with clean Abstracts and Reviewers pages; ONSITE (assigned) and
  CRM_USER answered as the matrix records. **Part B** (the abstract and
  proposal routes where authors and reviewers write) is next.
- **Abstracts and proposals, author and reviewer side SWEPT Oct 2, 2026 (part
  B), with a SECURITY FIX** (abstracts list and create, an abstract, its
  review submissions, the author profile, session proposals list and create,
  a proposal). The matrix harness gained opt-in fixture rows (an abstract and
  a proposal on every event owned by the submitter, a reviewer assignment) so
  the rules after the event lookup show. That exposed, and a headed browser
  reproduction confirmed on the unswept code: **any REGISTRANT (an ordinary
  delegate account) could list and read every abstract and proposal on an
  event they had registered for, including content, author email and the
  abstract's `managementToken`, and could edit another author's abstract and
  create abstracts under another speaker**; MEMBER, ONSITE and WEBINARS could
  create and edit abstracts; reviewers could edit any field; and any org
  account (CRM, HR, a desk temp elsewhere) read the anonymised reviews of any
  abstract by id. **Fixed (owner, Oct 2, 2026):** reads gate on
  `abstracts.read` / `proposals.read` with only REVIEWER and SUBMITTER passed
  through their linked events (registrants refused); create and edit on
  `abstracts.update` / `proposals.decide` with authors passed (their own-row
  rules kept); a reviewer may send a review status only
  (`REVIEWER_STATUS_ONLY`); scoring on `abstracts.decide`, reviewers through the
  service's pool-or-assigned rule; delete on `abstracts.delete`; exports on two
  new keys, `abstracts.export` and `proposals.export`; `managementToken` is no
  longer returned. `requirePermission`'s `linkedRoles` now takes a list of the
  outside identities a route serves. The guard flags the caller's role
  compared with a staff name or a variable, not with an outside-identity
  literal (plan §1). Verified with the chrome-devtools MCP: the registrant gets
  404 on reads and 403 on writes at the same URLs that leaked; the author,
  the pool reviewer (status 200, content 403, score 201), MEMBER (reads only)
  and ADMIN (exports, page) work. `managementToken` is minted but read by no
  route today, so its exposure granted nothing yet. Whether the hole was ever
  used on production is unknown: success is not logged.
- **Accommodation SWEPT Oct 2, 2026, with the G5 fix** (hotels, a hotel, room
  types, a room type, bookings, a booking): reads on `accommodation.read`,
  hotels and rooms on `hotels.manage`, bookings on `accommodation.write` /
  `.delete` (with an event check ahead of the org-only booking service). Every
  GET checked only the organisation (G5), so CRM_USER, HR_USER, ONSITE on any
  event and WEBINARS on conferences read every event's hotels and bookings,
  guest names included. No screen gives ONSITE or WEBINARS accommodation (the
  middleware confines ONSITE to the desk; webinars hide the module), so nothing
  was granted: reads now follow the catalogue (SUPER_ADMIN, ADMIN, ORGANIZER,
  MEMBER) and those four roles' read rows were re-recorded on purpose. Writes
  did not move. Verified with the chrome-devtools MCP: ADMIN created, read,
  edited and deleted a hotel, a room type and a booking with a clean page;
  MEMBER reads 200 and writes 403; ONSITE and CRM_USER 404.
- **Communications SWEPT Oct 2, 2026** (11 files: bulk email and its audience
  count, scheduled emails and retry, templates and their duplicate, the email
  preview, attachments, the email activity feed). Keys: `communications.send`
  (bulk, audience count, preview, attachments, and the activity feed, kept
  webinar-only for WEBINARS; `emailLogs.read` would have widened it to every
  event), `communications.schedule`, `templates.read`, `templates.manage`. The
  harness now evaluates an `event: { ... }` filter on a WRITE too, which pins
  the scheduled-email H-2 binding (WEBINARS matches its webinar only). **One
  change on purpose:** ONSITE read its assigned event's templates (and that GET
  seeds missing defaults, a write); no ONSITE screen uses templates, so it
  follows `templates.read` and loses them. Recorded, not changed: the template
  preview reads the event in parallel with the access check
  (`buildRealPreviewOverrides`), so a refused caller costs a read whose result
  is discarded. Verified with the chrome-devtools MCP (no email sent): ADMIN
  created, read, edited, previewed, duplicated and deleted a template, and
  created, edited and cancelled a scheduled email, with clean Communications
  and Email Templates pages; MEMBER reads templates only; ONSITE 404 on
  templates; WEBINARS on a conference 404.
- **Certificates SWEPT Oct 2, 2026** (21 files: templates, their duplicate and
  starter, settings, eligibility, preview, issue and single issue, runs and a
  run's download, cancel, retry and send, issued certificates, reissue, resend
  and its preview, bulk reissue). Keys: `certificates.read`,
  `certificates.templates.manage` (templates and settings), `certificates.issue`
  (issuing, runs, the download), `certificates.reissue`. Only SUPER_ADMIN,
  ADMIN and ORGANIZER hold any of them, as only they passed `denyReviewer`
  before, so no role gained or lost access. Every route scoped the event by
  hand from the organisation in four shapes; all now come from
  `gate.eventWhere`, which also BINDS the template and run lookups to the URL's
  event (they matched any event in the organisation, despite their comment),
  so the other-organisation column lost its `e` with the same status. Reissue
  gained an event check ahead of its org-only service, placed after the
  route's no-organisation refusal. Verified with the chrome-devtools MCP (no
  issue run, nothing sent): ADMIN created, edited, duplicated and deleted a
  template and read settings, runs, issued, eligibility and analytics with a
  clean page; MEMBER 403 throughout, as before.
- **Webinar SWEPT Oct 2, 2026** (15 files: the console's settings, provision,
  room, live stream, sequence, panelists and their resend and speaker sync,
  questions, presence, attendance, engagement, recording fetch; the event's
  Zoom settings; a session's Zoom meeting and panelists). Keys:
  `webinar.analytics.read` (the console's reads), `webinar.manage` (its writes,
  the panelist list and the live-stream address, which carries the stream key
  and so is refused, not hidden), `webinar.attendance.export` (the CSV),
  `sessions.read` (Zoom settings and a session's meeting and panelists, which
  the session form reads), `zoom.meetings.manage`, `events.settings` (the Zoom
  settings PUT). The matrix found ONSITE reading the console on its assigned
  events; the owner kept it, so ONSITE gained `webinar.analytics.read` at
  `ASSIGNED`. ONE intended change, re-recorded on purpose: the attendance CSV
  (every attendee's email) moved to `webinar.attendance.export`, so MEMBER and
  ONSITE get 403 where they downloaded it before (owner, Oct 2, 2026; MEMBER
  could not export registrations either). `requireOrgId` stays ahead of each
  gate, so the outside identities keep their 403. The Zoom host-field
  redaction (`canViewZoomHostCredentials`) stays as it is in the sessions
  routes: field visibility is Phase 3. The live-stream GET's role check is
  gone; `webinar.manage` holders are exactly the host-credential roles.
  Verified with the chrome-devtools MCP on a temporary webinar (nothing reached
  Zoom): ADMIN and WEBINARS consoles render, with only the panelists 400 a
  webinar without a Zoom meeting always gives; ADMIN and WEBINARS saved
  settings and downloaded the CSV; MEMBER reads and gets 403 on the CSV, host
  routes and writes; ONSITE reads on its assigned webinar and 404 elsewhere;
  WEBINARS 404 on a conference.

- **Faculty extras SWEPT Oct 2, 2026** (20 files: reimbursements, a
  reimbursement, its PDF and documents, the send, the settings; a speaker's
  honorarium and reimbursement types; travel grants and a grant's status; RSVP
  campaigns, a campaign, items, an item, the guest list, an invite, the invite
  send; survey answers, their export, and a registration's survey reset).
  Keys: `reimbursements.manage`, `honorarium.manage`, `travelGrants.manage`,
  `rsvp.manage`, `rsvp.roster.read` (the guest list and its CSV, which carry
  each invitee's link token), `surveys.read`, `surveys.export`, and a NEW key
  `surveys.reset` (ADMIN and ORGANIZER only: the owner's rule on the reset
  route excludes the webinar team, which holds `surveys.manage` on webinars).
  `loadRsvpEvent` and the reimbursement row loader now take `gate.eventWhere`.
  **One change on purpose (owner, Oct 2, 2026):** MEMBER reads survey answers
  on screen (`surveys.read`); it was refused before, although the route's
  comment and the catalogue both said it could. The export stays with the
  hosts. `rsvp-roster-access.test.ts` now pins the lookup to the grant's own
  filter instead of a `buildEventAccessWhere` call. Verified with the
  chrome-devtools MCP (nothing sent): ADMIN created, renamed and filled an
  RSVP, read its guest list and CSV, read and saved reimbursement settings,
  read reimbursements, travel grants, a speaker's honorarium and claim types,
  with clean RSVP, Reimbursements and Survey pages; MEMBER loads the Survey
  page clean and is 403 on the export and every other faculty route;
  WEBINARS on a conference 404 on the survey and 403 elsewhere.
- **Contacts SWEPT Oct 5, 2026** (8 files under `/api/contacts`: the list and
  create, a contact, its email change, bulk tags, the tag list, export, CSV
  import, the EventsAir import). Keys: `contacts.read` (MEMBER, CRM_USER and
  API keys read), `contacts.write`, `contacts.delete`, `contacts.export`
  (MEMBER yes, CRM_USER no, the July 16 owner rule), `contacts.import`. These
  routes take a session, an API key or a mobile token through
  `getOrgContext`, so they gate on `principalFromCaller(session, ctx)`: a
  signed-in person brings their own grants, a key the API_KEY row. The
  `denyContactAccess` / `denyContactExport` helpers had no callers left and
  are removed; `canViewContacts` / `canExportContacts` stay for email logs,
  the CRM and supporting documents, pinned to the keys by the parity test.
  `contacts-read-access.test.ts` mocks `auth()` so it still drives the caller
  through the org context. Matrix byte for byte; no behaviour change.
  Verified with the chrome-devtools MCP: ADMIN created, edited, tagged,
  re-addressed, exported, imported and deleted contacts with a clean Contacts
  page; MEMBER reads and exports, 403 on create; CRM_USER reads, 403 on export
  and create.
- **Registrations desk SWEPT Oct 5, 2026** (22 files: the list and its CSV,
  add, a registration's detail, edit and delete, activity, barcode image,
  check-in and undo, recorded payment, email and email change, the paid
  documents resend, the supporting document; badges and their preview; bulk
  tags and type; import from contacts and from a spreadsheet, the completion
  emails; the tag list; spare DTCM codes; registration share links; the Onsite
  Staff tab). Keys: `registrations.read` (list, detail, activity, tags; the
  list hides, the others refuse, as recorded), `.create`, `.update`, `.delete`,
  `.export` (the CSV), `.checkin`, `.badges.print`, `.bulk`, `.import`,
  `.email`, `payments.record`, `dtcm.assign`, `invoices.send` (the paid
  documents resend), `events.staff.assign` (organisation-wide, so the Onsite
  Staff route keeps its organisation-bound event lookup), and two NEW keys:
  `registrations.email.change` (ADMIN, ORGANIZER, WEBINARS on webinars; the
  desk roles hold `.update` but never could change the address) and
  `registrations.share` (ADMIN and ORGANIZER, like `submissions.share`). The
  barcode image and the supporting document gate on `registrations.read` and
  then check the field key (`barcode.view`, `supportingDocs.view`) with
  `can()`. The list takes a session, an API key or a mobile token
  (`principalFromCaller`). `registrations-export-audit.test.ts` now drives the
  export refusal through the real gate (MEMBER) instead of a mock of the
  removed call. **Changes on purpose, re-recorded:** (1) WEBINARS reaches the
  barcode image on every event where it works the desk (owner; it 404'd on
  conferences while its printed badges carried the same code); (2) the
  platform operator is refused the barcode image and supporting documents,
  because an organisation-wide field key needs an organisation (`can()`); it
  read both on any tenant's events before. **Found and fixed during
  verification:** the registration detail sheet requested the event's email
  templates for every role, and since the communications sweep (Oct 2) that
  is a 404 for ONSITE: the claim in that entry that "no ONSITE screen uses
  templates" was wrong. The templates only feed the Send Email menu, which
  desk operators never see, so the sheet now fetches them only when that
  menu can show (which also removes the older 404 for WEBINARS on a
  conference). **Recorded, not changed:** the barcode PNG is served
  `private, max-age=3600`, so on a shared desk computer the next person
  signed in can see a cached image for an hour; and the platform operator
  still reaches check-in, payments, DTCM codes, badges and the tag list on
  any tenant's event (no `requireOrgId`), part of the parked operator call.
  Verified with the chrome-devtools MCP (no email sent): ADMIN added, edited,
  tagged, checked in (button and API) and undid, printed badges, read the
  barcode, activity and CSV, created, renamed, regenerated and deleted a
  share view, and assigned an ONSITE account; ONSITE (assigned) and MEMBER
  worked the desk with clean Registrations and Check-In pages, MEMBER 403 on
  the CSV, barcode and DTCM codes; WEBINARS on a conference got the barcode
  image and 404 on the email change.
- **Money SWEPT Oct 5, 2026** (17 files: a registration's refund, cancel,
  credit note, promo code and quote; an event's invoices, an invoice, its PDF
  and send, the event invoice CSV; attaching payers to an event; the
  organisation's invoice book and its export; the payer book and merge).
  Keys: `payments.refund`, `registrations.cancel`, `creditNotes.issue`,
  `registrations.promo.apply`, `invoices.read` (list, invoice, PDF, quote),
  `.write`, `.send`, `.export`, `invoices.ledger` (the org book and its
  export, replacing `denyFinance` plus the hand-written WEBINARS refusal),
  `billingAccounts.read` / `.manage` (organisation-wide, so the payer routes
  keep their organisation-bound lookups). Each pair of `denyReviewer` and
  `denyFinance` became one key. **Owner rulings, Oct 5, 2026:** ONSITE was
  reading the organisation's WHOLE invoice book and its export (every event,
  not only its assignments; the August H-1 fix refused WEBINARS and missed
  ONSITE): now refused. ONSITE keeps its assigned events' invoices, quotes
  and invoice CSV, and with WEBINARS the payer list its add-registration form
  reads (`billingAccounts.read`), so those were granted as found; WEBINARS
  also gained `invoices.export` at `WEBINAR`, which it already used.
  **Also re-recorded:** the platform operator now gets a clean 403 on a
  registration's promo code, attaching payers to an event and the payer book,
  where it reached lookups bound to an empty organisation id (404, an empty
  list, or a 500 from a write with no organisation). Verified with the
  chrome-devtools MCP, with no money moved and nothing sent: ADMIN read
  invoices, the event CSV, a quote PDF, the org book and its CSV, created,
  renamed, attached and detached a payer, and reached validation on refund,
  cancel, credit note and promo; ONSITE 403 on the org book and its export,
  200 on its event's invoices, CSV, quote and payers; MEMBER reads all and
  is 403 on every money action; WEBINARS 403 on the org book, 404 on a
  conference's invoices. Invoices pages clean for ADMIN and MEMBER.
- **Domain added Oct 5, 2026: remaining event routes.** Eighteen event route
  files belong to no domain above (analytics and traffic, the event activity
  feed, media, sponsors, clone, the export bundle, the other imports, the
  import log, the agent, agreement PDF images, the speaker agreement
  template, submitter context). They are swept as a domain of their own after
  money, which makes eighteen domains, not seventeen.
- **Remaining event routes SWEPT Oct 5, 2026** (18 files; every file under
  `/api/events` is now in the guard). Keys: `analytics.read` (analytics, its
  CSV and check-in log, the traffic view, the import log), `activity.read`,
  `media.manage` (the library, read included: MEMBER was always refused it,
  so `media.read` left EVENT_READ; ADMIN, ORGANIZER, WEBINARS on webinars and
  API keys still hold it, and no route reads it yet),
  `sponsors.read` / `.manage`, `events.clone`, `abstracts.import`,
  `sessions.write` (the session import), `speakers.import`,
  `speakers.agreements.manage` (the agreement template and the PDF header and
  footer images), `speakers.read` (reading the template), and three NEW keys,
  each ADMIN and ORGANIZER only as before: `events.export` (the whole-event
  ZIP), `dtcm.import` (the DTCM spreadsheet) and `imports.eventsair`. ONSITE
  holds `analytics.read` and `sponsors.read` at `ASSIGNED`, as found (the
  desk's sponsor picker reads the list). The event agent hands off to the
  agent's own gate (Phase 3) and submitter context serves only the SUBMITTER
  itself; both joined the guard unchanged. **Owner rulings, Oct 5, 2026:**
  (1) SECURITY: analytics had no role guard at all, so REVIEWER, SUBMITTER
  and REGISTRANT read it, its CSV and the per-attendee check-in log (names,
  emails, door times) on their linked events, another organisation's
  included; now refused (DATA_EXPORTS gap 1, closed); (2) the speaker
  agreement template was read through an organisation-only lookup by
  CRM_USER, HR_USER, ONSITE on unassigned events and WEBINARS on
  conferences; it now follows `speakers.read`; (3) WEBINARS may run the
  speaker CSV import on webinars, matching its contacts and registrations
  imports; (4) MEMBER stays refused the media library. Verified with the
  chrome-devtools MCP: ADMIN read every route, saved sponsors and downloaded
  the event ZIP, with clean Analytics, Overview and Media pages; the seeded
  REGISTRANT and REVIEWER get 404 on analytics and the check-in log;
  CRM_USER 404 on the template; ONSITE (assigned) and MEMBER keep analytics
  and sponsors, MEMBER's Analytics page clean.

- **Organisation settings, part A, SWEPT Oct 5, 2026** (24 files: the
  organisation and its branding, the AI, Stripe, Zoom and EventsAir
  credentials and tests, API keys and OAuth clients, sign-in activity and who
  is online, custom roles and their holders, a user's custom roles, signing a
  user out everywhere, the org-wide Onsite Staff list, the organisation
  activity page). Keys: `org.settings` (the PUT; the GET and branding have no
  role check and keep none), `org.credentials`, `apiKeys.manage`,
  `loginActivity.read`, `roles.manage` (through `denyNonRoleAdmin`, which now
  asks `can()` and keeps the module flag's 404), `users.manage` (signing
  SOMEONE ELSE out; anyone signs themselves out), `events.staff.assign`,
  `activity.org.read`, and a NEW key `apiKeys.internalTier`, SUPER_ADMIN only,
  for issuing an INTERNAL-tier key or switching an OAuth client to it (two
  inline `role !== "SUPER_ADMIN"` checks before). **Re-recorded on purpose:**
  the organisation-less platform operator gets a clean 403 on the
  organisation PUT, API keys, OAuth clients, the Onsite Staff list and the
  activity page, where it reached them with a null organisation; production
  has no such account (its one SUPER_ADMIN belongs to the organisation and
  holds every key, so acting in another organisation through `x-org-id` is
  unchanged). **Found during verification and fixed:** Settings requested the
  custom-role holder counts for every role, a console 403 for ADMIN and
  ORGANIZER since the roles editor shipped; it now asks only for the super
  admin, re-running once the session loads (the users list loads twice on
  that first visit). Part B (inviting, editing and removing users) follows;
  email logs and the profile route wait for their own part. Verified with
  the chrome-devtools MCP: SUPER_ADMIN read every route and tab, issued and
  removed an INTERNAL key, saved the organisation; ADMIN's six tabs clean and
  403 on INTERNAL keys and custom roles; ORGANIZER's four tabs clean, only
  the Onsite Staff list and its own events' staff.
- **Organisation users, part B, SWEPT Oct 5, 2026** (the team list and
  invite; a user's record, edit and delete). Keys: `users.invite` (any role)
  or `events.staff.assign` (ORGANIZER: ONSITE accounts only, through a
  `isOnsiteDeskAccount` helper on the TARGET role), `users.manage` (editing
  someone else, changing a role, deactivating, deleting anyone), `roles.manage`
  (HR access and procurement grants, SUPER_ADMIN only, two inline checks
  before), and a NEW key `users.read` (the team list and a colleague's record:
  SUPER_ADMIN, ADMIN, ORGANIZER, MEMBER). Everyone still reads and renames
  their OWN record. `isRoleGrantableHere` moved to `team-roles.ts` so neither
  route names a staff role. **Owner ruling, Oct 5, 2026:** any org-bound
  account (ONSITE temps, WEBINARS, CRM_USER, HR_USER) could list the whole
  team with emails, roles and HR and procurement grant flags, and open any
  colleague's record; they are now refused (no screen of theirs uses it).
  Also re-recorded: the platform operator gets a clean 403 instead of a 500
  on invite, edit and delete. Verified with the chrome-devtools MCP (accounts
  created with a set password, so no invitation email): ADMIN invited,
  read, renamed, deactivated and deleted an ONSITE account and was refused HR
  access; ORGANIZER created and deleted an ONSITE account and was refused an
  ADMIN invite and editing another account; the ONSITE account read and
  renamed itself and was refused the team list; the profile page clean.
  Organisation settings now remain only for email logs and the profile
  route's own staff check.
- **CRM SWEPT Oct 5, 2026** (all 47 route files, 78 handlers). The routes
  already named no role: every one calls the CRM's shared guards
  (`requireCrmRead` / `Write` / `Delete` / `Export` / `Purge` in
  `crm-route.ts`), and those called role predicates. The guards now ask ONE
  function, `crmCan(ctx, key)` in `crm-visibility.ts` (`crm.read`, `.write`,
  `.delete`, `.export`, `.purge`), and so do the routes' own checks for deal
  values, the inbox, quote defaults and the bulk-read audit
  (`crm.dealValues.view`, `crm.inbox.read`, `crm.quoteDefaults.manage`,
  `crm.export`), fourteen calls. The client-safe predicates in `crm-roles.ts`
  stay for the UI and are pinned to the same keys by the parity test.
  `crmCan` builds the principal from the org context (a session, an API key
  or a mobile token); custom keys live today are procurement only, so a
  session adds nothing yet: thread it through when CRM keys become
  grantable. Matrix generated one case per handler: byte for byte, no
  behaviour change. Six CRM test files' `crm-route` mocks now pass the real
  `crmCan`, and the inbox source-scan test asks for `crm.inbox.read`.
  Verified with the chrome-devtools MCP: CRM_USER created and archived a
  company, read deals, reports and the inbox, 403 on export; MEMBER read,
  403 on the inbox and on writes; ORGANIZER edited, 403 on archive; ADMIN
  exported and read reports; CRM and inbox pages clean.
- **HR SWEPT Oct 5, 2026** (all 12 route files, 17 handlers). Same shape
  as the CRM: every route calls `denyNonHr`, which now asks
  `can(principalFromSession(session), "hr.read" | "hr.write")` (the person's
  `hrAccess` tick comes from the session; SUPER_ADMIN implies it; HR_USER
  needs none; an API key holds no HR key) and keeps the module flag's 404.
  Pinned to canViewHr / canWriteHr by the parity test. Matrix generated per
  handler (some HR handlers take a NextRequest, so a 0 there marks a throw
  past the catch, alike on both sides): byte for byte. One test fixture
  gained an organisation, which real HR accounts always carry. Verified with
  the chrome-devtools MCP: HR_USER and SUPER_ADMIN read employees, leave
  codes, holidays and the summary; ADMIN without the tick 403; the HR page
  clean.
- **Procurement SWEPT Oct 5, 2026** (54 route files under
  `/api/procurement` and `/api/integrations`, 74 handlers; the live module).
  Procurement already ran on permission keys (custom roles began here), with
  role and legacy person-grant fallbacks in client-safe predicates. The
  server boundary now asks ONE function, `procurementCan(user, key)` in
  `procurement-roles.ts`, which builds the principal exactly as
  `principalFromSession` does (base role, the four legacy grants through
  `LEGACY_PROCUREMENT_GRANTS`, live custom keys). `denyNonProcurement` maps
  each need onto keys; `integration` and `supplier-transfer` ask without
  custom keys (the owner fixed them to the role); `approve` keeps the AED
  ceiling check on the person. The route helpers (`denyUnlessRequestOrAdmin`,
  `denyWithoutFinance`, `orderActorFrom`) and 17 route-level calls ask it
  too, and the approval-chain route's inline SUPER_ADMIN check became a NEW
  key, `procurement.approvalChain.manage` (SUPER_ADMIN). The client-safe
  predicates stay for the screens and services. Proof: the generated matrix
  (byte for byte), and a NEW `procurement-guard-parity.test.ts` comparing
  the guard and the route checks with the old rules over every role, every
  legacy-grant combination, thirteen custom key sets, every need and a range
  of amounts (over 30,000 cases). Its first run caught one divergence before
  anything shipped: a custom role holding only "raise requests" or "sign
  off" could propose suppliers under the old rule and not under the bare
  propose key; `propose` now asks all three. Verified with the
  chrome-devtools MCP (reads plus one catalogue create, nothing emailed):
  SUPER_ADMIN read every list and the approval chain; ADMIN, ORGANIZER and
  MEMBER read the lists and are 403 on the chain; ADMIN passed the
  catalogue gate, MEMBER 403; ONSITE 403 throughout; pages clean.
- **Organisation-level leftovers SWEPT Oct 5, 2026** (9 files). Email
  history and a stored email body gate on `emailLogs.read` and look entities
  up through the grant's event filter; history not tied to an event
  (CONTACT, USER, OTHER, and bodies with no event) needs a NEW key
  `emailLogs.org.read` (ADMIN, ORGANIZER), which replaces two
  `role === "WEBINARS"` confinements (review M-1) with a key WEBINARS does
  not hold. The organisation media library uses a NEW organisation-level key
  `media.library.manage` (ADMIN, ORGANIZER; `media.manage` is per event).
  The PDF upload is the certificate background, so
  `certificates.templates.manage`; the EventsAir event import
  `imports.eventsair`; the claude.ai consent decision `mcp.connect`. The
  photo upload (any signed-in account) and the staff profile (TEAM_ROLES
  self-service) joined the guard with their own checks. Matrix byte for
  byte; the consent test's session gained its organisation. Verified with
  the chrome-devtools MCP: ADMIN read registration and user email history
  and the media library (page clean); WEBINARS read registration history
  and is 403 on user and contact history and the media library.
  **Still outside the guard, by design or pending a decision:** the admin
  infrastructure page (`admin/infra`, ADMIN by role, no catalogue key yet),
  the public session pages' staff preview shortcut (`canWrite`: a key would
  let WEBINARS preview its own webinars, a widening for the owner), the
  registrant's own quote (an outside identity's portal), and the operator
  surfaces (`/api/admin`, `/api/logs`), which are not staff permissions.
- **Code review of money and the remaining event routes, Oct 5, 2026** (two
  independent reviewers, each finding checked against the code). Fixed before
  pushing: (HIGH) a payer's detail (`GET /api/billing-accounts/[id]`) returns
  the payer's registrations with attendee names and emails, invoices and
  payments on EVERY event, and ONSITE and WEBINARS reached it (through
  `denyFinance` before, through `billingAccounts.read` after the sweep); it
  now needs `invoices.ledger`, and the desk shows those two roles the payer's
  name without the link; (MEDIUM) the matrix sent JSON to the upload routes,
  which fail at form parsing for every role, so the one intended widening was
  unpinned: the harness now sends real multipart files (`HandlerCase.form`),
  recorded first against the unswept code; (LOW) the agreement PDF images and
  the export bundle now bind the event through `gate.eventWhere`, clone also
  needs `events.create` for the copy's kind (`refuseOutOfScope`), and stale
  comments and doc lines were corrected. **Recorded for Phase 3:** MEMBER can
  call the agent's `list_media` today (a `list_` read tool) and will lose it
  when the agent enforces `media.read`, which MEMBER no longer holds; the
  import log rides on `analytics.read`, so a custom role granted analytics
  also gets it.

**Behaviour changes so far.** Everything else in the swept domains answers as
it did before, byte for byte in the route matrix. These changed on purpose,
each approved by the owner:

| Domain | Change |
|---|---|
| Promo codes | The detail lookup was organisation-only; it is now bound to the URL's event |
| Abstracts (part A) | Review criteria (G3) no longer readable by CRM, HR, unassigned Onsite, or Webinars on conferences |
| Abstracts (part B) | SECURITY: registrants can no longer read, edit or create abstracts and proposals; Member, Onsite and Webinars can no longer write them; reviewers send a status only; `managementToken` no longer returned; anonymised reviews no longer readable org-wide |
| Accommodation | Hotels and bookings (guest names) no longer readable by CRM, HR, Onsite, or Webinars on conferences |
| Communications | Onsite no longer reads its assigned event's email templates (its registration sheet requested them; fixed Oct 5 so the sheet no longer asks) |
| Certificates | Template and run lookups bound to the URL's event (same statuses) |
| Webinar | The attendance CSV (attendee emails) downloads only for Admin, Organizer and Webinars; Member and Onsite see attendance on screen only |
| Faculty extras | Member reads survey answers (a widening) |
| Money | Onsite no longer reads the organisation's invoice book or its export; the platform operator gets a clean 403 on promo codes, event payers and the payer book |
| Registrations desk | Webinars sees the barcode image on conferences (a widening, matching its badges); the platform operator no longer reads tenants' barcode images or supporting documents |

Recorded and left as found, each an owner call: the platform operator
(SUPER_ADMIN with no organisation) can write on routes that never had
`requireOrgId` (agenda, speaker activity, agreements, documents, companion
registration); MEMBER's speaker page asks for two things it cannot read (two
console 403s, Phase 3); Zoom host fields are still redacted by role
(`canViewZoomHostCredentials`) until field visibility moves in Phase 3.

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

**Progress (Oct 5, 2026).**

- *Areas.* Each system role names the parts of the app it works in
  (`SystemRole.areas` in `system-roles.ts`: dashboard, events, desk, org, crm,
  hr, procurement, operator; events and desk carry a scope). A key says what a
  role may do; an area says where it works. Without areas a keys-only sidebar
  showed Onsite the dashboard and an Organizer the CRM. `inArea(p, area,
  event?)` and the client-safe `principalFromUser(user)` live in `can.ts`;
  `principalFromSession` now delegates to it.
- *Sidebar.* `computeSidebarNav` (`src/components/layout/sidebar-nav.ts`) is
  one filter: an item shows when the principal works in its area and holds one
  of its keys; event items need their key for that event. The outside
  identities (registrant, reviewer, submitter) keep their own branches. The
  Organizer's hidden CRM and Budgets entries stay a display preference (owner).
  Pinned for 11 roles, 4 person variants, 5 contexts and both module flag
  states by `__tests__/components/sidebar-nav.test.ts`. Intended changes, both
  owner-approved: Member no longer sees Media and Reviewers (both refused it
  already, so the links led to a spinner and a false "0 reviewers"); CRM User
  and HR User lose event menus they could never open.
- *useCan and the "no access" panel* (owner, Oct 5: a refused page says so
  and names who to ask, instead of an empty list, a spinner or a blank page).
  `useCan(key, eventId?)` (`src/hooks/use-can.ts`) asks the same `can()` from
  `principalFromUser`; with an event it waits for the event GET and judges the
  scope from its facts (`eventFactsOf`: type and `settings.onsiteUserIds`).
  `<PermissionGate>` mounts a page only when the key is held, so a refused
  page fires no requests; `<NoAccess>` is the one panel (role named, "ask an
  organisation admin"). `events/[eventId]/layout.tsx` shows it for any event
  whose GET answers 403 or 404. Applied so far: Media, an event's Reviewers,
  Infra / Ops (replacing its bare "Not authorized."), and every event page.
  Advisory only; the routes stay the authority.
- *The client sweep, driven by a crawl* (Oct 5). Every dashboard page was
  opened as Member, Onsite and Webinars on the local build and each refused
  request recorded; the fixes are of two kinds.
  - Whole pages: `EVENT_PAGE_KEYS` (`src/lib/permissions/event-page-keys.ts`)
    names the key each event page's own list request asks; the event layout
    waits for the event and shows the panel when the key is not held, so the
    page never mounts. The role-by-page result is pinned by
    `__tests__/permissions/event-page-keys.test.ts` (Admin, Organizer and
    Super Admin are refused nothing). The organisation invoice book shows the
    panel to a finance role without `invoices.ledger` (Onsite).
  - Single requests on pages a role may open: the data hooks take `enabled`
    and the caller passes its `useCan` answer (speaker tags, issued
    certificates, scheduled emails, email activity, the event activity feed,
    webinar panelists, ticket types and sponsors on the desk, the reviewers
    list on Communications, the budget lookup on event settings). The EventsAir
    dialogs read the credentials only once opened.
  - Found and left for the owner: an Organizer holds `imports.eventsair` and
    `contacts.import` but not `org.credentials`, which listing EventsAir events
    needs, so the EventsAir import never worked for an Organizer. The button is
    now offered only to who holds both (Admin, Super Admin).
  - Owner, Oct 5: Organizers stay without the EventsAir import.
- *Write buttons* (Oct 5). A crawl as Member listed every action button it
  could see; each now asks `useCan` for the exact key its route asks (traced
  handler, hook, route). Re-crawled: Member keeps only its desk actions,
  Admin keeps every button. Found, not changed: `surveys.manage` and
  `events.settings` are in the catalogue but no route asks for them (the
  survey builder and every settings Save use `events.update`); bulk
  certificate and survey sends ask only `communications.send`; contact delete
  is still offered to Admin only although Organizer holds `contacts.delete`.
- *Middleware* (Oct 5). `confinementRedirect` (`src/lib/route-confinement.ts`)
  replaces the per-role branches in `src/proxy.ts`: staff are confined by
  their role's areas, the desk keeps an event's Registrations and Check-In,
  and an unrecognised role (and CUSTOM before Phase 5) keeps the events list
  only. Pinned role by path; diffed against the old branches, the changes are
  /logs for Admin, Organizer and Member, /invoices and /analytics for Onsite,
  /analytics for Webinars, own profile and registrations for CRM User and HR
  User, and the unrecognised role. No JWT change: the Edge derives areas from
  the role.
- *Agent* (Oct 5). The door asks `agent.use`; every tool call asks the key
  its REST route asks (`src/lib/agent/tool-permissions.ts`), judged on the
  call's `eventId` (else the page's event); a tool with no key is refused and
  a test fails when a registered tool lacks one. The model is offered only
  tools the person can use somewhere. The read-only banner and money
  redaction now follow `events.update` and `finance.view`. Against the old
  role rules (pinned in `agent-tool-gate-parity.txt`), only Member moved: it
  loses the reviewers list, media library, scheduled emails and certificate
  templates (its screens already refused them) and gains add, edit and check
  in a registration (its desk). Admin, Organizer and Super Admin unchanged.
- *MCP door: not changed.* The owner parked MCP-door parity (Sep 22: MCP
  keeps writes, an API key stays admin-equivalent). Gating it the same way is
  `tool-permissions.ts` plus a registration filter, when the owner decides.
- *Field visibility* (Oct 5). Money, entry barcodes, Zoom host details,
  honorarium, supporting documents, sign-in activity, deal values and the
  travel-grant and reimbursement cards now ask their keys (`finance.view`,
  `barcode.view`, `zoomHost.view`, `honorarium.view`, `supportingDocs.view`,
  `loginActivity.read`, `crm.dealValues.view`, `travelGrants.manage`,
  `reimbursements.manage`) instead of the role predicates: about 40 sites in
  routes, pages and components, plus the event export, which now takes the
  exporter's principal. A route judges the field on its gate's principal, so a
  session, an API key and a mobile token are each read as the route already
  read them. The predicates stay, pinned equal to the keys by
  `system-roles-parity.test.ts`. One intended change: the platform operator no
  longer reads or imports a tenant's DTCM pool (as with the barcode image).
  Left on roles: `denyFinance` on the registrant invoice routes (registrants
  are outside identities) and the CRM and Budgets agent-tool internals (the
  parked MCP door).
- **Phase 3 is complete** except the MCP door (parked). Next: Phase 4.

### Phase 4: Event staff assignment (1 week)

- `EventStaffAssignment` replaces `settings.onsiteUserIds`: backfill, dual-read
  for one release, then drop the JSON reader.
- Settings → Onsite Staff becomes Settings → Event Staff: assign any user whose
  role holds an `ASSIGNED` grant.
- `reviewerUserIds` untouched (reviewers are external).
- **Rollback:** the JSON stays written during the dual-read release.

**Progress (Oct 5, 2026): release 1 of 2 built.**

- Migration `20261005120000_add_event_staff_assignment`: the table (unique
  per event and user, cascades with the event, the user and the
  organisation), backfilled from the JSON for ids that are real users of the
  event's own organisation (a stale or foreign id is dropped). Additive and
  idempotent: re-run on the local prod copy, a no-op; it carried the one live
  assignment. RLS in `prisma/rls/eventstaffassignment.sql`, isolation proofs
  in `tests/tenancy/eventstaffassignment-rls.test.ts` (CI harness).
- `src/lib/event-staff.ts` is the only writer: assign and unassign write the
  row and the JSON together. `assignedToEventWhere()`
  (`src/lib/event-staff-where.ts`, pure) is the only reader shape, used by
  `buildEventAccessWhere` (ONSITE) and `eventWhereFor` (ASSIGNED scope): it
  accepts either store. The event GET returns `staffUserIds` from the table,
  which `eventFactsOf` reads beside the JSON; the agent's facts loader and
  the Onsite Staff lists read both. Route matrices unchanged except the
  remove-staff handler now writes the row first.
- Verified in the browser: remove and re-add from Settings, Onsite Staff
  write and clear both stores; with the JSON entry deleted by hand, the
  assigned Onsite user still opens the desk through the row alone.
- **Release 2 (after one deploy cycle):** stop writing and reading
  `settings.onsiteUserIds` (drop the JSON arm of `assignedToEventWhere`, the
  JSON half of `event-staff.ts`, and the fallbacks). Settings → Onsite Staff
  becomes Event Staff when Phase 5 lets other roles hold an ASSIGNED grant.

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

**Progress (Oct 5, 2026): slice 1 of 3 built (the server).**

- `CUSTOM_ROLES_ENABLED` (`isCustomRolesEnabled()`, module-flags.ts). Off, a
  custom role grants only the procurement keys, as since Sep 16; a stored
  grant of any other key grants nothing, which is the rollback. On, every
  catalogue key is grantable (`isGrantableKey`), since Phase 2 made every
  route enforce its key.
- Custom grants reach the session as `key` or `key@SCOPE`
  (`encodeSessionGrant`), filtered by the flag where the session is built;
  `principalFromUser` decodes them, so an event-bound custom grant keeps its
  scope on the screens and in `can()`.
- Guardrails (§7.4) in `src/lib/permissions/escalation.ts`, enforced by the
  service on create, edit and assign: grant only what your roles hold, at no
  wider a scope; the admin trio (`roles.manage`, `users.manage`,
  `org.credentials`) only from someone holding all three; never edit a role
  you hold or change your own roles (`OWN_ROLE`). The top administrator
  (holds the trio: SUPER_ADMIN) may grant any key, including the six
  procurement keys their own role leaves out, as before. Codes
  `BEYOND_YOUR_ACCESS`, `ADMIN_TRIO`, `OWN_ROLE` answer 403.
- "Holds any custom key" no longer means "may enter Budgets":
  `holdsCustomProcurementKey` checks for a procurement key.
- **Design note:** a custom role adds KEYS within the person's base-role
  AREAS; it does not add areas (the middleware reads areas from the role, so
  this needs no JWT change). A custom role that should reach a new area needs
  a base role that works there.
- *Slice 2, the editor (built Oct 5).* Settings → Roles appears where
  Budgets or custom roles is on. The role dialog lists every grantable key by
  group (161 with the flag on, the 20 Budgets keys with it off) with a
  search box; an event-bound key gets a scope picker (every event, assigned
  events, webinars only). The §8.3 warnings that need no database run live
  (`role-warnings.ts`: sensitive keys, exporting while seeing money or
  barcodes, a refund without credit notes, a desk action without
  registrations at the same scope). Settings → Team gets a Roles button per
  person (never on yourself or a super admin) when custom roles are on. A
  role may hold up to 200 keys. Verified on the local build with the flag on:
  created a role with two scoped keys (stored as chosen), assigned it,
  console clean.
- *Next:* slice 3: API keys per role, the two warnings that need the
  database, audit-row names, "View as role".

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
