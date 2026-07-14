# CRM Module — Assessment & Implementation Blueprint

> **Status: IN BUILD — Week 1 (un-parked July 14, 2026).** The §9 planning round is **complete**; all four owner decisions are locked (see §9). Build proceeds per the §8 gate table.
>
> **Prior status, kept for the record:** PARKED (July 13, 2026) — "no new domains until a few real conferences have run on EA-SYS; the 11 active domains are already a large surface and stabilization comes first." The owner un-parked it the next day. The stabilization concern that drove the park has **not** gone away, so it is carried into the build as a constraint rather than dismissed: v1 ships **behind the §10 scope fence**, the module is **namespace-bounded** (§7.0) so it adds one place to look rather than eleven, and the Week-4 **adversarial review** gate is non-negotiable, not a nice-to-have. If a conference lands mid-build, the conference wins — the CRM schema is additive and unreferenced by any live path, so pausing costs nothing.

---

## 1. The ask

"Can we add a CRM module like Freshsales?" — companies/accounts, deals pipeline, tasks/reminders, notes, lifecycle stages, email integration.

## 2. What EA-SYS already has (roughly the "contacts" third of a CRM)

- **Contact store** — org-wide `Contact` model, auto-synced (enrich-only) from every registrant/speaker/reviewer interaction via `src/lib/contact-sync.ts`, with tags, specialty, country, photo, `eventIds` history, CSV import/export, a polished detail sheet, and MCP tools (`list/create/update_contact`).
- **Activity & email history** — `EmailLog` + `AuditLog` power per-person activity timelines (`src/lib/activity-feed.ts`); every outbound email is logged per entity.
- **Communications engine** — templated bulk email, scheduling, per-event branding, audience filters.
- **Company-ish entities** — `BillingAccount` (payers) and `Event.settings.sponsors[]`, though neither is a true first-class Account.
- **Money** — invoices, payments, credit notes (a won deal can convert to an invoice via existing machinery).

## 3. What Freshsales has that EA-SYS doesn't

1. **Companies/Accounts as first-class records** — today `Contact.organization` is a string.
2. **Deals pipeline** — stages, kanban, value, owner, expected close, win/loss.
3. **Leads / lifecycle stages & scoring.**
4. **Tasks & follow-up reminders** assigned to team members.
5. **Notes + manual activity logging** (calls, meetings).
6. **Two-way email inbox sync** (Gmail/Outlook) — by far the heaviest item; EA-SYS logs outbound only.
7. **Sales reports / forecasting.**

## 4. Build vs buy

- **Build Phases 1–2** (companies, tasks/notes, lifecycle, sponsor-deals pipeline): worth building because the killer use case — a **sponsorship/exhibitor sales pipeline joined to event data** (Abbott → BRIDGES 2026 → Gold → $40k → Negotiation) — is something no off-the-shelf CRM does against our events.
- **Don't build Phase 3** (inbox sync, scoring, workflow automation): replicating Freshsales' inbox sync is months of work. If the team needs it, connect an actual Freshsales/HubSpot via n8n (the MCP/API surface + the existing Webflow-sync n8n pattern make that a 1–2 day integration).

## 5. Resource verification (measured July 13, 2026 — infra is NOT the constraint)

| Resource | Measured | Verdict |
|---|---|---|
| CPU (Mumbai t3.large) | idles ~2.4%; peaks 40–78% only during deploys | Massive headroom |
| CPU credits | pinned at 864 (max) — never draining | No throttle risk |
| Memory | 2.0 GiB / 7.6 used; 5.6 GiB available + 4 GiB swap | Fine |
| Disk | 47% used, 26 GB free | Fine |
| Containers | web ~261 MiB, worker ~264 MiB, mediamtx ~13 MiB | Tiny |

A CRM serves ~5–20 internal staff doing dashboard CRUD — statistically invisible next to the public-registration bursts the system already survives. Data volume (even 50k contacts / 10k deals / 100k tasks) is tens of MB. The two real constraints: **(a)** DB connection pool discipline (indexed, org-scoped queries — a code-discipline issue, not capacity), **(b)** **human maintenance bandwidth** — a 12th domain to review and support. (b) is why this is parked.

