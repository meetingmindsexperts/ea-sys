# CRM module

> The file to read before you touch anything under `src/crm/`.

This is EA-SYS's sponsorship/exhibitor **sales CRM**: companies (accounts), a deals
pipeline, the people we negotiate with, follow-up tasks, and notes. It is a
**bounded module inside the main app** — its own namespace end to end, but not a
separate deployable.

**Read these in order the first time:**

| Doc | What it is |
|---|---|
| this file | code layout, conventions, the invariants specific to this module |
| [`docs/CRM_STATUS.html`](../../docs/CRM_STATUS.html) | **live status** — what's done, pending, and *actually wired* vs not. Keep it current. |
| [`docs/CRM_MODULE_PLAN.md`](../../docs/CRM_MODULE_PLAN.md) | the blueprint + the locked owner decisions (§9) |
| [`/AGENTS.md`](../../AGENTS.md) | the app-wide invariants this module also obeys |
| [`src/services/README.md`](../services/README.md) | service-layer conventions (CRM services follow them) |

---

## 1. What it is for (scope)

**Primary use case (locked, plan §9): a sponsor/exhibitor sales pipeline joined to
event data.** The thing no off-the-shelf CRM can do against our data is the join —
*"Abbott → BRIDGES 2026 → Gold → $40k → Negotiation"*. That join is the module's
entire reason to exist, so `CrmDeal.eventId` is a first-class link and `CrmCompany`
(the account) is the centre of gravity, not the person.

**In scope (v1):**

- **Companies** — first-class accounts (today `Contact.organization` is a string).
- **Deals** — a kanban pipeline: stages, value, owner, expected close, win/loss,
  tied to an event. **The event link is REQUIRED** (owner decision) — `createDeal`
  returns `EVENT_REQUIRED` without one and `updateDeal` refuses to clear it; the DB
  column stays nullable so a deal survives its event being deleted (`onDelete: SetNull`),
  so the requirement is enforced at create/edit, not as a NOT-NULL constraint.
- **Email** — outbound sends to an event's sponsors (the *Email sponsors* button on the
  board) or to one deal's contacts (the *Email* button on a deal), with per-contact
  personalization + attachments + built-in templates. See §3.7.
- **CRM contacts** — the people we *negotiate with* (reps, exhibitor sales,
  procurement). See §3 — these are **not** the event contact store.
- **Tasks** — follow-ups with email reminders.
- **Notes** — the manual "we actually phoned them" activity log.
- **Filters** — sales rep, date range, value (finance-gated), lifecycle, industry.
- **Reports & export** — pipeline-by-stage, win/loss + win rate, per-rep leaderboard, and CSV export of the filtered deal list (values finance-gated).

**Out of scope (v1) — do not build these without a fresh decision:**

- Two-way email inbox sync (Gmail/Outlook). *Integrate a real Freshsales/HubSpot via
  n8n if it's ever needed — replicating inbox sync is months of work.*
- Lead scoring / workflow automation.
- Hard delete as an ordinary action (a deal is revenue history — close it LOST; a company
  is merged, not deleted). **The one exception**: a SUPER_ADMIN may permanently delete an
  *archived* deal / company / contact — see §3.6.
- Multi-currency pipeline rollups (currency is stored per deal; report per-currency).

The stabilization-first concern that parked this module has **not** gone away: if a
real conference lands mid-work, the conference wins. The CRM schema is additive and
unreferenced by any live path, so pausing costs nothing.

---

## 2. Layout

