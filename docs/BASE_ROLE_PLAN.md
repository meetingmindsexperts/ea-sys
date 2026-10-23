# The "Base role": a role that starts with nothing

**Status:** BUILT, Oct 23, 2026: steps 1 to 6, D4 and D5 included. §10 records what was built and verified.

> **Naming (owner, Oct 23):** on screen the role is **"Base role"**, described as
> *"No default permissions: attach a custom role."* In code the enum value and
> system-role key are `BASE`. Earlier drafts of this plan called it
> "Base role" / `BASE`; read those as `BASE`.
**First user:** a marketing colleague who exports registrations and contacts, and nothing else.
**Related:** [CUSTOM_ROLES_PLAN.md](CUSTOM_ROLES_PLAN.md) §3.3 and D15, [ROLES_AND_PERMISSIONS.md](ROLES_AND_PERMISSIONS.md).

---

## 1. The problem

Custom roles only ADD permissions on top of a person's base role. Every base
role we have is too big for "export only":

| Base role | Holds on its own | Why it does not fit |
|---|---|---|
| Member | 32 permissions | sees money, records payments, edits registrations, checks people in, reads invoices |
| Onsite | 25 | desk work, assignment-gated per event |
| CRM User | 8 | the whole CRM, including deal values |
| HR User | 2 | HR only, and cannot be extended into events |

The owner's ruling D15 (Sep 30, 2026) already answers what is needed: a
**system role with an empty permission set**, so that everything the person
can do comes from the custom roles they hold. D15 deliberately left HOW that
base is stored to the first phase that needs it. This is that phase.

## 2. What the person ends up with

A **"Marketing" custom role** on top of the new empty base:

| Permission | Gives |
|---|---|
| `events.read` | the Events list and each event's Registrations page |
| `registrations.read` | the registrations list and detail (read only) |
| `registrations.export` | the Export CSV and Sales CSV buttons |
| `contacts.read` | the Contacts page |
| `contacts.export` | the Contacts export, with its column picker |

What they see: **Events** and **Contacts** in the sidebar, Registrations inside
each event. Login lands on Events. No Dashboard, Settings, Invoices,
Analytics, CRM, Budgets, HR or AI Agent.

What the exports contain, checked against the code:

- **Registrations CSV:** 34 columns. Money is blanked automatically because the
  person lacks `finance.view` (Payer, Sponsor, Registration Fee, Amount Due,
  Total Paid, Discount); barcodes are blanked without `barcode.view`. Still
  included: names, email, organisation, job title, specialty, country,
  registration type, status, payment status, pricing tier, promo code, and the
  UTM campaign columns (useful for marketing).
- **Contacts CSV:** the column picker opens with first name, last name, email,
  organisation, job title, specialty, city, country ticked. Phone, bio, notes and
  ID numbers are opt-in, but anyone with `contacts.export` can tick them (see D4).

## 3. Decisions for the owner

| # | Question | Recommendation |
|---|---|---|
| **D1** | How to store the empty base: a new `UserRole` value, or a nullable `User.baseRoleKey` beside `role`? | **Ruled (owner, Oct 23): a new value, `BASE`.** |
| **D2** | Name on screen | **Ruled: "Base role", with the description "No default permissions: attach a custom role."** |
| **D3** | May a Base role person be ticked for HR access? | **Ruled: no.** |
| **D4** | Split Notes, Phone, Member ID and Student ID out of `contacts.export` into `contacts.export.sensitive`? | **Ruled: yes.** Admins and organisers hold both, so nothing changes for them. |
| **D5** | Contacts export rate limit (10 per hour per organisation) and the 25,000-row cap, with about 60,000 contacts in the store. | **Ruled (owner, Oct 23): keep a limit, per person.** It guards the server (each export builds up to 25,000 rows in memory beside the door scanner), not the data; the permission and the audit row protect the data. 10 per hour per person; the org's API keys share one budget. The 25,000-row cap stays the same for every role; the contacts filters give complete files in parts. |
| **D6** | Who may invite and assign it? | **Ruled: admins may invite**; only the super admin assigns custom roles, as today. The option only appears while custom roles are switched on. |

**Why a new value rather than `baseRoleKey` (D1).** With `baseRoleKey` the
person's `role` still has to hold SOME enum value, in practice MEMBER. About
120 files read the role string. Every one of them would see a Member:

- the header badge, Settings, the help chat's guidance;
- any future role-string check.

Worse, a rollback to a build that predates the column ignores it, so the person
**silently gets full Member access back**. That fails open, on access control.