## 6. Timeline estimate

- **Phase 1 (CRM-lite):** ~3–4 focused working days.
- **Phase 2 (deals pipeline):** ~4–6 focused days (kanban is the biggest single UI item; finance gating + stage-move concurrency need payments-domain-level care).
- **Both: ~7–10 focused days ≈ 3–4 calendar weeks** interleaved with live-event support. **A month is a comfortable budget**, with ~3–5 days of slack for polish or an eaten-by-a-live-event buffer.
- **Option (d) integrate real Freshsales instead:** ~1–2 days for an n8n sync.
- Condition for the month to hold: the §9 owner decisions are locked in the first half-day and don't reopen mid-build. Scope churn is the only observed timeline killer.

---

## 7. Implementation blueprint

**Design principle:** the CRM is not a new system — it's an **extension of the existing Contacts domain**, built with the exact same patterns as the other 11 domains (see `docs/DOMAIN_MAP.html` §System shape) so it adds minimal new mental context. Everything below reuses a pattern that already exists somewhere in the codebase; the only genuinely novel UI surface is the kanban board, and the only new dependency is `@dnd-kit`.

### 7.0 Architecture decision — "independent module, shared runtime" (locked July 13, 2026)

**Decision:** the CRM is built as a hard-bounded module INSIDE the EA-SYS app — its own namespace end to end — but NOT as a separate deployable/container.

**Considered and rejected: a separate CRM app/container.** The worker-container analogy doesn't transfer: the worker is the *same codebase/schema/DB* in a second process purely for CPU isolation (renders + email fan-outs off the request path); it has no identity, UI, or API surface. A CRM is the opposite shape — all UI + API + identity, no CPU pressure (see §5 measurements). A separate app would force: SSO/shared-session across apps, re-implemented RBAC + finance visibility (the exact drift class the domain reviews keep catching), either a shared DB anyway (making "independent" cosmetic) or a synced Contact copy (re-creating the identity-drift problem the email-immutability work eliminated), cross-service API calls for the Deal↔Event joins that are the module's whole differentiator, and a second deploy/rollback/DR/logging pipeline — permanent tax, purchased for ~10–20 internal users.

**What the module boundary looks like (the "independent" part, kept):**

- **API namespace:** everything under **`/api/crm/*`** — `crm/companies`, `crm/deals`, `crm/tasks`, `crm/pipeline-stages`. Nothing CRM leaks into existing route trees.
- **UI namespace:** pages under **`/(dashboard)/crm/*`** with their own sidebar section.
- **Code root:** everything under **`src/crm/`** (services, libs, components, hooks) — one folder = the whole domain. (CRM services live in `src/crm/services/`, not `src/services/`, to keep the boundary physical; they still follow the `src/services/README.md` conventions.)
- **Model namespace:** all Prisma models prefixed **`Crm*`** (`CrmCompany`, `CrmDeal`, `CrmPipelineStage`, `CrmTask`, `CrmNote`) so the schema reads as a visually distinct block.
- **One-way import rule, mechanically enforced:** `src/crm/` may import core (`@/lib/db`, `auth-guards`, `event-access`, `email`, `logger`, `finance-visibility`); core **never** imports from `src/crm/`. Enforced via an ESLint `no-restricted-imports` (or `import/no-restricted-paths`) rule added in Week 1, not left to discipline.
- **Core-side touch points (the complete list):** a sidebar entry, the MCP tool-registration line, one worker-job shim, and two schema FKs (`Contact.companyId`, `CrmDeal.eventId`).

**Mandatory integration (the five things you'd least want to rebuild):** identity/session (NextAuth), the Contact store (its event-driven sync is the module's data moat), the shared Postgres (three FKs: Contact/Event/User), the email pipeline + `EmailLog`, and org-scoping/RBAC. Everything else is namespace-separable.

