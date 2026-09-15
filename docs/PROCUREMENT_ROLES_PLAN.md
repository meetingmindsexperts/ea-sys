# Custom roles for Budget & Procurement: PLANNED, NOT BUILT

**Status:** planning, Sep 15, 2026. Owner direction: "a custom role with custom
access for the procurement module, eventually for other roles too". Do not
start building without owner go-ahead.

The idea: the super admin creates named roles such as **PO Author** or **PO
Approver**, each a set of checkboxes (view budgets, create budgets, edit
budgets, and so on), and tags one or more of them onto a person. The person
keeps their base role (Organizer, Member, Webinars) for everything else.

## 1. Decisions taken

| # | Decision | Recorded |
|---|---|---|
| D1 | A custom role is tagged on a **person**, not on a base role. One person can hold several. | Sep 15 |
| D2 | A custom role is **additive**: it adds procurement permissions on top of the base role and removes nothing. | Sep 15 |
| D3 | The approval amount lives on the **person**: the role says "can approve", the super admin types that person's AED limit when assigning it. | Sep 15 |
| D4 | Only the **super admin** creates, edits and assigns custom roles (the `hrAccess` reasoning: an admin kept out must not be able to tick their own box). | Sep 15 |
| D5 | Start with procurement; the same tables later carry CRM, HR and others. | Sep 15 |

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

## 8. Relation to the org-wide plan

`docs/CUSTOM_ROLES_PLAN.md` gives each user **one** role that replaces the base
role. This plan adds **several** roles on top of the base role. They can
converge (the org-wide plan could adopt additive sets for modules), but they
should not both be built as written. Decide which shape the org-wide plan takes
before building step 1 here, so the tables are not built twice.

## 9. Open questions

1. The carried-over decisions in §1 (super admin only by role; admins keep the
   catalogue; who reopens).
2. Does a custom role ever apply to API keys? Today procurement refuses keys
   entirely; recommended: keep refusing.
3. Seed a few starter roles ("PO Author", "PO Approver", "Finance settle",
   "Viewer") or start with none?
