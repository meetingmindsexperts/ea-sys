# Custom roles for Budget & Procurement: PLANNED, NOT BUILT

**Status:** planning, revised Sep 16, 2026. Owner direction: "a custom role with
custom access for the procurement module, eventually for other roles too". Do
not start building without owner go-ahead on §10.

**Build order (owner, Sep 16 2026): this work comes FIRST**, ahead of the
org-wide plan's Phase 0, on the evidence in §0. Phase 0 step 1 (the write
allow-list inversion) shipped separately on Sep 16 and stands on its own.

The idea: the super admin creates named roles such as **PO Author** or **PO
Approver**, each a set of checkboxes (view budgets, create budgets, edit
budgets, and so on), and tags one or more of them onto a person. The person
keeps their base role (Organizer, Member, Webinars) for everything else.

## 0. The use case that set the priority (owner, Sep 16 2026)

Four real people, traced end to end against the code the same day:

| Person | Wants | Today | Gap |
|---|---|---|---|
| Bassem, **Webinars** | Create budgets, raise requests | Requests work with the grant | **Cannot author budgets and no switch exists.** `canAuthorBudgets` is role-only (Super Admin, Admin, Organizer) |
| Richard, **Organizer** | Raise requests, NOT author or browse budgets | Requests work | **Authoring and viewing come with his base role and cannot be withheld** |
| Fabian, sometimes **Onsite** | Raise requests, nothing else | Reaches `/procurement` and can raise | No Budgets entry in the Onsite sidebar branch, so he needs the URL |
| Muthu, **HR** | HR only, granted per person | Correct already | None; `hrAccess` is already a per-person grant, super admin only |

**Bassem and Richard are one missing capability seen from both sides.** Budget
authoring is granted by role with no per-person switch, so it can neither be
given to a non-organizer nor withheld from an organizer. The only workaround
today is to make Bassem an Organizer, which also hands him every event's
registrations, speakers, invoices and settings. That is the cost being paid
now, and it is what `budgets.create` / `budgets.edit` as checkboxes fixes.

Two things checked and found NOT to be blockers: `/procurement` is deliberately
outside the middleware matcher (the page layout is the gate), so no base role's
path confinement blocks the module; and Fabian's case needs one sidebar line of
the same shape as the Webinars fix already shipped.

**Richard's view rule (owner, Sep 16 2026):** "does not need to view budgets"
means **no Budgets screen and no editing, but he still sees the line he is
spending against** and what remains on it, because the budget check is
meaningless to a requester who cannot see it. So `requests.create` implies
reading the target line, and `budgets.view` governs the Budgets list. Keep them
separate keys.

## 1. Decisions taken

| # | Decision | Recorded |
|---|---|---|
| D1 | A custom role is tagged on a **person**, not on a base role. One person can hold several. | Sep 15 |
| D2 | A custom role is **additive**: it adds procurement permissions on top of the base role and removes nothing. | Sep 15 |
| D3 | The approval amount lives on the **person**: the role says "can approve", the super admin types that person's AED limit when assigning it. | Sep 15 |
| D4 | Only the **super admin** creates, edits and assigns custom roles (the `hrAccess` reasoning: an admin kept out must not be able to tick their own box). | Sep 15 |
| D5 | Start with procurement; the same tables later carry CRM, HR and others. | Sep 15 |
| D6 | This work goes **before** the org-wide Phase 0 (§0: people are blocked or over-permissioned today). | Sep 16 |
| D7 | `requests.create` implies seeing the target budget line; `budgets.view` governs the Budgets list. | Sep 16 |
| D8 | The checkboxes live on a **named role**, not directly on the person. Define "PO Author" once, tag it on people. | Sep 16 |

Carried over from the grant discussion earlier the same day, **to confirm**
before building, since they were answered for the grant model:

- Only the super admin reaches Budgets by role; everyone else needs a custom role.
- Admins manage the product catalogue, templates and categories by role, and reach nothing else in the module without a custom role.
- Reopening a closed budget and unfreezing belong with budget authoring; cancelling orders and confirming receipts stay with the settle permission.
- No separate read-only role was wanted; that was before roles made one free to define.

Shipped separately, the same day (sidebar only, by owner decision): organizers
no longer see CRM or Budgets in the sidebar (Budgets reappears for an
organizer holding a procurement grant), and a webinars user with procurement
access sees Budgets beside Events.