**The escape hatch this buys:** if a real extraction driver ever appears (separate team owns CRM, external customers use it standalone, genuine load), `src/crm/` + `/api/crm/*` + `Crm*` models is a liftable bounded context — extraction becomes a scoped project instead of surgery. The option is kept without paying its cost now. Precedent: the webinar module's decouplable-namespace pattern (`src/lib/webinar*`), applied more strictly.

### 7.1 Where it lives

Org-level, not event-level — like Contacts and Billing Accounts. Sidebar gains a "CRM" section (Companies, Deals, My Tasks) next to the existing Contacts link, linking to pages under `/(dashboard)/crm/*`. Deals *link to* events but don't live under one.

### 7.2 Data model (all additive migrations, org-scoped from day one)

All models `Crm*`-prefixed per §7.0 so the schema reads as one distinct block:

```prisma
model CrmCompany {          // first-class Account (today Contact.organization is just a string)
  id             String   @id @default(cuid())
  organizationId String   // tenant scope — non-negotiable per MULTI_TENANCY_IMPACT.md
  name           String
  industry       String?  // pharma / hospital / society / agency
  website        String?
  country        String?
  city           String?
  notes          String?  @db.Text
  contacts       Contact[]        // via new nullable Contact.companyId FK
  deals          CrmDeal[]
  @@unique([organizationId, name])
}

model CrmDeal {
  id             String        @id @default(cuid())
  organizationId String
  companyId      String?
  contactId      String?
  eventId        String?       // THE differentiator: sponsorship deal tied to an event
  name           String        // "Abbott — BRIDGES 2026 Gold"
  value          Decimal?
  currency       String        @default("USD")
  stageId        String        // FK to CrmPipelineStage
  ownerId        String        // User (team member)
  expectedClose  DateTime?
  status         CrmDealStatus @default(OPEN)   // OPEN | WON | LOST
  lostReason     String?
}

model CrmPipelineStage {    // org-configurable, seeded with defaults
  id             String  @id @default(cuid())
  organizationId String
  name           String
  sortOrder      Int
  isTerminal     Boolean @default(false)
}

model CrmTask {
  id             String     @id @default(cuid())
  organizationId String
  title          String
  dueAt          DateTime?
  ownerId        String     // assigned team member
  contactId      String?
  companyId      String?
  dealId         String?
  status         TaskStatus @default(OPEN)    // OPEN | DONE
  remindAt       DateTime?
  remindedAt     DateTime?  // idempotency stamp for the reminder job
}

model CrmNote {
  id             String  @id @default(cuid())
  organizationId String
  body           String  @db.Text
  authorId       String
  contactId      String?
  companyId      String?
  dealId         String?
  activityType   String? // note | call | meeting
}
```

Plus two additive `Contact` columns: `companyId` (nullable FK) and `lifecycleStage` (enum — values decided in the §9 planning round). The existing `Contact.organization` string stays; a **backfill script** (dry-run default, `--write`, like `backfill-faculty-registration-type.ts`) creates Companies from distinct organization strings and links contacts.

### 7.3 Services layer (the anti-drift rule applies from day one)

Every operation reachable from more than one entry point goes in a service. Per §7.0 they live under **`src/crm/services/`** (physical boundary) while following the `src/services/README.md` conventions:

- **`src/crm/services/company-service.ts`** — find-or-create with the same exact-match-reuse / fuzzy-`needsReview` logic proven in `billing-account-service.ts` (copy that pattern).
- **`src/crm/services/deal-service.ts`** — the important one. `createDeal()`, `moveDealStage()` — a **conditional `updateMany where { id, stageId: expectedStage }`** claim (the race-safe pattern from check-in and abstract status) so two people dragging the same card can't double-move; loser gets 409 `STAGE_CHANGED`. `closeDeal(WON|LOST)`. Owns audit rows (`changes.source`) with stage history.
- **`src/crm/services/task-service.ts`** — CRUD + complete; owns the reminder stamp.

Errors-as-values result shape, typed inputs, no `next/server` imports — per `src/services/README.md`.

### 7.4 API routes

