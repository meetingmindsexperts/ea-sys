# Migrating from Freshsales — ceilings, field mapping, runbook

> **Status: BUILT, not yet executed.** Assessed 7 August 2026 against a real
> Freshsales tenant of **~10,000 deals / ~4,400 contacts / ~230 accounts**; the
> four fixes it called for shipped 10 August 2026. What remains is one thing only
> — **a real sample export** (§5), which decides whether any further header
> synonyms are needed.
>
> Everything here is verified against the code (file refs) or the Freshworks docs
> (linked). Companion docs: [CRM_STATUS.html](CRM_STATUS.html) (live status),
> [src/crm/README.md](../src/crm/README.md) (module invariants).

---

## 0. The one-paragraph answer

Postgres handles this volume without noticing. What did **not**, as originally
shipped, was the pipeline around it: three caps blocked a single-file import and
two list screens silently truncated afterwards. Two of the three import caps are
now gone, both truncations are now honest, and four field-mapping gaps are
closed — one of which had been silently corrupting historical close dates.
**Chunked import at ~5,000 rows per file is the supported path**; that is 2 files
of deals, 1 of contacts, 1 of accounts.

---

## 1. Import ceilings

| # | Cap | Where | Status |
|---|-----|-------|--------|
| 1 | **5,000 rows** per CSV | [`csv-parser.ts` `MAX_ROWS`](../src/lib/csv-parser.ts) | **Unchanged, deliberately.** It is the chunk size, not a bug. Raising it means either jobifying the import or accepting the timeout risk in cap 3. |
| 2 | ~~1 MB request body~~ | [`body-limits.ts`](../src/lib/body-limits.ts) | ✅ **Fixed.** `/api/crm/import/*` now gets **8 MB**; everything else keeps 1 MB. nginx already allowed 10 MB, so the app limit was the binding one — the 413 on an ordinary 2-3 MB export was ours. |
| 3 | 60 s gateway timeout | live nginx `location /` | ⚠️ **Mitigated, not removed.** Per-row lookups are gone (below), so a 5,000-row chunk finishes comfortably. A single 10k-row file would still be at risk — which is why cap 1 stays. |

**On cap 3 specifically:** every row used to cost **two reads** before its write
(by `externalId`, then by natural key) — 15,000 sequential round trips for a
5,000-row file. Each importer now does **one `findMany` per file** and indexes it
([`indexBy`](../src/crm/services/crm-import-service.ts)). That is safe because
the in-file `seenKeys` dedup already rejects a second row carrying either
identity, so a prefetched map cannot go stale within its own file; rows created
by a *concurrent* import are still caught by the unique indexes, and the P2002
handler reports "re-run to converge".

**Writes stay per-row on purpose.** `createMany` would be faster still but would
lose the per-row `try/catch`, and one bad row killing a 5,000-row file is a far
worse trade than a slower import.

## 2. Post-import truncation — now honest

All three list routes return the **true total** alongside the capped page, and
the UI renders *"Showing 2,000 of 10,412 — narrow the filters"*
([`list-caps.ts`](../src/crm/lib/list-caps.ts),
[`list-truncation-banner.tsx`](../src/crm/components/list-truncation-banner.tsx)).

| Surface | Cap | Note |
|---------|-----|------|
| Deals board | 2,000 | Deliberately not higher — it renders every card with **no virtualisation**, so raising it trades a truthful banner for a frozen tab. Filters are the intended answer. |
| Contacts list | 1,000 | 4,400 contacts will truncate, and now says so. |
| Companies list | 1,000 | 230 fits. |

The cap is a **rendering budget**; the `total` is the correctness mechanism. The
metadata rides the same React Query cache entry as the list (two `select`s over
one `queryFn`), so the banner costs no extra fetch.

Tasks and the activity feed keep their own caps and are **not** covered by this —
neither is a migration-scale population today.

## 3. Runbook — chunked import

1. **Decide what actually needs to come across.** If most of the 10k deals closed
   years ago, importing only open deals plus the last 1–2 years of won/lost
   halves the work. A business call, and the cheapest lever available.
2. **Build three export views in Freshsales** (Companies / Contacts / Deals) with
   *Manage Columns*. See §4 for which columns. **The record Id is not included by
   default — add it manually.** It is *required* for deals.
3. **Split each export into ~5,000-row chunks.** Deals ≈ 2 files, contacts 1,
   accounts 1.
4. **Import companies first**, then contacts, then deals. Not strictly required
   (the importer find-or-creates companies named in a contacts/deals CSV), but it
   keeps the reports clean.
5. **Set the date format and the pipeline** in the deals dialog (§4).
6. **Dry-run every chunk before writing.** The report is the test: created /
   updated / enriched / kept-local counts, **unrecognized columns**, the **date
   echo**, stage mappings, event matches, unmatched/ambiguous owners, unknown
   deal types, and per-row errors.
7. **Re-running a chunk is safe.** `decideImportAction` upserts on `externalId`;
   a record edited in EA-SYS after its last import is reported as *kept-local*
   and left alone.

## 4. Field mapping

### The structural fact