## 2. Why procurement first is cheap

Every procurement route already asks one function for a named need
(`denyNonProcurement(session, { need })` in `src/procurement/lib/procurement-roles.ts`):
`view` (26 route files), `author` (7), `admin` (9, the catalogue writes plus
unfreeze and reopen), `request` (3), `approve` (2), `propose` (2), `settle` (1),
`decide-supplier` (1). The pages ask the same predicates in
`src/lib/procurement-visibility.ts`. Replacing what those predicates read is a
contained change. The org-wide version (`docs/CUSTOM_ROLES_PLAN.md`) is 15 to 21
weeks because about 386 other route files decide by role by hand.

## 3. The permissions (draft)

Each is a checkbox on a custom role.

| Area | Permission | Replaces today |
|---|---|---|
| Budgets | `budgets.view` | role read list (`canViewProcurement`) |
| | `budgets.create` | `canAuthorBudgets` on create |
| | `budgets.edit` (lines, submit, reallocate, new version, freeze, close) | `canAuthorBudgets` |
| | `budgets.discard` (discard a draft; budgets are never deleted) | `canAuthorBudgets` |
| | `budgets.reopen` (reopen a closed budget, unfreeze) | `canAdminProcurement` on transitions |
| | `budgets.signoff` | `procurementSettle` |
| Approvals | `approvals.decide` (budgets, reallocations, requests, up to the person's AED limit) | ceiling / unlimited columns |
| Requests | `requests.view` | `view` |
| | `requests.create` (raise, quote, submit, amend own) | `procurementRequest` |
| | `requests.manage` (edit or cancel someone else's) | `canAdminProcurement` actor flag |
| Orders | `orders.view` | `view` |
| | `orders.receive` (mark received on own request) | request grant |
| | `orders.cancel`, `orders.confirmReceipt`, `orders.send` | settle / admin |
| Suppliers | `suppliers.view`, `suppliers.propose`, `suppliers.decide`, `suppliers.edit` | request / settle / super admin / final approver |
| | `suppliers.financials.view` (tax number, bank details) | `canViewSupplierFinancials` |
| Catalogue | `catalogue.manage` (products, templates, categories) | `canAdminProcurement` on catalogue routes |

Module entry (sidebar, `/procurement` layout) = super admin, or any custom role
holding at least one procurement permission, or `catalogue.manage` by role if
the carried-over admin decision stands.

## 4. Rules that must survive combining roles

A person's permissions are the **union** of their roles, so these are checked
on the union, both when roles are assigned to a person and when a role is
edited (an edit can break the rule for everyone already holding it; the save is
refused and names them):

1. **The final approver never raises requests** (spec §8.8). Refuse
   `requests.create` on a person whose AED limit is unlimited.
2. **Settle never decides** (spec §4). Refuse `budgets.signoff` together with
   `approvals.decide`.
3. **No one decides their own request** stays enforced where it is today, in
   the approvals service, independent of roles.
4. `approvals.decide` with no AED limit on the person grants nothing; the
   assignment screen asks for the amount whenever an assigned role carries it.

## 5. Data model (additive)

Named generically so CRM and HR reuse it (D5). Keys are namespaced
(`procurement.budgets.create`); the catalogue of valid keys lives in code.

```prisma
model PermissionSet {            // a custom role, e.g. "PO Author"
  id             String   @id @default(cuid())
  organizationId String
  name           String
  description    String?
  version        Int      @default(1)   // bumped on every permission change
  archivedAt     DateTime?
  permissions    PermissionSetGrant[]
  holders        UserPermissionSet[]
  @@unique([organizationId, name])
}

model PermissionSetGrant {
  id              String @id @default(cuid())
  organizationId  String
  permissionSetId String
  permission      String                 // validated against the code catalogue
  @@unique([permissionSetId, permission])
}

model UserPermissionSet {
  id              String   @id @default(cuid())
  organizationId  String
  userId          String
  permissionSetId String
  assignedById    String?
  createdAt       DateTime @default(now())
  @@unique([userId, permissionSetId])
}
```

`User.procurementApproveCeilingAed` and `procurementApproveUnlimited` stay (D3).
`procurementRequest` and `procurementSettle` are migrated into two seeded roles
("Requester", "Settle") and then retired. All three tables carry
`organizationId`, a policy in `prisma/rls/`, harness assertions and
`check-tenant-als.sh` entries in the same change.

**At request time.** The session carries the person's procurement permission
keys (about 25 short strings, well inside the cookie) and a set-version stamp,
refreshed on the same 5-minute revalidation that carries `hrAccess` today. Money
decisions keep reading the user row at decision time, as the approval decision
and order cancel already do. The set read runs inside the person's own tenant
lane, borrowed from the user row, or under platform RLS every custom-role
holder would silently hold nothing.

## 6. Screens

- **Settings, Roles** (super admin): list of custom roles; create or edit one
  as a name, a description and grouped checkboxes (the table in §3); shows who
  holds it; archive instead of delete.
- **Settings, Users** (super admin): on a person, pick roles (multi-select) and,
  when any picked role carries `approvals.decide`, the AED limit or "final
  approver". Replaces today's four-switch grants dialog.
- Audit: role created, edited (before and after permissions), assigned,
  removed, limit changed. Shown on the Activity page.

## 7. Build order (about 1.5 to 2 weeks)

1. Catalogue in code, the three tables, migration, RLS package, seeded
   "Requester" and "Settle" from today's grants.
2. `procurement-visibility.ts` predicates read permissions; `denyNonProcurement`
   needs map to keys; the separation checks on the union. A parity test proves
   every existing grant holder keeps exactly today's access after the seed.
3. Session plumbing, sidebar, layout, MCP actor (today it passes only the role,
   so a role holder would get no MCP tools).
4. The two Settings screens, audit, user guide.
5. Retire `procurementRequest` / `procurementSettle` columns in a later deploy
   (expand, then contract).

## 8. Relation to the org-wide plan (SETTLED Sep 16, 2026)

Revision 1 of this plan and revision 2 of `docs/CUSTOM_ROLES_PLAN.md`
disagreed: that plan gave each user **one** role replacing the base role, this
one adds **several** on top. **The owner settled it on the additive shape**, and
the org-wide plan is now revision 3 to match (its D3, §3, §3.3, §3.5, §7.3).

Why the disagreement was narrower than it looked. The org-wide plan's only
argument for one role was §7.3: a user holding MEMBER and WEBINARS, asked *may
they write sessions* and *which events* as two separate questions and then OR'd,
ends up writing sessions on conferences, which neither role grants. That is a
recombination bug, not a second-role bug. With scope on the grant, the unit of
union is the whole `(permission, scope)` pair and the same user correctly gets
full control on webinars and desk on conferences.

**Procurement cannot hit it at all**, verified against the code on Sep 16:
`denyNonProcurement` takes `{ route, need }` with no event, every predicate in
`procurement-visibility.ts` takes only a user, and **no** procurement route
imports `buildEventAccessWhere`. The module has no scope dimension, so there are
no halves to mis-pair.

**Consequence for the tables.** §5's three tables are the org-wide plan's
`Role` / `RoleGrant` / `UserRoleAssignment` under their generic names, so build
them once, from that plan's §3.3, whichever module lands first.

**Current build order (owner, Sep 16 2026): Phase 0 of the org-wide plan
first** (it closes nine gaps that exist today regardless of roles, two of which
give a newly added role more access than intended). This plan resumes after
that, and only on the shared tables.

## 8a. Why the checkboxes live on a role, not on the person (D8)

Both shapes are "tick the capabilities you want". The choice is whether the
ticks are stored against a person or against a reusable named set.

Per person is cheaper (one join table, no new screen, about a week) and is how
today's four procurement switches already work. It was rejected because two of
the three people in §0 need an identical set today, so the pattern is already
repeating at a roster of twelve; because "these five are PO Authors" is not
expressible, which is what the owner asked for in the original direction; and
because a second tenant on the platform instance will define its own roles
regardless, so the layer gets built either way.

The catalogue in §3 is identical under both shapes, so none of that work is
contingent on this choice. The difference is one join table plus the role
editor screen, roughly three to four days.

## 9. Open questions

1. The carried-over decisions in §1 (super admin only by role; admins keep the
   catalogue; who reopens).
2. Does a custom role ever apply to API keys? Today procurement refuses keys
   entirely; recommended: keep refusing.
3. Seed a few starter roles ("PO Author", "PO Approver", "Finance settle",
   "Viewer") or start with none?