All under the **`/api/crm/*`** namespace (§7.0): `/api/crm/companies/*`, `/api/crm/deals/*` (+ `/api/crm/deals/[id]/stage` for kanban moves), `/api/crm/tasks/*`, `/api/crm/pipeline-stages/*`. Org-level like contacts. Every handler: `getOrgContext` (session or API key), `denyReviewer` on writes, Zod with `zodErrorResponse` (every 400 logs), rate limits on writes, audit on mutations.

**Finance gating:** deal routes additionally `denyFinance`-gated; `CrmDeal.value` added to `FINANCIAL_KEYS` so redaction machinery from invoices applies unchanged. (Whether MEMBER sees the board at all is a §9 decision.)

### 7.5 UI

All pages under **`/(dashboard)/crm/*`**; CRM components + hooks under `src/crm/` (hooks in `src/crm/hooks/use-crm-api.ts`, mirroring the `use-api.ts` pattern rather than growing it):

- **Companies** — list + detail sheet, structurally cloned from the contacts page (gradient-header detail sheet, React Query hooks).
- **Contacts page upgrades** — company link, lifecycle-stage badge, owner filter; notes/tasks cards slot into the existing detail sheet next to `EmailLogCard` + Activity timeline. The CRM timeline **merges into** the existing `activity-feed.ts` builder — one person's emails + edits + notes + deals render as a single feed.
- **Deals kanban** — one column per `PipelineStage`, drag-and-drop via **`@dnd-kit`** (the one new dependency). Optimistic move with rollback on 409 `STAGE_CHANGED` — same optimistic pattern as webinar panelists. Board filterable by event and owner.
- **My Tasks** — due-date-sorted list page + a dashboard "overdue tasks" tile.

### 7.6 Automatic data flow (the part off-the-shelf CRMs can't do)

Small hooks into existing code, all fire-and-forget like `syncToContact`:
- Registration/speaker sync already maintains Contacts — nothing new needed.
- A **won sponsorship deal** offers "create sponsor entry on the event" (writes `Event.settings.sponsors[]` via the atomic `updateEventSettings` helper) — one button, not automation.
- Contact detail already shows events attended (`eventIds`), which makes lifecycle stage meaningful.

### 7.7 Worker + MCP

- **Reminders:** new `worker/jobs/crm-reminders.ts` (~20-line shim over `runTick()` in `src/crm/reminders-worker.ts`), every 5 min: `remindAt <= now AND remindedAt IS NULL` → email owner via `sendEmail` with `logContext` → stamp `remindedAt`. Idempotent, advisory-locked, same shape as every other job. (The shim + scheduler line are two of the four permitted core-side touch points from §7.0.)
- **MCP tools** defined in `src/crm/agent-tools.ts` and registered via one line in `mcp-server-builder.ts` (a permitted touch point): `list/create_company`, `list/create/update_deal`, `move_deal_stage`, `list/create_crm_tasks` — pkg version bumped, clients reconnect. Makes the CRM automatable from n8n/claude.ai day one (e.g. the Webflow-sync pattern).

## 8. Build order & gates (the month, concretized)

| Step | Scope | Gate |
|---|---|---|
| 0. Planning round (half day) | Lock the §9 owner decisions | Nothing coded before answers |
| Week 1 | `src/crm/` scaffold + **ESLint import-boundary rule** (§7.0) + migrations + services + API + tests (schema ships behind no UI — additive, zero risk to live events) | tsc/lint/vitest/build per commit |
| Week 2 | Companies + contacts upgrades + tasks/notes + reminders job | **Deploy — Phase 1 usable** |
| Week 3 | Deal model + kanban + finance gating | tsc/lint/vitest/build |
| Week 4 | MCP tools, backfill run, dashboard tiles, **adversarial review** (4-angle: lifecycle · RBAC/finance-leaks · concurrency · drift/logging), fix HIGHs | **Deploy — Phase 2 live** |

Post-ship: add a "12. CRM" branch to `docs/DOMAIN_MAP.html` and refresh its stamp.

## 9. Owner decisions — **LOCKED (planning round, July 14, 2026)**

