# CRM Multi-Tenancy Sweep — as-executed record

> Focused, living record of the CRM (`Crm*`) domain's Phase-2 multi-tenancy sweep.
> The canonical roadmap is [MULTI_TENANCY.md](MULTI_TENANCY.md) §13 (this is the CRM
> deep-dive); live CRM feature status is [CRM_STATUS.html](CRM_STATUS.html); the module
> boundary + invariants are [../src/crm/README.md](../src/crm/README.md).
>
> **Status: the CRM domain is FULLY SWEPT** — RLS policy layer + C1/C2/C4 app-wiring, all
> behavior-preserving on master. Nothing about it changes production behavior today
> (`RLS_SET_LOCAL` is off on master, so `runWithTenant`/`tenantTransaction` are pure
> passthroughs and the policy files are never applied). It is load-bearing only on the
> future two-silo **platform** instance (MULTI_TENANCY.md §0).

---

## 0. TL;DR

| Layer | What | Commits / files | State |
|---|---|---|---|
| **Schema** | none needed | — | ✅ every `Crm*` model already carries a direct `organizationId` |
| **Policy #5** | CrmContact RLS (the PII down-payment) | `prisma/rls/crmcontact.sql` | ✅ July 27 |
| **Policy #7 Group 1** | 10 simple direct-org models | `48c4e98b` | ✅ July 28 |
| **Policy #7 Group 2** | the 6 deal-graph models | `a639addb` | ✅ July 28 |
| **Policy — CrmDealType** | the deal-type list model | `96dbf0c5` | ✅ July 29 |
| **C1** | `tenantTransaction` + `pipeline:390` org-bind | `535a12f9` | ✅ July 29 — **live on prod** |
| **C2** | `runWithTenant` on 42 routes + agent-tools + 2 workers | `76d9efd7` | ✅ July 29 |
| **C4** | `check-tenant-als.sh` gate covers CRM | `dfc24db2` | ✅ July 29 |

The full `Crm*` model set (17): `CrmContact`, `CrmCompany`, `CrmProduct`, `CrmPipelineStage`,
`CrmEmailTemplate`, `CrmQuoteCounter`, `CrmEmailSendClaim`, `CrmNotification`, `CrmActivity`,
`CrmTask`, `CrmNote`, `CrmDealType`, and the 6-model deal graph (`CrmDeal`, `CrmDealContact`,
`CrmDealProduct`, `CrmDealDocument`, `CrmEmailThread`, `CrmEmailMessage`).

---

## 1. Why the CRM was the easy-hard case