A new value is explicit everywhere. Code that does not know it fails closed:

- no permissions;
- no events;
- no custom roles assignable.

Its cost is three lists (`TEAM_ROLES`, `ASSIGNABLE_USER_ROLES` and the compile
guard), which the build itself forces us to update. Its rollback hazard
(§8) is a loud error, not silent access. This still honours D15: the value is
backed by a system role with an empty grant set.

## 4. The build

Each step lists the files. Line numbers are from main on Oct 23, 2026.

### Step 1: the role value
- `prisma/models/core.prisma`: add `BASE` at the end of `UserRole`, with a comment block like CRM_USER's.
- New migration `prisma/migrations/20261023120000_add_base_role/migration.sql`: the single statement `ALTER TYPE "UserRole" ADD VALUE IF NOT EXISTS 'BASE';`. It has to be alone in its file, because Postgres will not use a new enum value in the transaction that adds it. It is additive and safe for blue/green.

### Step 2: the system role
- `src/lib/permissions/system-roles.ts`: add `BASE` to `SystemRoleKey` and `SYSTEM_ROLES`:
  - `grants: []`, `impliedPersonGrants: []`, `areas: []`;
  - `extendableAreas: [events@ALL, desk@ALL, org]`.
- `ensureSystemPermissionSets` seeds its `PermissionSet` row (key `base`) on its own, so no data migration.
- **Note:** `events.read`, `registrations.read` and `registrations.export` are DESK keys (`key-areas.ts` `DESK_KEYS`). So the Marketing role adds the `desk` area, not `events`. `contacts.*` opens the single page `org:/contacts`.

### Step 3: role lists, labels, invites
- `src/lib/team-roles.ts`:
  - add the value to `TEAM_ROLES`. Without it, custom roles cannot be assigned (`permission-sets/route.ts:40`), the person is missing from Settings → Users, and their session's areas only refresh at sign-in.
  - extend `isRoleGrantableHere` so `BASE` is grantable only when `isCustomRolesEnabled()`, at both call sites (`users/route.ts:43`, `users/[userId]/route.ts:181`).
  - **Not** in `NOTIFIED_ROLES` or `RETIRED_ROLES`.
- `src/lib/auth-guards.ts`: add the value to `ASSIGNABLE_USER_ROLES` (the compile guard enforces it). Both user routes' zod enums follow automatically.
- Labels:
  - `ROLE_LABELS` (`users/route.ts:21-30`);
  - `roleColors` (`settings/page.tsx:577`);
  - the invite dropdown `SelectItem`, gated on `customRolesEnabled` like HR User is gated on `hrEnabled` (`settings/page.tsx:1088-1099`);
  - `ROLE_META` in `header.tsx` (today an unknown role falls back to the Organizer badge and capability list).
- Help chat:
  - a `ROLE_GUIDANCE` entry ("starts with no access; everything comes from the custom roles listed below", `system-prompt.ts`);
  - `STARTERS_BY_ROLE` entries: "How do I export registrations?" and "How do I export contacts?".

### Step 4: middleware (a real blocker today)
- `src/lib/route-confinement.ts:129` drops the areas a custom role adds when the base role has none:

  ```ts
  base.length > 0 ? [...] : base
  ```

  So the Marketing person could open `/events` and `/contacts`, but never an event's Registrations page. **Change:** keep `extra` when `base` is empty, and leave the person-grant areas (HR, Budgets) out for an empty base.
- **Home:** for an empty base, compute home from the effective areas: `/events` when desk or events is held, `/contacts` when the only extras are organisation pages.
  - Today a contacts-only person would land on an empty Events list.
  - The second rule also removes a redirect loop: effective areas that are non-empty, without events or desk, but with home `/events`.
- Tests: extend `route-confinement.test.ts` and its snapshot with the new role, plain and with each area combination, including the loop case.

### Step 5: sidebar and page gaps
- `sidebar-nav.ts`: the desk pair (Registrations, Check-In) is not filtered by permission, so Check-In would show without `registrations.checkin` and every action there would 403. **Filter each item by its key.**
- Three requests return 403 for this person, which means console errors and no crash. Gate each on its permission:
  - `registration-detail-sheet.tsx:240`: `useBillingAccounts` runs unconditionally; gate it on `billingAccounts.read`.
  - `registration-detail-sheet.tsx:486`: the event surveys fetch; gate it on `surveys.read`.
  - The contact detail sheet's email-log card calls `/api/email-logs`; gate it on `emailLogs.org.read`. Members hit this 403 today too.