All four answered. These are now build constraints; changing one after Week 1 means a migration on a live DB, so they are recorded here rather than left in chat.

**1. Primary use case → sponsor / exhibitor sales pipeline.**
Not delegate/HCP management (mostly already served by the contact store + activity timeline, so the net-new value was small) and not a general team CRM (widest scope, weakest differentiation — that's the shape an off-the-shelf tool serves best). *Consequences:* **`CrmCompany` is the centre of gravity**, not Contact. `CrmDeal.eventId` is a **first-class, prominent link** — the "Abbott → BRIDGES 2026 → Gold → $40k → Negotiation" join is the module's whole reason to exist (§4). The kanban board's default filter is by event. The won-deal → `Event.settings.sponsors[]` handoff (§7.6) is a headline feature, not a footnote.

**2. Contact lifecycle → `LEAD` / `ENGAGED` / `CUSTOMER` / `CHAMPION`.**
Prisma enum `CrmLifecycleStage`, nullable on `Contact` — existing contacts stay `null`, so this is additive and needs no backfill. Generic enough to fit both a sponsor company contact and an HCP; small enough that each value stays meaningful. *Rejected:* the sponsor-flavoured `PROSPECT/ENGAGED/SPONSOR/LAPSED` set (LAPSED is genuinely the most actionable renewal segment, but it belongs to the **company**, not the contact — a person doesn't lapse, an account does; renewal chasing is therefore a **deal/company** query, not a lifecycle value, and is served by "won deal last year, none this year"). *Also rejected:* skipping lifecycle in v1 (tags cover it informally but can't be reported on) and the coarse two-state LEAD/CUSTOMER.

**3. Pipeline → `Prospect → Contacted → Proposal → Negotiation → Won/Lost`, org-editable.**
Stages live in the **`CrmPipelineStage` table** (not a Prisma enum) with `sortOrder`, seeded with these five. Editable because sales *will* change its mind, and a table means that's a row edit rather than a migration against a live DB. *Consequence:* the stage-management UI + reorder logic are in v1 scope, and `moveDealStage()` must validate the target stage belongs to the caller's org (a stage id is now user-supplied input, i.e. an IDOR surface — bind it).

**4. Visibility → staff own; all staff see all deals; MEMBER sees the board with values redacted.**
Deal `ownerId` ∈ {SUPER_ADMIN, ADMIN, ORGANIZER}. Every staff member sees the **whole** board — the team is small, and per-owner siloing adds friction with no benefit. **MEMBER** sees stages, companies and deal names but **not** values: `CrmDeal.value` goes into `FINANCIAL_KEYS` so the existing `redactFinancialFields()` machinery applies unchanged. *Rejected:* hiding the CRM from MEMBER entirely (leadership is exactly who wants the board); showing MEMBER full values (MEMBER *is* finance-capable today, but a sponsor-side stakeholder holding a MEMBER account would then see every rival sponsor's deal value — the one place the existing finance boundary is too generous); and per-owner ORGANIZER scoping (adds row-level ownership filtering to every query and every MCP tool, which is historically exactly where this codebase's IDOR bugs come from — see the contacts/accommodation reviews).

> **Note on the CRM's own visibility boundary.** Per the `AGENTS.md` rule, this does **not** reuse an existing predicate: `canViewContacts` includes MEMBER but excludes ONSITE; finance includes both MEMBER *and* ONSITE. The CRM needs "staff + MEMBER-with-redaction, never ONSITE/REVIEWER/SUBMITTER/REGISTRANT" — close to `contact-visibility` but not equal to it. Week 1 therefore adds **`src/crm/lib/crm-visibility.ts`** (`canViewCrm()` / `canOwnDeals()` / `denyCrmAccess()`), fails-closed, logging its own refusal.

## 10. Explicitly out of scope (v1)

- Two-way email inbox sync (integrate, don't build — §4)
- Lead scoring / workflow automation
- Multi-currency pipeline rollups (store currency per deal; report per-currency)
- Any coupling to the standalone `mmg-recording-pipeline` project (unrelated system)
