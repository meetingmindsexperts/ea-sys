# Migrating from Freshsales — scale ceilings, field mapping, runbook

> **Status: assessed, not yet executed.** Written August 7, 2026 against a real
> Freshsales tenant of **~10,000 deals / ~4,400 contacts / ~230 accounts**.
> Everything here is verified against the code (file:line) or against the
> Freshworks docs (linked). The one thing NOT verified is what your specific
> export actually emits — §5 is how to settle that in five minutes.
>
> Companion docs: [CRM_STATUS.html](CRM_STATUS.html) (live status board),
> [src/crm/README.md](../src/crm/README.md) (module invariants).

---

## 0. The one-paragraph answer

Postgres handles this volume without noticing — 10k deals is small, and the
indexes are right. What does **not** handle it as shipped is the *pipeline
around* the data: three hard caps block a single-file import (§1), and two list
screens silently truncate after the data lands (§2). Chunked imports are the
supported path today (§3). The field mapping is broadly correct but has four
real gaps, one of which silently corrupts historical close dates (§4).

---

## 1. Import ceilings — three hard blocks

| # | Cap | Where | Effect at this volume |
|---|-----|-------|-----------------------|
| 1 | **5,000 rows** per CSV | [`csv-parser.ts` `MAX_ROWS`](../src/lib/csv-parser.ts) | A 10k-deal file is rejected *before any row is read* ("CSV exceeds maximum of 5000 rows"). 4.4k contacts passes. |
| 2 | **1 MB request body** | [`proxy.ts` `MAX_BODY_SIZE`](../src/proxy.ts) | The import dialog reads the whole file (`await file.text()`) and posts it as a JSON string. A 10k-deal export is ~3–5 MB → **413**. 4.4k contacts lands ~0.7–1.1 MB → **borderline**. |
| 3 | **60 s gateway timeout** | live nginx `location /` | The importer walks rows **sequentially** — each deal is an indexed `findFirst` plus a write. 10k rows ≈ 2–4 min → **504** while Node keeps writing. |

Notes that matter:

- **nginx allows 10 MB** (`client_max_body_size 10M`); the binding limit is the
  app middleware, not the proxy. The only location with a raised
  `proxy_read_timeout` (300 s) is `/api/mcp` — everything else inherits 60 s.
- **Cap 3 fails *after* writing.** You would see a gateway error with a partial
  import and no report. This is survivable only because the importer is
  genuinely idempotent — deals upsert on `externalId`
  ([`crm-import-service.ts`](../src/crm/services/crm-import-service.ts)) — so a
  re-run converges instead of duplicating. That property is what makes §3 safe.
- The `MAX_ROWS` cap is **global** (shared with the registration / abstract
  importers), so raising it for the CRM means a per-caller cap, not a blanket
  bump.

## 2. Post-import ceilings — two silent truncations

| Surface | Cap | Consequence |
|---------|-----|-------------|
| Deals board | `take: 1000` ([`deals/route.ts`](../src/app/api/crm/deals/route.ts)) | With 10k deals, **9,000 are invisible** — no pagination, no "showing 1,000 of N" notice. |
| Contacts list | `take: 500` ([`contacts/route.ts`](../src/app/api/crm/contacts/route.ts)) | 4,400 in, 500 shown. |
| Companies list | `take: 500` | 230 fits — no issue. |

Filters and search on both surfaces are **server-side**, so a *filtered* view is
accurate and search finds any record. It is the *unfiltered browse* that lies.
On a sales pipeline, silent truncation is the more dangerous of the two failure
modes here — a number that is quietly wrong beats a screen that is obviously
empty.

The board renders every card without virtualisation, but 1,000 cards is
sluggish-not-broken. Truncation is the problem, not DOM weight.

## 3. Runbook — chunked import (the supported path today)

1. **Decide what actually needs to come across.** If most of the 10k deals are
   closed years ago, importing only open deals plus the last 1–2 years of
   won/lost drops you under every cap in §1 and skips most of this. This is a
   business call, and it is the cheapest fix available.