There is no fixed "Freshsales export format": the exported columns are **whatever
is in the view you export from**, and the record ID is not included by default
([Coefficient](https://coefficient.io/how-to-import-and-export-freshsales-data),
[Freshworks Community](https://community.freshworks.com/freshsales-11250/export-contacts-accounts-or-deals-to-csv-in-freshcrm-20619)).
Our side resolves every field through a **synonym list** against normalised
headers, and any column nothing claims is **reported, not silently dropped**
([`freshsales-import.ts`](../src/crm/lib/freshsales-import.ts)).

### Dates — declared, never guessed ✅

The importer used to call `new Date(cell)`, which applies V8's US-centric lenient
parser. Measured:

```
05/03/2026  ->  2026-05-02        (5 March read as 3 May, then TZ-shifted)
25/03/2026  ->  INVALID -> undefined
2026-03-05  ->  2026-03-05        OK
5 Mar 2026  ->  2026-03-04        (local midnight, off by one in UTC)
```

On a day-first export that made days 1–12 of every month the **wrong date** and
days 13–31 **vanish** — and a vanished close date on a won deal fell through to
`?? new Date()`, stamping the import date, so historical wins became "won today"
and a won-in-July report returned zero.

Now: the format is **declared** in the dialog (ISO / DD-MM / MM-DD), parsed
strictly, dates anchor to **UTC midnight**, rolled-over dates (`31/02`) and
2-digit years are refused, and a value contradicting the declared format is a
**row error**. ISO is accepted under every format because it is unambiguous.

Auto-detection was considered and **rejected**: scanning for a day > 12 works
right up until a file where every date falls on the 1st–12th, at which point it
guesses — and a guess that is usually right is exactly this failure mode.

**The dry run echoes the first parsed date** (`05/03/2026 → 5 Mar 2026`). Both
orders parse cleanly for days 1–12, so counts alone can never reveal a wrong
pick; the echo is the only thing that can, and it lands before any write.

An undated won/lost deal now keeps `wonAt`/`lostAt` **NULL** and is reported. It
correctly drops out of date-ranged reports instead of landing in the wrong
bucket — an unknown date is not today's date.

### Owners — email, then an unambiguous name ✅

Contacts had **no owner field at all**; deals matched on email only, and a
Freshsales view renders *Sales Owner* as a display **name**. One shared resolver
now does email → unambiguous name for both. An **ambiguous** name (two "John
Smith"s) assigns nobody and is counted — picking the first would hand one rep's
book to another, and unlike a blank owner that is not visibly wrong. Still
role-bound to `CRM_OWNER_ROLES`; on update an unmatchable owner never un-owns a
live record.

### Everything else that was being dropped ✅

| Field | Behaviour |
|---|---|
| Contact `lifecycleStage`, `status` | Coerced case/punctuation-insensitively onto our enums. An unrecognised label leaves it **NULL and reported** — defaulting every unknown to `NEW` would silently rewrite the pipeline's shape. |
| Deal `dealTypeId` | Matched by name against the org's own types. Unknown → untyped + named in the report ("add it under Manage deal types and re-import"). |
| Deal `tags`, company `phone` + `tags` | Now mapped, through the same normalizer contacts use (so "Renewal" and "renewal" can't become two tags). |
| Lost reason | Gained `dealreason` + `reasonforloss` synonyms — the API field is `deal_reason_id`, so the column may well read "Deal Reason". |
| Deal `pipeline` | **Deliberately NOT a CSV column.** `CrmDealPipeline` is our own two-value classification and a Freshsales pipeline *name* cannot be mapped onto it without a translation table nobody has — so the operator picks one **per file** in the dialog. Split the export if the deals differ. |

## 5. The one thing still outstanding: a sample export

Export **5 rows** from each of Deals / Contacts / Accounts with the columns you
intend to use, and read the header line plus one data row. That answers the only
open question left — **which synonyms your views actually need** — and confirms:

- the **date cell format** (so the picker gets set correctly first time),
- whether an **owner email** column exists, or the name fallback carries it,
- the **Lost Reason** label,
- anything else landing in *unrecognized columns*.

Adding synonyms is additive and cheap. Running the sample through the dialog's
**dry run** answers the same question from the other side: it prints unrecognized
columns, the date echo, and the owner/deal-type mapping counts before anything
writes.

## 6. Deliberately not built

- **Jobified import.** Would remove the 60s ceiling entirely and allow
  one-file-per-entity, at the cost of a job table, progress and resume. Chunking
  at 5,000 was chosen instead (owner decision, 10 Aug).
- **Batched writes.** Faster, but loses per-row error isolation. See §1.
- **Board virtualisation.** Would let the deals cap rise past 2,000. Filters plus
  an honest banner were judged the better answer for a kanban surface.
- **A Freshsales-pipeline → `CrmDealPipeline` mapping UI.** Per-file selection
  covers the realistic case; revisit if an org genuinely mixes both in one export.

---

## Sources

- [Coefficient — How to import and export Freshsales data](https://coefficient.io/how-to-import-and-export-freshsales-data)
- [Freshworks Community — Export contacts, accounts or deals to CSV](https://community.freshworks.com/freshsales-11250/export-contacts-accounts-or-deals-to-csv-in-freshcrm-20619)
- [Freshworks CRM API reference](https://developers.freshworks.com/crm/api/#deals)
- [Freshsales — Importing records](https://crmsupport.freshworks.com/support/solutions/articles/50000002586-how-to-import-records-contacts-accounts-deals-from-a-csv-xlsx-file-)
- [Freshsales — Expected behaviours (date formats)](https://support.freshsales.io/support/solutions/articles/50000004243-expected-behaviours)
