# Budget history, comparison and drafting (plan)

**Status:** PLANNED, NOT BUILT. First written Sep 28, 2026 at the owner's request ("plan budgeting AI that can
use past budgets data to create an optimized budget and also say what improved, increased or regressed
between budgets; users will upload CSVs of the past budgets"). **Rewritten Sep 29, 2026 after an adversarial
review** (3 BLOCKER, 10 HIGH, 12 MED, 8 LOW; the record is section 9). The review's main finding reshaped
the plan: the risk is in the past data, not in the AI, so the AI moves to the last stage and never produces
an amount.

**What it will do, in the end:** load past event budgets, compare events category by category, and pre-fill
a new event's budget from what similar past events cost, with the source of every figure shown. The draft is
an ordinary budget draft and still goes to the budget approver.

It is the build plan's Phase 4 archive loader and Phase 6 benchmarks
([BUDGET_PROCUREMENT_BUILD_PLAN.md](BUDGET_PROCUREMENT_BUILD_PLAN.md) sections 8 and 9), staged and joined.

---

## 1. The stages

| Stage | What | AI | Gate to start |
|---|---|---|---|
| **0** | Real sample files and written definitions | none | owner and finance |
| **1** | Load past budgets into a versioned archive; compare events | none | stage 0 done |
| **2** | A draft budget calculated by code, created in one step | none | stage 1 checked against finance's own spreadsheet on 3+ events |
| **3** | AI: sort unmatched lines into categories; write the comparison summary | narrow | enough history with real spend (at least 5 events per event type); the AI data agreement in place |

Each stage is useful alone, and each is a stopping point. Stage 1 answers "what increased, what improved,
what regressed between budgets" without any AI.

---

## 2. Stage 0: before any code (hard gate)

1. **Two real files per source system** from finance: ProcurementExpress export, QuickBooks P&L by Class,
   and the Excel sheets used today. The importer is designed against these files, not against guesses.
2. **Written definitions**, agreed with finance:
   - **Attendance** means checked-in delegates excluding faculty: the figure EA-SYS already records at
     close-out (`recordedAttendance`, budget-service.ts). Every past event's attendance is captured with its
     basis (checked-in, registered, badges), and only checked-in figures are used for per-head numbers.
   - **VAT:** the module is ex-VAT. Each file states whether its amounts include VAT and at what rate
     (UAE 5%, KSA 15%); code converts to ex-VAT.
   - **Evidence types:** *planned* (what was budgeted), *committed* (orders raised), *actual* (what was
     paid, from accounting). Every number shown says which one it is.
3. **Who loads history:** admins, super admins and the settle holder (see section 6).

---

## 3. Stage 1: load and compare, no AI

### 3.1 Loading past budgets

**Two ways in, same result:**
- The operator script the build plan already names, `scripts/load-event-archive.ts` (dry run by default,
  `--write` to save, run through `docker exec ea-sys-worker npx tsx`), for the first bulk load.
- An **admin-only upload page** (Budgets, Past budgets) for later files.

**Upload flow:**
1. **Upload** as multipart (10 MB ceiling), not JSON: the existing procurement imports post JSON under a
   1 MB body cap (`budget-schemas.ts`, `body-limits.ts`). Parsing and planning are pure functions (the
   `catalogue-import.ts` pattern), tested without a database.
2. **File handling:** detect the delimiter (comma or semicolon), decimal comma, a UTF-8 BOM, and bracketed
   negatives; refuse, with a clear message, an encoding that cannot be detected (Arabic Excel files are
   often Windows-1256; Arabic content is otherwise out of scope, build plan section 12). The row cap is
   raised above the parser's 5,000 for this importer only.
3. **Source shapes:** a QuickBooks P&L by Class has classes as columns, section headers and subtotal rows
   ("Total 500200"); it is unpivoted and its subtotal and header rows dropped, or totals would be counted
   twice. Each shape has its own tested adapter.
4. **Map columns once** per organisation and source system; the mapping is stored (a mapping table), so
   the next file from the same system maps itself.
5. **Map lines to categories, deterministically:** by account code (expense groups `5xxxxx` through the
   existing `accountGroupCode` rule; revenue accounts `430001` to `440011` by exact code), then by a
   catalogue product name or SKU, then by description-to-category pairs this organisation confirmed before.
   Whatever is left goes to an **Unmapped** bucket shown in the preview for a person to assign. No AI in
   stage 1. Charts of accounts other than MM Group's are out of scope for v1.
