# EA-SYS — Codebase size by domain

A count of API routes and source files per domain, bucketed into the domains
[DOMAIN_MAP.html](DOMAIN_MAP.html) names. The map lists entry points as globs
(`api/events/[eventId]/registrations/*`) and never publishes counts, so these
numbers are **derived from the tree, not quoted from the map**. Recorded here
because the derivation surfaced a gap in the map itself (§3).

**Provenance.** Counted from a read-only clone by an external analysis on
2026-09-08, which named its snapshot as `dd1f8b2`. That hash is not in `main`'s
history, so the two exact totals were re-derived at `ded1c939` (the head of
`main` the same morning): **345 API route files**, matching exactly; **1,069
`.ts`/`.tsx` files under `src/` + `worker/`** against the analysis's 1,073, so
its file base was `src/` plus the worker tier give or take a handful. Per-row
figures are the analysis's own and carry its bucketing caveat (§2).

## 1. The table

| # | Domain (from DOMAIN_MAP.html) | API routes | Files (.ts/.tsx) |
|---|---|---|---|
| 1 | Registrations + Speakers | 41 | 97 |
| 2 | Payments / Refunds / Credit-notes | 11 | 22 |
| 3 | Invoices / Quotes | 14 | 27 |
| 4 | Abstracts + Reviewers | 23 | 62 |
| 5 | Program / Agenda / Sessions | 16 | 40 |
| 6 | Check-in + Badges | 9 | 26 |
| 7 | Communications / Bulk-email | 24 | 69 |
| 8 | Accommodation | 15 | 36 |
| 9 | Certificates | 21 | 45 |
| 10 | Survey + Dinner RSVP | 12 | 26 |
| 11 | Media Library | 4 | 9 |
| 12 | Analytics | 4 | 22 |
| 13 | HR — Attendance & Leave | 12 | 35 |
| — | Webinar / Zoom / Streaming | 22 | 56 |
| — | Contacts (org CRM store) | 9 | 24 |
| — | Promo codes | 6 | 10 |
| — | Billing accounts | 5 | 10 |
| — | MCP / AI-agent platform | 13 | 48 |
| — | Identity / RBAC | 21 | 54 |
| — | Infra / ops | 10 | 37 |
| ⚠ | **CRM module (sales pipeline)** | **40** | **119** |
| — | Events core (CRUD / dashboard / settings) | 11 | 53 |
| — | Shared UI / hooks / lib (cross-cutting) | 2 | 124 |
| — | Unbucketed (root pages, error boundaries, proxy) | 0 | 22 |
| | **Total** | **345** | **1,073** |

## 2. Method, and what the numbers can and cannot say

- Routes are `src/app/api/**/route.ts` files; one file can hold several HTTP
  verbs, so "routes" means route files, not handlers.
- Bucketing is by path and name pattern, **first match wins**. A route that
  legitimately spans two domains lands in exactly one bucket
  (`registrations/[id]/refund` under Payments, `speakers/[id]/agreement` under
  Registrations + Speakers), so ±2–3 per row is realistic. The two totals are
  exact; the rows are a map, not a ledger.
- The CRM row is the most under-counted one. At `ded1c939` there are **45**
  route files under `api/crm/` (18 groups: deals 10, companies 4, inbox,
  import, contacts, activity 3 each, then tasks, sponsor-email, products,
  pipeline-stages, notes, email-templates, deal-types 2 each, and reps, reports,
  purge, notifications, events-lite) and **128** files across `src/crm/`,
  `app/(dashboard)/crm/` and `api/crm/`; first-match bucketing sent a few of its
  inbox and import routes elsewhere.
- Re-derive rather than update: `git ls-files 'src/app/api/**/route.ts' | wc -l`
  and `git ls-files 'src/**/*.ts' 'src/**/*.tsx' 'worker/**/*.ts' | wc -l` give
  the two totals in seconds. The per-domain split needs a bucketing script and
  is only worth redoing when a domain is added or the map is re-walked.

## 3. What stands out

1. **The CRM module was a blind spot in the domain map.** Forty-plus API
   routes and ~120 files (companies, deals, pipeline stages, inbox, quotes,
   products, imports, its own worker jobs and MCP tools) formed the
   second-largest surface in the codebase and had **no branch in
   DOMAIN_MAP.html**. The map's "Contacts (org CRM store)" is a different,
   much smaller thing (24 files, the org-wide contact records that registrations
   and speakers sync into). Since [AGENTS.md](../AGENTS.md) says "to understand a
   domain before touching it, start at the domain map", that was the
   highest-value gap. **Closed 2026-09-08:** the map now carries a "CRM module
   (sales pipeline)" branch beside the Contacts one, pointing at
   [src/crm/README.md](../src/crm/README.md) (the developer entry point),
   [CRM_STATUS.html](CRM_STATUS.html) (what is linked to the rest of EA-SYS and
   what is not) and the two review reports.
2. **The map's header admits its own staleness.** Only abstracts, worker/jobs,
   roles, registrations and HR have been re-walked since July 13, 2026. A
   re-walk is due after any review round; the counts above are one way to
   decide where a re-walk pays back most (the big rows first).
3. **A numbering nit.** Analytics is filed under "Supporting domains" in the map
   while carrying the number 12 in the active list. Harmless, but it is the
   kind of inconsistency that makes a reader doubt the rest; fix it the next
   time the map is re-walked.

## 4. Where this sits

- [DOMAIN_MAP.html](DOMAIN_MAP.html): the qualitative index (entry points, core
  files, gotchas, review status per domain). Read that to *understand* a domain.
- This file: the quantitative view. Read it to judge *how big* a change is, or
  where an audit's effort goes.
- [DEPENDENCY_LOG.md](DEPENDENCY_LOG.md) and [MAINTENANCE_LOG.md](MAINTENANCE_LOG.md):
  what changed and when, for dependencies and planned production work.