2. **Build three export views in Freshsales** (Companies / Contacts / Deals)
   using *Manage Columns*. See §4 for which columns. **The record Id is not
   included by default — add it manually.**
3. **Split each export into ~1,500-row chunks.** That stays under both the row
   cap and the body cap with headroom.
4. **Import companies first**, then contacts, then deals. Order is not strictly
   required (the importer find-or-creates companies named in a contacts/deals
   CSV — `makeCompanyResolver`), but importing in order keeps the reports clean.
5. **Dry-run every chunk before writing.** The dialog does this by default and
   the report is the mapping test: it lists created / updated / enriched /
   kept-local counts, **unrecognized columns**, stage→column mappings, event
   matches vs fallback, and unmatched owners.
6. **Re-running a chunk is safe.** `decideImportAction` upserts on `externalId`;
   a record edited in EA-SYS after its last import is reported as *kept-local*
   and left alone.

## 4. Field mapping — what maps, and four gaps

### The structural fact

There is no fixed "Freshsales export format". Per Freshworks' own docs, **the
exported columns are whatever columns are in the view you export from**, managed
via *Manage Columns*, and **the record ID is not included by default**
([Coefficient](https://coefficient.io/how-to-import-and-export-freshsales-data),
[Freshworks Community](https://community.freshworks.com/freshsales-11250/export-contacts-accounts-or-deals-to-csv-in-freshcrm-20619)).

Our side is built for that: every field resolves through a **synonym list**
against normalised headers (lowercased, whitespace-stripped), and any column
nothing claims is **reported, not silently dropped**
([`freshsales-import.ts`](../src/crm/lib/freshsales-import.ts)). The Id column is
**required for deals** — it is the upsert key that makes re-imports converge
instead of duplicating the pipeline.

### What maps cleanly

Checked against the [Freshworks CRM API](https://developers.freshworks.com/crm/api/#deals)
field names and the likely display labels:

| Freshsales column | API field | Our synonyms |
|---|---|---|
| Deal / Contact / Account ID | `id` | `id`, `dealid`, `contactid`, `accountid`, `salesaccountid` |
| Name, Amount, Currency, Deal Stage | `name`, `amount`, `currency_id`, `deal_stage_id` | ✅ — Amount tolerates `40,000.00` and `USD 40000` |
| Expected Close, Closed Date | `expected_close`, `closed_date` | ✅ — **but see gap 1** |
| Sales Account | `sales_account_id` | `salesaccount`, `accountname`, `company`, `companyname` |
| First / Last Name, Email, Job Title | `first_name`, `last_name`, `email`, `job_title` | ✅ — a multi-email cell takes the first |
| Work Phone, Mobile | `work_number`, `mobile_number` | ✅ — kept as separate fields |
| Country, Tags, Website, Industry Type | — | ✅ |

### Gap 1 — date parsing (fix before importing, not after)

`parseDateCell` is `new Date(v)`
([`freshsales-import.ts`](../src/crm/lib/freshsales-import.ts)). Freshsales lets
you pick DD/MM/YYYY, MM/DD/YYYY or YYYY/MM/DD on *import* and does not document
the *export* format
([Freshsales support](https://support.freshsales.io/support/solutions/articles/50000004243-expected-behaviours)).
Measured in Node:

```
05/03/2026  ->  2026-05-02        (5 March read as 3 May, then TZ-shifted)
25/03/2026  ->  INVALID -> undefined
2026-03-05  ->  2026-03-05        OK
5 Mar 2026  ->  2026-03-04        (local midnight, off by one in UTC)
```

If the export is day-first, the first ~12 days of each month are **silently
wrong** and days 13–31 **silently vanish**. A vanished close date is not benign:
on a won deal `wonAt` falls back to `new Date()`, so **historical wins get
stamped with today's date** — reintroducing through the front door exactly the
reporting bug the R2-M6 fix closed. Across 10k deals this destroys win-date
history quietly.

**Fix shape:** replace `parseDateCell` with a format-explicit parser plus a
format picker in the import dialog, mirroring Freshsales' own DD/MM vs MM/DD
choice. Do not auto-detect — ambiguity is the whole problem.

### Gap 2 — deal owner is matched by email only

`ownerByEmail` in
[`crm-import-service.ts`](../src/crm/services/crm-import-service.ts); a name-only
owner increments `ownersUnmatched` and the deal lands **unassigned**. Freshsales
views display *Sales Owner* as a name, and whether an owner-email column is even
offered in Manage Columns is **unverified** — if it is not, all 10,000 deals
import unowned. (Freshsales' own import docs require the owner column to carry
*the email address, not the name*, so they think in emails; that says nothing
about the export.)

Matching is also **role-bound** by design (review R2-M5): an owner email
resolving to a MEMBER/ONSITE account counts as unmatched rather than assigning
CRM content to a role the CRM excludes.

### Gap 3 — contact owner is not imported at all

`CrmContact` has an `ownerId`, but `CONTACT_FIELDS` has no owner entry, so all
4,400 contacts land unowned regardless of the CSV. Same for `lifecycleStage` and
`status`, which drive the contacts-list filters — everything defaults.

### Gap 4 — deal `pipeline`, `dealTypeId` and `tags` are not mapped

If you run more than one pipeline in Freshsales, all deals collapse into ours.
Company `phone` and `tags` are unmapped too. And the Lost Reason API field is
`deal_reason_id`, so the display label may read **"Deal Reason"** — we accept
`lostreason` / `closedlostreason` / `deallostreason` but *not* `dealreason`, so
it would be reported as unrecognized and dropped.

## 5. Before importing: the five-minute check

Export **5 rows** from each of Deals / Contacts / Accounts with the columns you
intend to use, and look at the header line plus one data row. That settles every
open question above at once:

- Which columns your views actually emit (→ which synonyms to add).
- The **date cell format** (→ gap 1).
- Whether an **owner email** column exists (→ gap 2).
- The **Lost Reason** label (→ gap 4).

Running that sample through the dialog's **dry run** produces the same answer
from the other direction: it prints unrecognized columns, stage mappings, and
unmatched-owner counts before anything writes.

## 6. Work not yet done

Tracked here rather than in ROADMAP because it is one coherent piece of work,
gated on §5:

1. Format-explicit date parsing + a picker in the import dialog (gap 1).
2. Owner mapping for contacts; name-based owner fallback for deals (gaps 2–3).
3. `pipeline` / `dealTypeId` / deal `tags` / company `phone`+`tags` mapping, plus
   a `dealreason` synonym (gap 4).
4. Per-caller row cap for the CRM importers, and exempting `/api/crm/import/*`
   from the 1 MB middleware cap (§1 caps 1–2).
5. Batched lookups in the importer — prefetch existing `externalId`s into a Map
   the way `makeCompanyResolver` already prefetches companies. Turns ~20,000
   sequential round trips into a handful and removes the timeout (§1 cap 3).
6. Pagination on the deals board and contacts list — or at minimum a
   "showing 1,000 of N, narrow your filters" banner (§2).

---

## Sources

- [Coefficient — How to import and export Freshsales data](https://coefficient.io/how-to-import-and-export-freshsales-data)
- [Freshworks Community — Export contacts, accounts or deals to CSV](https://community.freshworks.com/freshsales-11250/export-contacts-accounts-or-deals-to-csv-in-freshcrm-20619)
- [Freshworks CRM API reference](https://developers.freshworks.com/crm/api/#deals)
- [Freshsales — How to import records from a CSV/XLSX file](https://crmsupport.freshworks.com/support/solutions/articles/50000002586-how-to-import-records-contacts-accounts-deals-from-a-csv-xlsx-file-)
- [Freshsales — Expected behaviours (date formats)](https://support.freshsales.io/support/solutions/articles/50000004243-expected-behaviours)
