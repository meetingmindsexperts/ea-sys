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
  tied to an event.
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
- Hard delete of deals or companies (a deal is revenue history — close it LOST; a
  company is merged, not deleted).
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
    pipeline-service.ts       seed + edit the org's stage list
    deal-service.ts           THE important one — stage moves, close, deal↔contacts
    crm-contact-service.ts    business contacts + link-to-event-contact
    task-service.ts           tasks + the reminder stamp
    note-service.ts           author-only notes
  lib/
    crm-roles.ts        PURE, client-safe role predicates (canViewCrm / canOwnDeals / canViewDealValues)
    crm-visibility.ts   SERVER-ONLY HTTP guards (denyCrmAccess / denyCrmWrite) — imports crm-roles
    crm-route.ts        shared route boundary: auth + redaction + error→HTTP + write rate limit
    crm-types.ts        client-safe types + display constants (labels, colours)
    deal-filters.ts     pure filter → Prisma-where parsing (the finance gate lives here)
    reports.ts          pure report math (pipeline/win-loss/leaderboard; keeps redacted values null, never 0)
    use-crm-filters.ts  URL-backed filter state hook
  hooks/
    use-crm-api.ts      all React Query hooks (queries + mutations)
  components/           board, sheets, dialogs, filters/
  reminders-worker.ts   the CRM task-reminder tick (runTick)

src/app/api/crm/*                REST surface (15 endpoints)
src/app/(dashboard)/crm/*        pages: layout (tabs) + deals/companies/contacts/tasks
worker/jobs/crm-reminders.ts     the cron shim that calls reminders-worker
prisma/schema.prisma             the Crm* models (7 models, 5 enums)
__tests__/crm/*                  tests
```

**Data model:** `CrmCompany`, `CrmPipelineStage`, `CrmDeal`, `CrmContact`,
`CrmDealContact` (join, with a per-deal role), `CrmTask`, `CrmNote`. Plus two
enums for status/lifecycle and one for deal-contact role. See the `// CRM MODULE`
block in `prisma/schema.prisma` — every model is heavily commented with *why* its FK
policies are what they are.

---

## 3. The five things that are load-bearing

If you internalize nothing else, internalize these. Each exists because getting it
wrong causes a real bug, and several were caught the hard way during the build.

### 3.1 The import boundary is one-way, and enforced

`src/crm/` may import core (`@/lib/db`, `auth-guards`, `email`, `logger`,
`finance-visibility`, …). **Core must never import `src/crm/`.** This is enforced by
an ESLint `no-restricted-imports` rule in `eslint.config.mjs`, not by discipline —
"we'll remember" is exactly how the webinar module's namespace started leaking.

There are exactly **three** permitted core-side touch points (listed by name in the
ESLint config): the sidebar entry, the MCP registration line, and the worker job
shim. Adding a fourth is a deliberate act — you edit that exemption list, and you
should have a reason. (One was added and then reverted during the CrmContact rework;
that's the bar.)

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

### 3.6 There is no hard delete, and the change log has ONE writer

Deal / company / contact / task **soft-delete only** — `archivedAt` is set, never a
row removed, so the record and its history survive and it can be restored. Every list /
board / report / CSV filters `archivedAt: null`; the reminder worker skips archived
tasks. Archive/restore is **admin + CRM_USER only** (`canDeleteCrm`, narrower than the
write predicate — ORGANIZER may edit but not archive).

The "detailed activity log" (`CrmActivity`) is written by **exactly one function**,
`recordCrmActivity` in [`lib/crm-activity.ts`](lib/crm-activity.ts) — every service
calls it and nothing else writes the table, so the trail can't drift between callers
(the no-cross-caller-duplication rule; the per-service `writeAudit` helpers this
replaced were the smell). Edits record field-level before→after via `diffFields`. It is
the CRM's own store, **not** the core `AuditLog` — org-scoped, diff-shaped, and actually
read in the UI. Deal money in a log payload is redacted for MEMBER by the same
`FINANCIAL_KEYS` machinery the board uses.

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
migration has not been applied to prod), and the notable open items are: the "API
exists, UI doesn't" set (pipeline-stage management, deal edit, standalone task
create), MCP tools, the `Contact.organization → CrmCompany` backfill, the won-deal →
`Event.settings.sponsors[]` handoff, and the **Week-4 adversarial review** — which,

**Shipped surfaces of note.** The **sponsor prospectus email** (`sponsor-email-service.ts`
+ `sponsor-recipients.ts` + `SponsorEmailDialog`, the *Email sponsors* button on the
board) is the module's one outbound bulk send: it resolves an event's sponsors (the
deduped contacts on its non-lost deals), then renders + sends via the **core**
`sendEmail`/`renderAndWrap` primitives (crm→core), never the event `executeBulkEmail`
pipeline. The audience is computed in the pure, unit-tested `sponsor-recipients.ts` and
the send is an **intersection** with the reviewed selection — narrow, never widen.
given that three separate guards (the build, a drift test, and an owner review) each
caught things during the build, should be treated as required, not a formality.