6. **Per line flags:** *bundled* (a hotel day-delegate package covering venue, F&B and AV, split by a person
   at import), *sponsor-paid or in-kind*, and *pass-through* (for example delegate hotel rooms billed on).
   Flagged lines are kept but excluded from per-head figures.
7. **Per event:** attendance and its basis, number of days, city, event type, brand, currency and the rate
   to AED with its date and source. Prefilled when the event code matches an EA-SYS event, and attendance
   from EventsAir where the event ran there. The rate is checked against a **per-currency** plausibility
   range: the module's current single band (2.5 to 8 AED, `money.ts`) would refuse KWD, BHD and OMR, which
   are GCC event currencies.
8. **Preview**, then **Save**.

**Staging between steps:** the parsed rows live in a short-lived, organisation-scoped staging batch
(expires after 24 hours), so a five-step flow does not depend on re-posting the file.

### 3.2 Storage

- **Keep the true source.** `EventFinancialSummary.sourceSystem` stays the real system (QUICKBOOKS,
  PROCUREMENTEXPRESS, EVENTSAIR, EA_SYS). A new `loadedVia` column says how it arrived (SCRIPT, UPLOAD,
  CLOSE_OUT). No `UPLOAD` source value.
- **Evidence, not overwrite.** Planned and actual usually come from different files; each file is its own
  **batch**, and the evidence types are kept side by side and merged when read. A new file for the same
  event and source **supersedes** the previous batch (kept, marked inactive), never deletes it.
- **New tables:**
  - `BudgetArchiveBatch`: organisation, source system, loaded via, file name, row counts, uploaded by,
    active flag, superseded by.
  - `BudgetArchiveLine`: organisation, batch, event summary, description, category code (or unmapped),
    evidence type, amount ex-VAT, currency, rate to AED, flags.
  - `BudgetImportMapping`: organisation, source system, column mapping, confirmed description pairs.
- **New columns on `EventFinancialSummary`:** `loadedVia`, `year` in the key (event codes are free text,
  build plan section 13), `days`, `city`, `attendanceBasis`, `rateToAed` and its date; the close-out also
  stamps the AED rate it used (today it sits only in the audit row).
- **The existing key** `@@unique([organizationId, sourceSystem, eventCode])` becomes
  `(organizationId, sourceSystem, eventCode, year)`.
- **Removing a bad upload:** a Delete action on a batch, with an audit row; the event summary is rebuilt
  from the batches still active.
- All additive and idempotent migrations. Each new table gets an RLS policy in `prisma/rls/procurement.sql`,
  an entry in `SWEPT_MODELS` in `scripts/check-tenant-als.sh`, and tenancy harness fixtures.

### 3.3 What EA-SYS's own history contains today

**`actual` is zero for every EA-SYS budget until the accounting read-back exists** (QuickBooks connection,
build plan Phase 3): `closeBudget` writes `actual` from `BudgetLine.actual`, which nothing fills yet. So an
EA-SYS close-out row is **committed** evidence (orders raised), never actual. The comparison uses, per
category and per event, the best evidence available and labels it: **actual** if loaded, otherwise
**committed**, otherwise **planned**. A row whose actual is all zero is never read as "cost nothing".

### 3.4 The comparison page

Pick two or more events. A new pure module (`src/procurement/lib/event-compare.ts`), with a table of
hand-calculated test cases, produces per category:

- the value of each event, with its evidence type;
- the change between events in value and percent;
- the change **per driver** (section 4.1), not only per head;
- variance against plan where both planned and actual exist;
- categories that are new, dropped, grew, shrank, or ran over plan in every event;
- the largest lines behind each change, ranked by amount within the category (version compare pairs lines
  by `lineKey`, which only works across versions of one budget, so this is new code).

Rules the test table pins: a category missing from an event is "not recorded", never zero; flagged lines
(bundled, sponsor-paid, pass-through) are excluded from per-driver figures; all amounts are ex-VAT in AED
at the stored rate.

**Access:** reading comparisons needs Budgets access **and** finance sight (the revenue precedent in
`agent-tools.ts`). **Export** goes through the shared CSV escaper (`toCsv` / `escapeCsvCell`), because
imported descriptions are untrusted text.

**Stage 1 exit:** finance checks the page against their own spreadsheet on 3 or more events after the 4GHH
pilot closes.