### Step 6: the export decisions (if D4 and D5 are accepted)
- D4:
  - add `contacts.export.sensitive` to the catalogue (Contacts group, admin and organiser system grants);
  - `contact-export.ts` marks Notes, Phone, Member ID and Student ID as sensitive;
  - the export route refuses those columns without the key (403 with the column names, logged);
  - the dialog hides them.
- D5: change the contacts export rate-limit key to `contacts-export:${org}:${userId}`.

### Step 7: the Marketing role itself (data, not code)
After deploy, the super admin creates it in Settings → Roles. It needs the five
permissions in §2, all at ALL scope where scoped. Then they invite the person
as Base role and assign Marketing. The plan does not seed this role:
roles are per organisation and named by the organisation.

## 5. Tests

- **Enumerations that will fail until updated:**
  - `roles-and-permissions-doc.test.ts` (needs the doc rows in §6);
  - `help-chat-system-prompt.test.ts`;
  - `no-inline-role-lists.test.ts` and `scripts/check-permission-guards.sh` `STAFF=` (add the value so new literal comparisons are caught);
  - `event-access.test.ts`;
  - `__tests__/helpers/role-can.ts`.
- **Snapshots to regenerate and read line by line:**
  - `system-role-grants-snapshot` (new empty entry);
  - `sidebar-nav`, `route-confinement`, `event-page-keys`;
  - the 23 route-matrix snapshots, after adding two callers to `route-matrix/harness.ts`: "BASE" (expect 403 everywhere a key is needed) and "BASE + Marketing" (expect 200 only on the five keys' routes).
  - **The review rule:** every changed line in an existing role's column is a regression.
- **New tests:**
  - grantable only with custom roles on, modelled on the HR test;
  - extraAreas and confinement for an empty base with desk, with org pages only, and with both, modelled on `crm-user-event-roles.test.ts`;
  - a custom role on a Base role person cannot carry keys outside events, desk and org (`grantsOutsideAreas`);
  - registrations export as Base role + Marketing has blank money and barcode columns;
  - contacts export refuses sensitive columns without the key (D4).

## 6. Docs

- **`docs/ROLES_AND_PERMISSIONS.md`:**
  - §1 row;
  - §3 event scope;
  - §4 `TEAM_ROLES` / `ASSIGNABLE_USER_ROLES` rows;
  - §6 invite rules (custom roles flag);
  - §8 middleware;
  - §9 gaps closed.
- **`CLAUDE.md`:** a BASE bullet in the RBAC roles list, with the migration name.
- **`docs/CUSTOM_ROLES_PLAN.md`:** record against D15 and §3.3 that the empty base is stored as the `BASE` value, and why (§3 above).
- **`public/user-guide.html`:**
  - the roles count and table;
  - a short "Setting up a marketing colleague" how-to in the custom roles chapter, so the help chat can answer it;
  - which columns the exports leave blank.

## 7. Verification (before any push)

- **Gates:** every gate in `deploy.yml` (lint, types, unit, the permission guard, migration safety). Apply the migration to the local copy with `npm run db:migrate`, then re-run it to confirm it's idempotent.
- **Headed browser checks, as a local Base role + Marketing user:**
  - login lands on Events;
  - the sidebar shows Events and Contacts only;
  - each event opens on Registrations, and every other event page redirects there;
  - Export CSV downloads with the money and barcode columns empty;
  - the Contacts export offers only basic columns (D4);
  - zero console errors on every page they can reach;
  - Settings, Dashboard, Invoices and `/events/new` redirect away.
- **Unchanged-behaviour checks** for a plain Member, an Organizer and an Admin on the same pages.
- **Plain Base role with no custom role:** lands on an empty Events page with nothing to do. This is expected; the invite dialog says so.

## 8. Deploy and rollback

- **One deploy.** `prisma migrate deploy` runs before the new slot starts (`deploy.yml`, `scripts/deploy.sh`). Vercel does not migrate (its build is `prisma generate && next build`).
- **Do not assign the role until the EC2 deploy is green.** An invite on a Vercel preview before the EC2 migration fails with an invalid-enum error, which is harmless but confusing.
- **Rollback hazard:** once anyone holds `BASE`, rolling back to a build whose Prisma client lacks the value makes reads of that user throw.
  - Before rolling back past this release, move the person to another role.
  - Record this in `docs/ROLLBACK.md`.
- **Never delete the value.** Removing an enum value is not blue/green safe. Retire it through `RETIRED_ROLES`, as with WEBINARS.

## 9. Effort and risk

- **Effort:** about one working day:
  - Steps 1 to 5, about half a day;
  - the D4/D5 export changes, about two hours;
  - tests, snapshot review and docs, the rest.
- **Risk:** this is access control on the live system. The changes are additive, and the new role starts with nothing, so the failure mode is "the marketing person cannot reach a page" rather than "someone sees too much". The one fix that changes behaviour for existing users is the middleware change in Step 4. It only takes effect for a role with an empty base, and the confinement snapshot pins that.
- **Push:** confirmed with the owner as an access-control change.

## 10. What was built (Oct 23, 2026)

- **Steps 1 to 5 as planned:**
  - the `BASE` value and migration;
  - the empty system role;
  - the role lists, the grantable rule, labels and help chat;
  - the confinement fix (`emptyBaseRedirect`);
  - the desk pair filtered by key (asked without the event, so ONSITE keeps both items);
  - the three 403s gated (billing accounts, event surveys, a contact's email history).
- **Also fixed on the way:** the Add User dialog had no description (a console warning on Settings).
- **D4 built (step 6):**
  - the new key `contacts.export.sensitive` ("Export private contact details") covers phone, notes, member ID, student ID and student ID expiry (`SENSITIVE_EXPORT_COLUMNS`). Bio stays an ordinary column.
  - Every built-in role that holds `contacts.export` holds it too: super admin, admin, organiser, member and the full API key. A test pins this, so **no existing role loses a column**; only a custom role without the key is narrowed.
  - The route refuses an explicit request for those columns with a logged 403 naming them, before the rate limit. A request with no column list leaves them out.
  - The dialog hides them.
- **D5 built:** the contacts export limit is 10 per hour per person (it was 10 per organisation, shared); the row cap is unchanged.
- **Tests:**
  - `__tests__/permissions/base-role.test.ts` (16): the role, grantable rule, area rule, pages, no-loop, sidebar, token;
  - `__tests__/api/base-role-registration-export.test.ts` (3): the export blanks money and barcodes, and the blanks follow the keys;
  - two callers added to the route matrix (`BASE`, `BASE_MKT`). The 21 snapshot files gained 1,106 lines and lost none, so **no existing role changed on any route**.
  - Base + Marketing answers only on: contacts list, tags and export; the events list and event detail; the registrations list, both CSVs and tags.
- **Verified in a visible browser** on a standalone build (port 3199; the shared dev server on 3113 belongs to another session and holds the old Prisma client):
  - the super admin invited "Base role" (hint shown, row badge "Base role") and attached Marketing;
  - the person landed on Events, with a sidebar of Events and Contacts, and inside an event Registrations only;
  - other event pages redirect to Registrations; Dashboard, Settings, Invoices and New Event redirect to Events;
  - the export downloaded 12 rows with emails, and Total Paid and DTCM blank;
  - Contacts opened with Export and no delete;
  - no failed API call.

### Review fixes (Oct 23, 2026)

An independent review found no HIGH. The fixes applied:

- **MED 1, recorded as intended:** the new key narrows any EXISTING custom role or role-bound API key that exports contacts. Production was checked read-only that day: no custom role and no API key held `contacts.export`, so nothing changed for anyone. Roles made later show the key as its own checkbox.
- **MED 2, fixed (owner option a):** the phone column of the **registrations** CSV is blanked without the key too.
  - Onsite and Webinars (who export registrations) now hold the key, so their file is unchanged.
  - The parity test covers both exports.
  - The key narrows files, not screens: the on-screen lists and detail sheets are unchanged.
- **MED 3, fixed:**
  - the user edit route refuses turning on HR access or a Budgets grant for someone who is, or is becoming, Base role (logged 400); turning one off still works;
  - Settings hides both buttons on Base role rows.
- **LOWs, fixed:**
  - **Header:** the panel shows one row ("What your custom roles add").
  - **Check-In:** the page now needs `registrations.checkin`, so it is not reachable by URL with read only. Every built-in role that reads registrations also checks in, so the event-page snapshot is unchanged.
  - **EventAccessGate:** passes through only the outside identities, so a Base role person with no area is judged like other staff.
  - **Snapshots:** Base role added to the confinement and sidebar matrices; additions only.
  - **New tests:**
    - a contacts-only person opening an event page;
    - a key bound to a role without the key, on the contacts export;
    - module ticks refused for the Base role;
    - a change to Base clears custom roles.
  - **Settings badge:** uses a helper (`isBaseRole`).
