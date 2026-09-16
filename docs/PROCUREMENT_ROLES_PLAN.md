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
| Project managers (Zaid, Salah), **Member** | Create budgets, raise purchase requests | Can read the Budgets list, author nothing | **Same missing capability as Bassem.** `canAuthorBudgets` is role-only and excludes Member |

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

### The project managers, and the contradiction their role exposes (owner, Sep 16 2026)

Owner: "ALL Project Managers are by default MEMBERS but they create budgets and
purchase requests, because they should not access event financials and so on,
but they can register and what not."

Two of the three claims hold against the code. The third does not.

- **Project managers are Members.** True on prod: Zaid Ghanem and Mohammad
  Salah are the only two Member accounts.
- **They must create budgets and raise requests.** Not possible today.
  `BUDGET_AUTHOR_ROLES` is `{SUPER_ADMIN, ADMIN, ORGANIZER}`, so a Member reads
  the Budgets list and authors nothing. This is Bassem's gap seen from a third
  population, and it settles the design: `budgets.create` and `budgets.edit`
  must be grantable to a Member, which the checkbox model gives for free.
- **They do not reach event financials. FALSE.** `FINANCE_ROLES` in
  `src/lib/finance-visibility.ts` is
  `{SUPER_ADMIN, ADMIN, ORGANIZER, MEMBER, ONSITE, WEBINARS}`. Member has been
  finance-capable since the June 17 2026 "desk staff record payments"
  decision, so both project managers currently see amounts, prices, quotes,
  invoice totals and the Record Payment flow on every event. **The role was
  chosen for a property it no longer has.**

That last point is a different boundary from anything in this plan: procurement
permissions never read `canViewFinance`, so this build neither causes nor fixes
it, and reversing it would also remove Record Payment from the registration
desk, which is what the June 17 decision bought. Owner call, recorded in §9.


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
| D9 | **Switches now, build next.** The owner ticks the existing grants this week to unblock people; the roles build follows without anyone waiting on it. | Sep 16 |
| D10 | **No role grants budget access.** Only the super admin reaches Budgets by role; everyone else needs a permission. Confirms the first carried-over item; see §10a for the cost. | Sep 16 |
| D11 | Seed **four starter roles** per org, editable and archivable: PO Author, PO Approver, Requester, Finance Settle. | Sep 16 |
| D12 | `budgets.create` / `budgets.edit` must be grantable to a **Member**: every project manager is a Member and authors budgets. A third population confirming the checkbox model. | Sep 16 |
| D13 | **Member keeps event financial access.** Owner, Sep 16: "it's fine if member can access payments". The §0 finding stands as an accepted decision, not a defect: project managers see event money, and the desk keeps Record Payment. | Sep 16 |
| D14 | Seed **the four starter roles of D11 only**. No Project Manager role and no Budget Viewer; project managers hold **PO Author**, which therefore carries budget authoring as well as raising requests. | Sep 16 |
| D15 | **Reopening a closed budget and unfreezing sit with budget authoring** (`budgets.edit`), not with module admins. A budget author unblocks themselves. | Sep 16 |
| D16 | **The catalogue is permission-only** (`catalogue.manage`). No base role manages products, templates or categories; the super admin reaches them under D10, and the three admins need the permission assigned. | Sep 16 |

Carried over from the grant discussion earlier the same day. The first is now
**CONFIRMED** as D10; the rest are still **to confirm** before building:

- ~~Only the super admin reaches Budgets by role; everyone else needs a custom role.~~ **Confirmed Sep 16 (D10).**
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
| | `budgets.reopen` (reopen a closed budget, unfreeze) | `canAdminProcurement` on transitions. **D15: folded into budget authoring, granted with `budgets.edit`** |
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
| Catalogue | `catalogue.manage` (products, templates, categories) | `canAdminProcurement` on catalogue routes. **D16: permission-only, no base role below super admin** |

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

**Step 1 is BUILT (Sep 16, 2026), unpushed.** What landed:

| File | What it is |
|---|---|
| `src/lib/permissions/catalogue.ts` | The 20 permission keys, their labels and descriptions, and the four starter roles. Client-safe: no db, no Node imports, so the role editor and the sidebar can import it. |
| `src/lib/permissions/permission-set-service.ts` | Server-only. `ensureStarterPermissionSets` (seed-once, all-four-or-none in one `tenantTransaction`) and `readUserPermissions` (the union across a person's roles). |
| `prisma/schema.prisma` | `PermissionSet`, `PermissionSetGrant`, `UserPermissionSet`, plus the back-relations on `Organization` and `User`. |
| `prisma/migrations/20260916120000_add_permission_sets/` | Additive and idempotent; applied to the local prod copy and re-applied to prove it. |
| `prisma/rls/permissionset.sql` | Flat policy on all three tables, born with them. |
| `tests/tenancy/permissionset-rls.test.ts` | 9 assertions. **Written, not yet run** (the harness needs docker). |
| `scripts/check-tenant-als.sh` | The three models added to `SWEPT_MODELS`, arming the guard before any route exists. |
| `__tests__/lib/permission-catalogue.test.ts` + `permission-set-service.test.ts` | 19 tests: catalogue drift both ways, the two separation rules on the seeded sets, seed-once incl. the archived case, and the union read. |

Decisions taken while building, both recorded in the code: **no `budgets.reopen` key**
(D15 folds it into `budgets.edit`, and a key always ticked beside another is one
nobody can use differently), and **`readUserPermissions` drops keys this build no
longer enforces**, so a row outliving its capability cannot satisfy a later check
that reuses the name.

**Step 2 is BUILT (Sep 16, 2026), unpushed.** The predicates read
`permission OR today's rule`, so **nobody's access changes**; dropping the
legacy arm is the separate flip §10a says must follow assignment.

| File | What changed |
|---|---|
| `src/lib/procurement-visibility.ts` | `ProcurementUserLike` gains optional `procurementPermissions`; every predicate gains a permission arm; `procurementGrantsFromRow` flattens the nested rows, so the ONE shared mapper serves both decision-time callers. |
| `src/procurement/lib/procurement-roles.ts` | `allowed()` maps each need to its own key: `admin` to `catalogue.manage` (D16), `propose` to `suppliers.propose`, `approve` to `approvals.decide` **plus** a ceiling. |
| `src/procurement/lib/route-helpers.ts` | `procurementGuard` resolves permissions **before** the need check. Step 2 read them from the database per request; step 3 moved that to the session, so the guard now costs nothing extra. |
| `src/lib/approvals/approvals-service.ts`, `src/procurement/services/commitment-service.ts` | Both decision-time row reads load permissions, so archiving a role bites at once rather than after five minutes. |

**THE TRAP, and it shipped green once before it was caught.** The first cut
resolved permissions *after* `denyNonProcurement`. Everything compiled, every
existing test passed, and the feature was **entirely unreachable**: the need
check saw `undefined`, fell through to the legacy arm, and refused the very
MEMBER the custom role was about to admit. Nothing in the suite could see it,
because every existing test exercises the legacy arm. Order is load-bearing:
**resolve the permission before anything asks the question.** A route-level test
now pins it.

Two more decisions recorded in the code: `canApproveProcurement` has **no**
permission arm (the key says whether, the AED ceiling on the person says how
much, D3 — an arm here would read as unlimited authority), and
`canAdminProcurement` means **"act on someone else's request"** only, since
that is all its eight call sites want; the catalogue and reopen went to their
own keys.

**Known gap: MCP.** `ProcurementMcpActor` carries a role string and no user id,
so `readUserPermissions` has nothing to key on and a custom-role holder gets no
procurement tools through the agent. Invisible today because grants are equally
role-invisible there; it becomes a real gap once roles are assigned.

**Step 3 is BUILT (Sep 16, 2026), unpushed.** The keys ride the JWT and refresh
on the same five-minute cycle as the role and the grants, so the per-request
database read step 2 introduced is gone.

| File | What changed |
|---|---|
| `src/lib/auth.ts` | `permissionsForToken` reads the person's keys after each user row and stamps the token, at sign-in, on an explicit session update, and on the five-minute re-validation. |
| `src/lib/auth.config.ts` | ONE line in the shared `mapTokenToSessionUser`, so the Node and Edge instances cannot disagree (the Aug 17 session-lifetime incident was exactly that shape). |
| `src/types/next-auth.d.ts` | Declared on `Session.user`, `User` and `JWT`. |
| `src/procurement/lib/route-helpers.ts` | Reads `session.user.procurementPermissions` instead of querying. |

**A SECOND READ, not a nested include.** `User` is read to ESTABLISH identity,
so it cannot be protected by identity and carries no policy; `UserPermissionSet`
does. Nesting the relation into the auth query would return zero rows under RLS
and read as "holds no custom role" — access silently withheld, nothing logged.
The lane is borrowed from the row just read, and a failure never blocks sign-in.

**Five minutes of staleness is accepted HERE and nowhere that moves money.**
`approvals-service` and `commitment-service` each re-read the row at decision
time, so archiving a role stops an approval or an order cancel at once.

Remaining steps:

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

## 10a. What D10 costs, and the question it reopens

`PROCUREMENT_READ_ROLES` is today `{SUPER_ADMIN, ADMIN, ORGANIZER, MEMBER}`.
Measured on prod, Sep 16: **13 org staff, of whom 9 can read budgets by role**
(1 super admin, 3 admins, 3 organizers, 2 members). Under D10 that becomes **1**,
and the other 8 see the module's refusal card until someone grants them a
permission. This is a visible change on a LIVE module, so it needs a migration
step of its own, not just a predicate edit:

1. Seed the four starter roles (D11).
2. Decide who among the 8 keeps reading, and assign before the predicate flips.
3. Flip `canViewProcurement`, and only then retire the role list.

Ordering it the other way makes the module go dark for most of the staff between
two deploys.

**The question D10 reopens.** The carried-over note says "no separate read-only
role was wanted", but that was answered when org staff read budgets for free. Once
no role grants access, a person who should only LOOK at budgets has no way to be
expressed except a role whose single tick is `budgets.view`. So either a fifth
starter role ("Budget Viewer") joins D11, or the 8 people above are each given one
of the four existing roles, which grants them more than looking. Owner call, and
it belongs with the §9 questions.

## 9. Questions, all resolved Sep 16 2026

| # | Question | Answer |
|---|---|---|
| Q1 | Do admins keep the catalogue by role? | **No.** Permission-only (D16). |
| Q2 | Who reopens and unfreezes? | **Budget authoring** (D15). |
| Q3 | A fifth "Budget Viewer" starter role? | **No** (D14). |
| Q4 | A "Project Manager" starter role? | **No**; PMs hold PO Author (D14). |
| Q5 | Does Member stop seeing event financials? | **No**, accepted as designed (D13). |
| Q6 | Do custom roles ever apply to API keys? | **No.** Procurement refuses keys by construction and keeps refusing. |

**Consequences carried into the build.**

- **PO Author is the project-manager role** (D14), so its ticks are
  `budgets.view`, `budgets.create`, `budgets.edit`, `budgets.discard`,
  `requests.view`, `requests.create`, `orders.view`, `orders.receive`,
  `suppliers.view`, `suppliers.propose`. Reopen and unfreeze ride on
  `budgets.edit` per D15.
- **§10a's migration step still applies.** D10 plus D14 means the 8 staff who
  read budgets by role today keep it only if assigned a role before the
  predicate flips, and no seeded role is look-only. Assign first, flip second.
- **D16 needs an assignment before the flip too**, or the three admins lose the
  product catalogue, 203 rows they use today.