---

## 4. Stage 2: a draft calculated by code, no AI

### 4.1 Cost drivers

Not every cost grows with attendance. Each category gets a **driver**, with defaults finance can change:

| Driver | Categories (MM Group chart, defaults) |
|---|---|
| Fixed per event | Venue (5104xx), Technical and build-up (510300), Design (500300), CME management (500100), Licensing and permits (500800), Project overheads (510000) |
| Per attendee | Food and beverage (500500), Delegate management (500200), Giveaways (500600) |
| Per faculty | Speakers and faculty (510200), Hospitality (500700) |
| Per day | Events staff (500400) where paid by the day |

### 4.2 The baseline

1. **Comparable events**, suggested by event type, attendance, days, city and recency; the filters loosen in
   a stated order when too few match, and the page shows how many were used. **Fewer than 3 comparables:
   the page shows the range, and no single figure.**
2. **Per category:** each comparable's cost per driver unit, in AED ex-VAT, using the best evidence (actual,
   else committed, else planned, labelled); the **median**, with the minimum and maximum beside it; times
   the new event's driver quantity (expected checked-in attendance, days, faculty count).
3. **Inflation:** compounded per year between the comparable event and the new one, at a rate the user sets
   (default 0%).
4. **Flags are information only:** "ran over plan in 3 of 4 events" is shown, and the figure is not raised
   again (the median of actuals already includes past overruns).
5. **Contingency:** set explicitly on the draft with its reason, not left at the default 10% on top of
   actual-based figures.
6. **Lines:** code splits each category's baseline across lines by the past line mix (each past line's share
   within its category); one line per category when there is no line detail.

### 4.3 Creating the draft

- **One new service function** creates the budget, all its lines and the audit row in a single
  `tenantTransaction`, reusing the existing line totals and category checks. (The agent's tools add lines
  one at a time and `createBudget` refuses a second budget for the event, so a half-made draft would block
  a retry.)