```
src/crm/
  services/         domain logic — one file per aggregate, errors-as-values
    company-service.ts        find-or-create accounts (dedup)
    pipeline-service.ts       seed + edit the org's stage list (DEFAULT_PIPELINE_STAGES)
    deal-service.ts           THE important one — create/update, stage moves, close, deal↔contacts
    crm-contact-service.ts    business contacts + link-to-event-contact
    task-service.ts           tasks + the reminder stamp
    note-service.ts           author-only notes
    sponsor-email-service.ts  outbound email — an event's sponsors OR one deal's contacts (reuses core sendEmail)
    crm-email-template-service.ts  editable per-org email templates (seed-once + CRUD; audits to core AuditLog)
    crm-product-service.ts    product/service catalog (seed-once + CRUD) + deal line items (add/edit/remove)
    crm-import-service.ts     Freshsales CSV import (companies/contacts/deals; dry-run-first, externalId upserts)
  lib/
    crm-roles.ts        PURE role predicates (canViewCrm / canOwnDeals / canViewDealValues / canDeleteCrm)
    crm-visibility.ts   SERVER-ONLY HTTP guards (denyCrmAccess / denyCrmWrite / denyCrmDelete)
    crm-route.ts        shared route boundary: auth + redaction + error→HTTP + write rate limit
    crm-types.ts        client-safe types + display constants (labels, colours, activity-action labels)
    crm-activity.ts     SERVER-ONLY: recordCrmActivity (the ONE change-log writer) + diffFields
    crm-notifications.ts SERVER-ONLY: notifyCrmUser (the ONE notification writer) + feed reads/mark-read
    deal-filters.ts     pure filter → Prisma-where parsing (the finance gate lives here)
    reports.ts          pure report math (pipeline/win-loss/leaderboard; redacted values stay null, never 0)
    sponsor-recipients.ts  PURE email-recipient resolution (dedup + narrow-never-widen intersection)
    crm-email-templates.ts client-safe built-in email templates (pre-fill only)
    pipeline-reconcile.ts  PURE planner: bring an org's stages to the canonical seed
    freshsales-import.ts   PURE import layer: header synonyms, row mappers, the re-import conflict rule
    use-crm-filters.ts  URL-backed filter state hook
  hooks/
    use-crm-api.ts      all React Query hooks (queries + mutations)
  components/           deal-board, *-detail-body (the record pages' content), create/edit/email dialogs,
                        record-layout.tsx (RecordHeader/RecordGrid/RecordCard/Facts — the shared record-page shell),
                        crm-activity-timeline, crm-load-error, event/company comboboxes, filters/
  agent-tools.ts        the CRM's MCP tool registrations (imported ONLY by the exempted register-mcp-tools.ts)
  reminders-worker.ts   the CRM task-reminder tick (runTick)

src/app/api/crm/*                REST surface — deals/companies/contacts/tasks/notes/pipeline-stages
                                 + activity, reps, events-lite, reports, sponsor-email/{recipients,send}
src/app/(dashboard)/crm/*        tabbed shell + list pages + RECORD PAGES /{deals,companies,contacts}/[id]
scripts/reconcile-crm-pipeline.ts  one-off: bring an org's pipeline to the current stage list
worker/jobs/crm-reminders.ts     the cron shim that calls reminders-worker
prisma/schema.prisma             the Crm* models
__tests__/crm/*                  tests
```

**Data model (12 models):** `CrmCompany`, `CrmPipelineStage`, `CrmDeal`, `CrmContact`,
`CrmDealContact` (join, with a per-deal role), `CrmTask`, `CrmNote`, `CrmActivity`
(the change log — §3.6), `CrmNotification` (the in-app bell feed — §3.8),
`CrmEmailTemplate` (editable per-org email templates — §3.7),
`CrmProduct` (the product/service catalog) and `CrmDealProduct` (a deal line item —
snapshots name/category/sku at add-time; `unitPrice` set on the deal, pre-filled from
the catalog price; the deal Value stays MANUAL). `archivedAt` carries soft-delete on
company/deal/contact/task + email templates + products.
Plus enums for deal/task status, lifecycle, deal-contact role, and the activity entity.
See the `// CRM MODULE` block in `prisma/schema.prisma` — every model is heavily
commented with *why* its FK policies are what they are.

**Detail surfaces are PAGES, not sheets.** Deal, account and contact each have a
dedicated record page (`/crm/{deals,companies,contacts}/[id]`) built from a `*-detail-body`
component on the shared two-column `record-layout` shell; clicking a board card / list
row navigates there. The old slide-out sheets are gone — no CRM detail sheet remains.

---

## 3. The load-bearing things