**Easy:** every `Crm*` table carries a **direct `organizationId` column** (the CRM was built
org-scoped from day one), so — unlike Webinar (#6) or Registration-core (#8) — there was **no
schema step, no backfill, no join-hop policy**. Every policy is the trivial flat shape (a
byte-shape copy of `crmcontact.sql`).

**Hard:** the CRM is a **multi-writer hub**. The deal graph is reached from the deal routes,
`sponsor-email-service`, both workers (`reminders`, `inbound-email`), the 3 importers,
`crm-purge-service`, `crm-quote-service`, and the `agent-tools` MCP surface. That breadth is why
the app-wiring (C2) touched 42 route files + 3 modules, and why the Deals cluster got an
adversarial review (the CRM analog of Invoice's C2a/C2b multi-writer split).

---

## 2. Policy layer (defence #2 — the DB backstop)

Split across passes by fixture complexity, all in `prisma/rls/` (applied ONLY by the tenancy
harness + the future platform bootstrap — **never a prisma migration**, so master keeps a DB with
zero RLS objects):

- **CrmContact (#5)** — went first because it holds the CRM's PII (sponsor reps' emails / mobiles
  / notes). Fixture: same `emailKey` in both orgs (`@@unique([organizationId, emailKey])`).
- **Group 1 (`48c4e98b`)** — the 10 simple direct-org models. Each org seeds one row; the B row
  doubles as the cross-tenant-miss / delete target. **`CrmQuoteCounter`** is the one edge case —
  its PK **is** `organizationId` with NO Organization FK, so it's excluded from the org cascade
  (teardown deletes it explicitly) and runs the read/delete subset (a create/re-home collides on
  the PK, not on RLS).
- **Group 2 (`a639addb`)** — the 6 deal-graph models, seeded as a `CrmDeal` on its stage with the
  children hung off it. Teardown deletes the deals **before** the org cascade
  (`CrmDeal→CrmPipelineStage/CrmCompany` are `Restrict`). WITH CHECK is proven via the **re-home
  UPDATE** path (own row, parents visible) rather than a cross-org create-smuggle — the deal-graph
  models have RLS-gated required parents, so a smuggle-create could fail on the parent FK lookup
  instead of on WITH CHECK; INSERT-side WITH CHECK is proven by Group 1's byte-identical policy.
- **CrmDealType (`96dbf0c5`)** — added with the deal-type feature; a simple direct-org
  Group-1-shape model (`@@unique([organizationId, name])` → both orgs share the name).

Tests: `tests/tenancy/crm-group1-rls.test.ts` + `crm-group2-rls.test.ts` (parameterized per model:
scoped-read isolation, cross-tenant by-id miss via USING, fail-closed no-store, cross-tenant DELETE
P2025, WITH CHECK org-re-home block). **Harness 60 → 147 → 174** (with CrmDealType), idempotent
across consecutive local runs. The `rls-assert` boot tripwire self-extends over every policied
table via `pg_policy`, so it covers all of these with no code change.

---

## 3. App-wiring (defence #1 + the RLS lane)

### C1 — services (`535a12f9`)

A read-only **defence-#1 audit** of all 17 CRM service/worker files found **ZERO caller-facing
IDOR gaps**: every caller-driven by-id write is already `updateMany`/`deleteMany` with
`organizationId`, or a by-id write on a row proven org-owned by an immediately-preceding
org-scoped read (**BOUND-via-prior-load**). So C1 was two things:

1. **12 `db.$transaction` → `tenantTransaction`** across 7 services (7 interactive renames + 5
   array-form → interactive-sequential — the array form can't carry the RLS `SET LOCAL`, same
   class as the webinar/registration bulk-tags conversions). Files: `crm-email-template`,
   `crm-product`, `crm-quote`, `deal-document`, `deal-type`, `crm-purge` (×3), `pipeline` (×4).
2. **One hardening** — `pipeline-service` reorder was the lone caller-path by-id
   `.update({ where: { id } })`. → `updateMany({ where: { id, organizationId } })` for per-row
   atomic org binding, matching its `deal-type` reorder sibling. (The set-membership guard above it
   already proved ownership; this makes it RLS-independent and symmetric.)

`tenantTransaction` on master (flag off) is a pure passthrough to `db.$transaction`, so this is
behavior-preserving — verified by the CRM unit suite (each affected `@/lib/db` mock gained a
`tenantTransaction` delegate via `vi.hoisted` so `db.$transaction` stays the same instance the
per-test `mockImplementation` drives; existing call-count assertions unchanged).

### C2 — routes + agent-tools + workers (`76d9efd7`)

- **42 route files, 71 handlers.** Each handler wraps its body after the
  `requireCrm{Read,Write,Delete,Purge}` guard in
  `return await runWithTenant(ctx.organizationId, async () => { … })`. `ctx.organizationId` is
  always in scope post-guard. Verified by the coverage gate (runWithTenant count ≥ handler count
  per file) + tsc.
- **Deal cluster adversarially reviewed:** list reads use `buildDealWhere` (org-bound at
  `deal-filters.ts:77`), by-id reads bind `organizationId`, deal-child document reads are scoped
  to an already-org-verified deal (BOUND-via-prior-load), mutations go through the C1-audited
  org-bound services — **no gap**.
- **agent-tools:** one wrap at the `safeTool` choke point — `await runWithTenant(organizationId,
  run)` — covers **every** CRM MCP tool (the API key's org).
- **2 workers** (org read off the row; the candidate sweep stays org-blind — the known worker
  precondition, invoice-reconciliation pattern):
  - `reminders-worker` — per-row `runWithTenant(task.organizationId, …)`, `continue`→`return`,
    + `organizationId` on the claim (defence #1 on top of the PK).
  - `inbound-email-worker` — wrap `processObject`'s org-known tail (from where the globally-unique
    reply token resolves the thread → exactly one org) in `runWithTenant(thread.organizationId, …)`
    + convert the array `$transaction` → `tenantTransaction` with `organizationId` on the thread
    update. Test: `tenantTransaction` mock forwards to the same delegates; the P2002 s3Key-race now
    rejects on `crmEmailMessage.create`.

### C4 — the CI gate (`dfc24db2`)

`check-tenant-als.sh` gained `src/app/api/crm` in `SWEPT_ROUTE_DIRS` (the gate now demands a
`runWithTenant` wrap on **every one** of the 42 CRM route files' handlers) + the 3 executor/worker
modules in `SWEPT_MODULES` (each must contain ≥1 `runWithTenant` call). Verified **both ways**:
green on HEAD, and stripping the wrap from `reps/route.ts` fails the gate naming the file. This is
the regression guard — inert on master, but a dropped wrap fail-closes to zero rows (or leaks) once
the platform enables RLS, and that's silent here, so only CI catches it.

---

## 4. What's NOT done (deferred, with rationale)

- **Identity model (Phase-1).** The CRM has no cross-org REGISTRANT-style reader routes, so unlike
  the Invoice/Registration sweeps there is **no deferred cross-org route** here. The only identity
  seam that touches the CRM is the shared `User` login (org-null for the app's non-team roles) —
  that's the platform-wide Phase-1 decision, not a CRM concern.
- **CrmContact backfill.** `Contact.companyId` / the central sync were noted in CRM_STATUS.html as
  wired-but-empty pending a backfill — that's a **feature** gap, not a tenancy gap (the tenancy
  sweep doesn't depend on it).
- **`sponsor-email-service` global env vars.** The CRM email plumbing leans on 3 global env vars
  (partnerships mailbox etc.); the reply-forward to a single global mailbox would cross-tenant-leak
  on a multi-tenant silo — a **hard platform precondition** (MULTI_TENANCY_IMPACT.md §7.1), harmless
  on single-org master. This is a platform-onboarding item, not part of this sweep.

---

## 5. Verification discipline (every commit)

Each of C1/C2/C4 passed the full gate before push, and only when CI was idle
(no-push-during-active-CI): **tsc + eslint + vitest (4197) + build** (+ the tenancy harness for the
policy-touching work). Staging used explicit paths only (the local main is a **shared working
tree** with a concurrent session — never `git add -A`). C1 is already live on prod (it rode the
same-day barcode deploy); C2+C4 deployed on push (behavior-preserving — C2 passthrough, C4 CI-only).

---

*Last updated: July 29, 2026 — CRM domain fully swept (policy layer + C1/C2/C4 app-wiring).*