- The draft records its sources: the comparable events and batches in the budget's notes, each line's
  reason in `BudgetLine.notes` ("median of HM2025 actual and EHBPU2025 committed, AED 1,150 per attendee,
  based on the upload of 12 Oct"), and a visible **Drafted from past events** mark so approvers know where
  the figures came from. Audit source `"draft"` is added beside `ui | mcp | agent`.
- It is an ordinary **DRAFT**: the author edits it and submits it to the budget approver as usual.

---

## 5. Stage 3: the AI, narrow

Only after stage 2 has run on real events, and only for two jobs. **The AI never produces an amount,
quantity, unit cost or percentage.**

1. **Sorting unmatched lines into categories**, after the deterministic matches in 3.1 step 5 have run.
   Its suggestion is shown for a person to confirm; a confirmed pair is remembered, so the next file needs
   the AI less. Its "confidence" is not trusted as calibrated.
2. **The comparison summary.** The model receives the computed table as data blocks with cell ids and
   writes text that **refers to cells by id**; code puts the numbers in. Output that is not valid against
   the schema, or contains any number or number word ("doubled", "a third"), is rejected whole and a plain
   templated summary is shown instead. The table is always shown beside it.

**Safety rules:**
- **The organisation's own AI key is required.** The shared credential resolver falls back to the platform
  key (`credentials.ts`); this feature refuses instead, and logs it.
- **An organisation-level opt-in** before any line description is sent, and the feature added to the
  vendor data agreement and retention items on the GDPR backlog (ROADMAP). The summary call sends only
  aggregated figures, never line text. Obvious personal names are masked before classification.
- **Prompt injection:** calls have no tools; file text goes in delimited data blocks marked as data; output
  is strict JSON with capped lengths, rendered as plain text, and never carries a URL.
- **Provider layer:** `src/lib/ai/` is streaming chat only today. Stage 3 either adds structured output to it
  (with a `budgetAi` feature slot and a stated provider rule) or calls the Anthropic SDK directly as the
  agent does. Decided at the start of stage 3.
- Rate-limited per user; every call logs tokens, duration and outcome.

---

## 6. Access

| Action | Who |
|---|---|
| Load or delete past budgets | ADMIN, SUPER_ADMIN, the settle holder, or a new permission `procurement.archive.manage` |
| Read comparisons | Budgets access **and** finance sight |
| Create a draft from past events | Budget authors (`canAuthorBudgets`) with access to the event |
| Stage 3 AI | as the action it serves, plus the organisation's opt-in |

Loading history changes the organisation-wide archive every draft reads, which is why it is admin-level (the
same reasoning made supplier CSV transfer admin-only). If the draft is ever offered to the agent or MCP, it
follows the in-app-door-only rule for writes.

---

## 7. Effort

| Stage | Effort |
|---|---|
| 0 | owner and finance |
| 1 | 2 to 3 weeks: three source adapters, staging, mapping storage, batches and delete, the comparison module and page, tenancy work, tests, a three-lens review, a browser pass |
| 2 | about 1 week: drivers, baseline, one-step draft, review screen, review |
| 3 | about 1 week, later: classification, placeholder summary, safety rules, a golden set for this feature |

**4 to 5 weeks in total**, spread out: stage 1 after the pilot's first real budget, stages 2 and 3 only when
their gates are met. Nothing here touches the approval flow.

---

## 8. Not in scope

Savings targets per category, revenue forecasting, live actuals from QuickBooks (the connector's own
phase), charts of accounts other than MM Group's, Arabic file content, and editing an archived line in place
(re-upload or delete the batch instead).

**Manual alternative, for the record:** finance can compare past events in Excel with a pivot table. Stage 1
is worth building when the same comparison is wanted repeatedly, per driver, across many events; the drafting
stages only once the history is real.

---

## 9. Review record (Sep 29, 2026)

Adversarial review of the Sep 28 version: 3 BLOCKER, 10 HIGH, 12 MED, 8 LOW. How each was handled:

| Finding | Handled in |
|---|---|
| B1 EA-SYS `actual` is always zero, so baselines would read "cost nothing" | 3.3 evidence order and labels |
| B2 the AI wrote quantities and unit costs despite the "no numbers" rule | 4.2 step 6 (code splits lines), 5 |
| B3 a second file for the same event overwrote the first; `UPLOAD` lost the source | 3.2 true source, `loadedVia`, batches |
| H1 linear per-head scaling of fixed costs | 4.1 drivers, 4.2 median and range |
| H2 overruns counted twice; default contingency on top | 4.2 steps 4 and 5 |
| H3 attendance defined differently per source | 2 definitions, 3.1 step 7 |
| H4 the credential resolver falls back to the platform key | 5 org key required |
| H5 finance data and names sent to the model; GDPR items open | 5 opt-in, aggregates only, masking |
| H6 prompt injection from CSV text | 5 safety rules |
| H7 draft created line by line; a failure blocks retry | 4.3 one transaction |
| H8 the AI layer is streaming chat only | 5 provider decision |
| H9 estimate too low; upload list, delete, mapping management missing | 3.1, 3.2, 7 |
| H10 building on unknown data before any real budget exists | 1 stages and gates, 2 |
| M1 more schema than "one enum, one table" | 3.2 |
| M2 GCC currencies outside the rate band; rate not stored on the summary | 3.1 step 7, 3.2 (rate stored per line and summary; per-currency plausibility checks) |
| M3 VAT basis | 2, 3.4 |
| M4 version compare does not pair lines across events | 3.4 new module |
| M5 revenue accounts need exact-code mapping; unmapped bucket; other charts | 3.1 step 5, 8 |
| M6 body cap, row cap, delimiters, encoding | 3.1 steps 1 to 3 |
| M7 no way to correct or delete a bad upload | 3.2 batches and delete |
| M8 uploading gated like authoring one budget | 6 |
| M9 the figure check cannot work on free text | 5 cell-id placeholders |
| M10 too few comparable events | 4.2 step 1 |
| M11 packages, sponsor-paid, pass-through, missing vs zero | 3.1 step 6, 3.4 rules |
| M12 state between upload steps | 3.1 staging batch |
| L1 tenancy guard list and harness | 3.2 |
| L2 CSV injection on export | 3.4 |
| L3 record the draft's sources and mark it | 4.3 |
| L4 audit source for drafts | 4.3 |
| L5 MCP write rule if exposed | 6 |
| L6 the `categoryTotals` comment disagrees with the stored shape | 3.4 module reads both; fix the schema comment when stage 1 starts |
| L7 EventsAir attendance ignored | 3.1 step 7 prefill from EventsAir where the event exists there |
| L8 deterministic matching before AI; AI confidence not calibrated | 3.1 step 5, 5 |