If you internalize nothing else, internalize these. Each exists because getting it
wrong causes a real bug, and several were caught the hard way during the build.

### 3.1 The import boundary is one-way, and enforced

`src/crm/` may import core (`@/lib/db`, `auth-guards`, `email`, `logger`,
`finance-visibility`, …). **Core must never import `src/crm/`.** This is enforced by
an ESLint `no-restricted-imports` rule in `eslint.config.mjs`, not by discipline —
"we'll remember" is exactly how the webinar module's namespace started leaking.

The permitted core-side touch points are listed BY NAME in the ESLint config's
exemption list — that list is the source of truth, count them there (it has grown
past the original three: the sidebar entry, the MCP registration line, the worker
job shim, plus the MCP builder entries reserved for the future tools). Adding one
is a deliberate act — you edit that exemption list, and you should have a reason.
(One was added and then reverted during the CrmContact rework; that's the bar.)

### 3.2 CRM contacts are a DIFFERENT population from event contacts

`Contact` = the **event** contact store: HCPs (doctors, nurses, allied health).
`CrmContact` = the **business** people we negotiate with (reps, procurement).

They are separate tables **on purpose**. Every `Contact` row is mirrored to the
external `contacts_centralv1` marketing table by `contacts-central-sync`, which
selects with **no where-clause**, and that feeds `mailchimp_*`. A pharma rep in
`Contact` would be marketed to as if they were a doctor. Separate tables make that
leak **structurally impossible**, not merely "prevented by remembering to filter".

The person who is genuinely **both** (a rep who also attends the conference) is
*linked* via `CrmContact.contactId` — one human, one record, two hats. A pointer,
never a copy. Same shape as `Speaker.sourceRegistrationId`.

**Never write a business contact into `Contact`, and never inline CRM fields into the
event contact surfaces.**

### 3.3 Visibility is the CRM's own boundary — not a reused predicate

The CRM needs "staff + MEMBER-can-read-but-not-write-and-not-see-money, never
ONSITE/REVIEWER/SUBMITTER/REGISTRANT". No existing predicate has that shape
(`canViewContacts` includes MEMBER but nothing about money or ownership;
`FINANCE_ROLES` includes ONSITE; `denyReviewer` blocks MEMBER who we *want* reading
the board). So the CRM has its own, in `crm-roles.ts`:

| predicate | who | used for |
|---|---|---|
| `canViewCrm` | staff + MEMBER (+ API keys) | reading the board at all |
| `canOwnDeals` | staff only (MEMBER excluded) | owning deals, any write |
| `canViewDealValues` | staff only | seeing / filtering by money |

**Roles that reach the CRM:** SUPER_ADMIN / ADMIN / ORGANIZER (full, via the event platform), **MEMBER** (read-only, no money), and **`CRM_USER`** — a dedicated sales-team role CONFINED to the CRM (full pipeline + sees deal values, but blocked from events/registrations/invoices/settings via the proxy redirect, a zero-event `buildEventAccessWhere` branch, `denyReviewer`, and the sidebar). CRM_USER is NOT in `FINANCE_ROLES` (CRM deal money ≠ event finance). It uses `/api/crm/events-lite` for the name-only event picker since it has no event-API access.

`CrmDeal.dealValue` is in `FINANCIAL_KEYS`, so the existing `redactFinancialFields`
strips it for MEMBER unchanged. The column is named `dealValue`, **not** `value`, on
purpose: the redactor is a recursive strip-by-key-name, and a bare `value` would also
blank survey answers (which are `{ …, value }`). Don't rename it.

> Rule of thumb (from AGENTS.md): if you're reaching for an existing predicate
> because it's "close enough", that's the signal to write a new one.

### 3.4 State transitions are conditional claims, never blind writes

A kanban board is the most concurrent surface in the product — two people drag the
same card, both releases fire. So every state change is a **claim**: an `updateMany`
whose `where` includes the state you *believed* you were transitioning from. Zero rows
affected = someone got there first → 409, and the UI rolls back its optimistic move.

- `moveDealStage()` — `where { id, stageId: fromStageId }`
- `closeDeal()` / `completeTask()` — `where { …, status: OPEN }`

Never `update`-by-id a status/stage. Check-then-act on a shared row is always a bug
here (this codebase has been bitten enough to have this as a house pattern — same as
check-in and abstract-status).

### 3.5 Every relation id from a request body is bound to the org before use

`companyId`, `eventId`, `ownerId`, `stageId`, `crmContactId`, `contactId` — all arrive
from the client. Each is validated against `{ id, organizationId }` **before** it's
written. An unbound nested id straight from the URL is this codebase's single
most-repeated IDOR (accommodation H1, invoices H9, contacts H1). The services do this
in `validateRelations` / `resolveStage`; don't skip it in a new path.

### 3.6 Soft-delete is the default; the ONE hard-delete is SUPER_ADMIN-only

Deal / company / contact / task **soft-delete by default** — `archivedAt` is set, never a
row removed, so the record and its history survive and it can be restored. Every list /
board / report / CSV filters `archivedAt: null`; the reminder worker skips archived
tasks. Archive/restore is **admin + CRM_USER only** (`canDeleteCrm`, narrower than the
write predicate — ORGANIZER may edit but not archive).

**The one deliberate exception (owner request, July 20 2026): a SUPER_ADMIN may
PERMANENTLY delete ARCHIVED deals, companies and CRM contacts** — per-record ("Delete
permanently" on the record page) or in bulk ("Empty archive" in each archived list view).
This is `crm-purge-service.ts` + `POST /api/crm/purge`, gated by `requireCrmPurge`
(`canPurgeCrm` — SUPER_ADMIN sessions only). It is the **narrowest** CRM predicate and the
only one that **refuses API keys** — erasing revenue history is a human decision, not an
automatable one. Two other rules keep it safe: it is **archived-only** (an active record
is never purgeable — `NOT_ARCHIVED`), and **every purge snapshots the row into a core
`AuditLog` entry** (the deleteStage precedent: after the delete, the audit row is the only
record it existed). A company still referenced by any deal is refused (`COMPANY_HAS_DEALS`
— the FK is `Restrict`); the bulk purge runs deals→companies→contacts so a company whose
only deals were just purged becomes deletable in the same pass, and it **reports** every
per-record refusal rather than silently skipping.

The "detailed activity log" (`CrmActivity`) is written by **exactly one function**,
`recordCrmActivity` in [`lib/crm-activity.ts`](lib/crm-activity.ts) — every service
calls it and nothing else writes the table, so the trail can't drift between callers
(the no-cross-caller-duplication rule; the per-service `writeAudit` helpers this
replaced were the smell). Edits record field-level before→after via `diffFields`. It is
the CRM's own store, **not** the core `AuditLog` — org-scoped, diff-shaped, and actually
read in the UI. Deal money in a log payload is redacted for MEMBER by the same
`FINANCIAL_KEYS` machinery the board uses.

### 3.7 CRM email reuses the CORE send, never the event bulk-email pipeline

Outbound CRM email (sponsor blast + per-deal send) lives in `sponsor-email-service.ts`
and OWNS the audience + token logic, but it renders + sends through the **core**
primitives — `sendEmail` / `renderAndWrap` / `brandingFrom` (crm→core, allowed). It does
**not** touch the event `executeBulkEmail` pipeline (built around event recipient types —
registrations/speakers — and importing it here would drag those concerns across the
boundary the wrong way). Two entry points (`sendSponsorProspectus` for an event's
sponsors, `sendDealEmail` for one deal) funnel through one shared `dispatchCrmEmail`
(validate → **narrow-never-widen** intersection → batch with per-recipient failure
isolation). The audience is the pure, unit-tested `sponsor-recipients.ts`
(`collectSponsorRecipients` dedups on `emailKey`; a single deal is a one-element list, so
the same logic + tests cover both). Each success writes an `EmailLog` row (entity `OTHER`
+ the crmContactId — `EmailLogEntityType` has no CRM value, so no schema change) and a
CRM history row; the routes multiplex (`?eventId=` | `?dealId=`; send requires exactly
one). Staff-only + a dedicated `crm-sponsor-email:org` 10/hr bucket.

The **templates** the compose dialog offers are editable per-org rows (`CrmEmailTemplate`,
managed on the **Templates** tab), **not** hardcoded — seeded once from the
`crm-email-templates.ts` constants by `ensureCrmEmailTemplates` (the constants survive
only as the seed). Templates are config, so they audit to the **core `AuditLog`** (like
`pipeline-service`), not the entity-typed `CrmActivity`. Create/edit = write access;
archive = `canDeleteCrm` (admin + CRM_USER).

### 3.8 Notifications are the CRM's OWN feed, with ONE writer

In-app notifications (`CrmNotification` + the bell in the CRM shell header) are
**deliberately separate from the core notification service** (owner decision,
July 17): the event platform's bell reads `Notification`, the CRM bell reads
`CrmNotification`, and neither feed leaks into the other — do NOT "unify" them.
In-app only: no email (the reminders worker already emails task owners), no push.

`notifyCrmUser()` in [`lib/crm-notifications.ts`](lib/crm-notifications.ts) is the
**only** insert path (the recordCrmActivity one-writer rule again), and it owns the
two cross-cutting rules so no call site can forget them: a user is **never notified
about their own action** (actor/recipient compare lives in the writer), and it
**never throws** (the mutation it describes already committed — failures log and
are swallowed; callers `void`-call it after the real write).

Triggers: deal assigned (create/re-assign), your deal stage-moved / won / lost
(a drag into a mapped terminal column announces the OUTCOME, not a stage move),
task assigned, and the reminders worker's task-due nudge (minted right after the
`remindedAt` claim, so it rides the same idempotency as the email and reaches
mailbox-less temp accounts). Titles/messages carry **no deal money**, so the
FINANCIAL_KEYS redaction question never arises for this feed. Reads/mark-read are
scoped to the caller's own `userId` + org in the `where` clause — a foreign id
matches nothing (no IDOR by construction). API-key callers get an explicit 400
`NO_USER_CONTEXT` (notifications are per-user; a key has no user).

---

## 4. Code conventions

Follows the app-wide rules in [`/AGENTS.md`](../../AGENTS.md) and the service
conventions in [`src/services/README.md`](../services/README.md). CRM-specific points:

- **Services are the one home for any op called from >1 entry point.** REST + MCP +
  worker all delegate; they never re-implement. Errors are returned as values
  (`{ ok: false, code }`), never thrown across the boundary. A service never imports
  `next/server`.
- **Routes are thin.** Auth, money-redaction, error→HTTP mapping and the default write
  rate limit all live in `crm-route.ts` (`requireCrmRead` / `requireCrmWrite` /
  `redactForCaller` / `crmErrorResponse`). A handler that hand-rolls its own guard is
  how one ends up missing — a **source-level drift test**
  (`crm-route-gate-drift.test.ts`) fails if any `/api/crm/**` handler forgets a gate.
- **The write rate limit lives inside `requireCrmWrite`**, not in each route, so an
  unprotected CRM write is not expressible.
- **Every mutation writes an audit row** (fire-and-forget with a logged catch) and
  **every failure path logs** (no silent 4xx/5xx). Deletes snapshot the row into the
  audit `changes`, since after the delete the audit entry is the only record it
  existed.
- **Client/server split is real.** Anything imported by a `"use client"` component
  (components, `crm-types.ts`, `crm-roles.ts`, `use-crm-filters.ts`) must **not** pull
  a Node builtin into its graph. `crm-roles.ts` (pure) is client-safe;
  `crm-visibility.ts` (imports the logger → `fs`) is server-only. Mixing them broke the
  build once — the symptom in the wild is "the button does nothing, no logs".
- **Filters that could widen a result set must fail closed.** A bad date or unknown
  status is *ignored*, never allowed to drop the predicate and return everything
  (the bulk-email lesson). And the value filter is **server-gated** — see §3.3.
- **Dedup by a normalized key in the index, not by asking every writer to normalize.**
  `CrmCompany.nameKey` and `CrmContact.emailKey` (trim+lowercase) carry the unique
  index. Export the key function so backfills/imports derive the *same* key the
  runtime does.

---

## 5. Adding things — quick recipes

**A new field on an existing model:** additive + nullable migration only (prod shares
one DB across the blue-green swap — see AGENTS.md rule 4). Add to the service's input
type, the route's Zod schema, the client type in `crm-types.ts`, and the relevant
form/detail component.

**A new operation:** put the logic in the right `*-service.ts` (never in the route);
add a thin route that delegates; add a hook in `use-crm-api.ts`. If it's a state
transition, make it a conditional claim (§3.4).

**A new route:** it MUST call `requireCrmRead` or `requireCrmWrite` (the drift test
enforces this). Reads use `requireCrmRead`; any mutation uses `requireCrmWrite`.

**An MCP tool** (not built yet): goes in `src/crm/agent-tools.ts`, registered via one
line in `mcp-server-builder.ts` (a permitted touch point), and bump `package.json`
version (the MCP cache-invalidation hint). See the plan §7.7.

**Always run the gate before you push:** `npx tsc --noEmit && npm run lint &&
npm run test && npm run build`.

---

## 6. Status & what's next

The current, honest state — done / pending / linked-vs-not — is in
[`docs/CRM_STATUS.html`](../../docs/CRM_STATUS.html), and that is the page to keep
current. As of this writing the module is **built and tested but NOT deployed** (the
migration has not been applied to prod). Notable open items: **pipeline-stage
management UI** (rename/add/reorder is script/seed only today — no in-app editor), **MCP
tools**, the `Contact.organization → CrmCompany` backfill, the won-deal →
`Event.settings.sponsors[]` handoff, and the **Week-4 adversarial review** — which,
given that three separate guards (the build, a drift test, and an owner review) each
caught things during the build, should be treated as required, not a formality.

**Shipped surfaces (July 15 session).**

- **Dedicated record pages** for deal, account AND contact (`/crm/{deals,companies,contacts}/[id]`)
  on a shared **two-column record layout** (`record-layout.tsx`: header + main work area +
  sticky facts sidebar). Replaced the slide-out sheets — **no CRM detail sheet remains**;
  records cross-link (account→deals/people, contact→deals/company).
- **Outbound email** — the sponsor blast + the per-deal send + built-in templates (§3.7).
- **Pipeline stages** are now New → Proposal → Negotiation → Contract Signed → Purchase
  Order → Invoice Sent → **Won** → **Lost** (Won/Lost keep those names — `closeDeal` is
  name-bound). `ensurePipelineStages` never mutates an existing org's pipeline, so an
  existing org is brought over by `scripts/reconcile-crm-pipeline.ts` (pure
  `pipeline-reconcile.ts` planner; dry-run first; deals in dropped columns move to New).
- **Deal requires an event** (§1) — enforced at create/edit.
- **Product/service catalog + deal line items** (`crm-product-service.ts`, the **Products**
  tab, the Products card on the deal page) — seeded from Meeting Minds' service list
  (`crm-products-seed.ts`, 131 products); `category` = the functional group, `source` =
  In-House/Out-Sourced. A deal is itemized from catalog products (qty × unit price, price
  set on the deal); the deal **Value stays manual**. Line prices are finance-gated (`price`
  / `unitPrice` in `FINANCIAL_KEYS` → redacted for MEMBER); line rows snapshot
  name/category so a catalog edit never rewrites a deal.
- **Editable email templates** — the compose picker is backed by a per-org store (§3.7),
  managed on the **Templates** tab.
- **Reps picker excludes ORGANIZER** (`/api/crm/reps`) — sales team + admins only.
- **Edit + soft-delete (archive) + change-log** on every record (§3.6).
- **In-app notifications** (July 17) — the CRM's own bell in the shell header (§3.8):
  deal assigned / stage moved / won / lost, task assigned, task due. Separate from
  the core notification bell by design; migration `20260717120000_add_crm_notification`.
