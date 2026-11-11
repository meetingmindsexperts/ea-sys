# DTCM eTicketing: generating Dubai compliance codes inside EA-SYS

**Status: steps 0 to 5 BUILT (Nov 3 and 4, 2026), all checked against DET's
sandbox; the onsite desk's row since Nov 11, 2026 (§5.4). Step 6, retiring the
Laravel app, waits on one live Dubai event.** Owner decisions in §2. (This
line read "PLANNED, NOT BUILT" until Nov 11; §8 was always the truth.)

## 1. What exists today

Two systems, joined by a spreadsheet.

**EA-SYS** never makes a DTCM code. It receives them: the CSV import
(`/api/events/[eventId]/import/barcodes`) maps codes onto registrations, and the
spare pool (`src/lib/dtcm-pool.ts`, `DtcmCode`) hands leftovers to walk-ups. See
[DTCM.md](DTCM.md).

**The barcodes app** (`meetingmindsexperts/barcodes`, Laravel 12, separate box)
is where codes are actually made. Meeting Minds is already an accredited DET
seller (client `AMMEE1`), so there is no accreditation step left; this plan is a
port, not a new integration. The app:

- Reads a positional CSV exported from EventsAir (name, email, nationality,
  mobile, country code, section, price type).
- For each row runs four calls against the DET eTicketing API
  (`et-api.det.gov.ae`, UAT at `et-apiuat.detsandbox.com`):
  1. `POST /baskets` holding one seat (performance code + Area + PriceTypeCode)
  2. `POST /customers` returning `{ id, account, aFile }`
  3. `POST /baskets/{id}/purchase` with `MeansOfPayment: EXTERNAL`, returning `orderId`
  4. `GET /orders/{orderId}`, barcode at `orderLines[0].orderLineItems[0].barcode`
- On any failure after step 1, `DELETE /baskets/{id}` so the held seat does not
  count against the section ("Section soldout").
- Reads `GET /performances/{code}/map` and `/availabilities` for section capacity,
  holds and sold-out state, and to pair a section with its price types.
- Has an onsite page: EventsAir lookup, one barcode, written back to EventsAir.

Its invariants carry over unchanged, because they are about DET, not Laravel:

- **No automatic retries.** Every purchase is a real ticket; a blind retry buys two.
- **A registration that has a code is never bought again.**
- **Never log request payloads.** They carry the client secret and attendee PII.
- **One OAuth token per environment, cached until ~5 minutes before expiry,
  dropped on any 401.**

DET's collection also lists `POST /orders/{id}/reverse` (refund) and a partial
reverse. The Laravel app never calls them.

## 2. Owner decisions (Nov 3, 2026)

| # | Question | Decision |
|---|----------|----------|
| D1 | When is a code bought? | **Organiser button + desk.** A bulk "Generate DTCM codes" run 1 to 2 days before the event, plus one-at-a-time at the desk for walk-ups. Not on registration. |
| D2 | Where do credentials live? | **Per organisation, encrypted**, like Zoom: `Organization.settings.dtcm`, AES-256-GCM via `encryptSecret`. Staging/production toggle and a Test connection button. |
| D3 | A cancelled registration's order? | **Organiser action.** A card lists codes held by cancelled registrations with a Reverse button. Nothing reverses on its own (the code may already be printed; ROADMAP D-4). |

Consequences of D1 worth stating: a registration cancelled before the run never
costs a ticket, the public register path is untouched (no DET latency or
outage on the hot path), and mobile number does not have to become mandatory on
the public form. It is checked at generation time instead (§5).

## 3. Shape

```
Settings → Integrations → DTCM eTicketing      (org: credentials, environment)
Event settings → DTCM                          (performance code, type → section/price)
Registrations → DTCM card                      (pool level · Generate · Reverse · sections)
Check-in desk row / detail sheet               (Generate one)
                │
                ▼
src/lib/dtcm-eticket/client.ts   ← the ONLY code that talks to DET
src/services/dtcm-eticket-service.ts  ← intent rows, guards, Registration write
worker/jobs/dtcm-issue.ts        ← bulk runs, sequential
```

The CSV import and the spare pool stay exactly as they are. They are the
fallback for a DET outage on the day and for events whose codes someone else
issues.

## 4. Data

### 4.1 Credentials (no migration)

`Organization.settings.dtcm`:

```ts
{
  environment: "staging" | "production",
  production: { clientId, clientSecretEnc, apiKeyEnc, tokenUrl, baseUrl, paymentAmount },
  staging:    { clientId, clientSecretEnc, apiKeyEnc, tokenUrl, baseUrl, paymentAmount },
}
```

Secrets optional on update (blank keeps the stored value), same as Zoom. Never
returned by any GET; the GET returns `hasSecret: true`.

### 4.2 Event configuration

**Performance code: BUILT Nov 3, 2026.** `Event.dtcmPerformanceCode` (column,
migration `20261103100000`), set under Settings → Registration beside the DTCM
switch. Owner decisions: a column rather than settings JSON, and it is
**required while `requiresDtcmBarcode` is on**. The rule is
`resolveDtcmEventConfig()` in `src/lib/dtcm-performance-code.ts`, called by
every writer of the switch (event PUT, `createEvent()`, the agent's
`update_event`). It refuses only a CHANGE that leaves DTCM on without a code
(turning it on, or clearing the code); re-sending stored values is not one. So
the one production event that had DTCM on before the column existed keeps
saving every Settings tab, and its field shows as required until someone fills
it in. A "touched" rule blocked those tabs and was replaced after review. **A clone
starts with DTCM off and no code** (owner): a new event is a new DET
performance, so copying the code would buy tickets against last year's.

Section mapping, BUILT (step 2):
`Event.settings.dtcm = { sections: { [ticketTypeId]: { area, priceTypeCode } }, environment, performanceCode, checkedAt }`.

The section and price dropdowns are filled from the live performance map, so
nobody types an Area code. A ticket type with no mapping is not eligible for
generation, and the preflight says so. Only meaningful while
`Event.requiresDtcmBarcode` is on.

### 4.3 `DtcmOrder` (additive migration + RLS policy)

One row per purchase attempt. This is what makes "never buy twice" durable
rather than a hope.

| Column | Notes |
|---|---|
| `id`, `eventId`, `organizationId`, `registrationId` | tenant key stamped from the Event, per the RLS convention |
| `environment` | `staging` / `production`. A staging code must never reach a badge on a live event |
| `status` | `PENDING` → `PURCHASED` / `FAILED` / `UNCERTAIN` → `REVERSED` |
| `activeKey String? @unique` | `registrationId` while PENDING, PURCHASED or UNCERTAIN; null when FAILED or REVERSED |
| `basketId`, `orderId`, `barcode`, `area`, `priceTypeCode` | |
| `errorStage`, `errorStatus`, `errorMessage` | stage = token / basket / customer / purchase / order |
| `runId?`, `createdById`, timestamps | |

**Why `activeKey` and not a partial unique index:** Prisma cannot represent a
partial index (the CertificateIssueRunItem trap in CLAUDE.md, which already
breaks `db:push`). A nullable unique column gives the same guarantee, at most
one live order per registration, and Postgres treats NULLs as distinct so
failed and reversed rows pile up freely.

The intent row is inserted **before** the basket call. A second click, a second
desk station or a re-delivered job hits the unique violation and stops.

`DtcmIssueRun` (eventId, organizationId, status, counts, createdById) groups a
bulk run for progress, the same pattern as `CertificateIssueRun`.

## 5. Generating

### 5.1 Eligibility (one function, used by preflight, bulk and desk)

A registration is eligible when: the event has `requiresDtcmBarcode` and a
performance code; status is not CANCELLED; `attendanceMode` is IN_PERSON;
`dtcmBarcode` is empty; no live `DtcmOrder`; its ticket type is mapped; and the
attendee has first name, last name, email, a mobile number and a country that
resolves to ISO-2. Faculty are included (they need a code at the door like
anyone else).

The preflight returns counts per reason ("14 have no mobile number", "3 on an
unmapped type") with a link to the filtered list, so the organiser fixes data
before buying anything.

### 5.2 One purchase

```
insert DtcmOrder PENDING (activeKey = registrationId)   ← unique: stop if one exists
createBasket          → store basketId
createCustomer
purchaseBasket        → store orderId
getOrder              → barcode
tx: DtcmOrder PURCHASED + Registration.dtcmBarcode = barcode (only if still empty)
```

Failure handling:

- Fails **before** the purchase call: delete the basket, mark FAILED, clear
  `activeKey`. Safe to retry.
- Purchase call **times out or 5xxs**: we do not know if a ticket was bought.
  Do not delete the basket. Instead ask `GET /baskets/{basketId}` (Q3,
  verified in UAT, §10):
  - **Basket still there AND DET confirms deleting it** → the purchase did
    not happen and now cannot: mark FAILED, clear `activeKey`. Safe to retry.
    "Still there" alone is not proof, because our timeout can fire while DET
    is still committing the sale (review of step 3, HIGH 1); a delete that
    fails makes the order UNCERTAIN.
  - **`5001 Basket is not found`** → the purchase most likely happened (a
    purchased basket disappears; an unpurchased one only disappears on expiry).
    Mark **UNCERTAIN**, keep `activeKey`. DET has no "order by basket" lookup,
    so the order id cannot be recovered automatically. The DTCM card shows
    "Check with DET" and an organiser resolves it (paste the order id, from
    which the barcode is fetched, or mark failed).
  - The basket check itself fails → UNCERTAIN, same as above.

  The Laravel app treats every one of these as an ordinary failure and allows a
  retry, which is how a duplicate ticket happens.
- Purchase succeeds but `getOrder` has no barcode: PURCHASED with the order id,
  no barcode, flagged; a "Fetch barcode" action re-reads the order only.

Every failure logs `dtcm-eticket:<stage>-failed` with eventId, registrationId,
stage and HTTP status, never the body we sent.

### 5.3 Bulk run

Organiser clicks Generate on the DTCM card → preflight dialog → confirm with
environment shown in words ("This buys 412 PRODUCTION tickets") → `DtcmIssueRun`
created → `worker/jobs/dtcm-issue.ts` works it **sequentially**, one token, a
short pause between rows. The page polls run counts. No automatic retry;
"Retry failed" re-runs only FAILED rows.

Sequential is deliberate: the Laravel app's own known-limitations list says it
dispatches everything at once with no rate limit against DET. Four calls at
roughly 1 to 2 s each is about 5 s a person, so 500 people is about 40 minutes.
That is fine a day before the event and is why this is a worker job, not a
request.

**A run buys only what was confirmed** (review of steps 0 to 5, Nov 4). The
registrations and the section mapping the organiser confirmed are frozen on
the run (`DtcmIssueRun.registrationIds`, `.sections`). Nobody else is bought
for: not a later registrant, not someone whose phone was added later, not a
type mapped later. Each is tried once per run, so purchases never exceed the
confirmed count. If a confirmed type's section or price type changes, the run
stops. Each purchase re-reads its registration first, because the run's list
can be a tick old. Several runs share a tick fairly, least recently worked
first.

### 5.4 Desk

A Generate DTCM button on the desk row and the detail sheet, and offered after a
walk-in is created. Runs inline (one purchase, a few seconds). If DET fails, the
desk falls back to `claimSpareDtcmCode()` so the attendee still leaves with a
code, and the warning says which happened.

**As built.** The detail sheet got its button in step 3 (Nov 3). The onsite
desk (`/events/[id]/check-in/desk`) got its half on Nov 11, 2026, asked for by
the desk team:

- A row with no code carries a **No DTCM code** label (`deskRowNeedsDtcmCode`
  in `src/lib/desk-dtcm.ts`) and a **Get DTCM code** button, which opens a
  panel in the row (`check-in/desk-dtcm.tsx`). The panel is the sheet's own
  `DtcmDetControls`, so the button, an uncertain sale, a sale with its barcode
  unread and the pool fallback are one piece of code in both places.
- **On the panel DET leads; a spare code is the alternative** (owner, Nov 11):
  "Use a spare code" shows beside it while the pool has one, and is the only
  offer for a type with no DET section. No route changed: the desk calls the
  routes the sheet calls (the DET purchase and the pool, open to `dtcm.assign`
  with `barcode.view`; the registration save for "Use this code", which needs
  `registrations.update`; and the order route for an organiser at the desk).
  This is the panel's order only. A NEW registration still takes a spare by
  itself when the pool has one (`createRegistration`, since August), before
  the desk is asked anything, so an event meant to issue every walk-in from
  DET should import no spares; whether a mapped event should skip that
  automatic claim is an open owner decision (docs/ROADMAP.md).
- **A spare is never offered beside a live DET order** (`deskMayOfferSpare`,
  review of `243b7136`): not while a press here is in flight, not while DET
  shows a fresh PENDING order for the person (another desk, the bulk run, or a
  press whose answer a gateway timeout cut off; the panel then says to wait
  and offers Check again), not beside an uncertain or unread sale, and not
  until the DET read has answered. A spare taken in those moments leaves a
  bought ticket nobody holds. The pool route itself still does not know about
  DET orders, so the registration sheet keeps that gap (docs/ROADMAP.md).
  Second review round (of `db18801d`): the panel's read of DET is taken when
  it opens and does not poll, so it **asks again when the spare is pressed**;
  and after a press that got **no answer at all** it holds the spare for 45
  seconds (`UNANSWERED_PRESS_HOLD_MS`), because the server records a purchase
  only after its first call to DET. What is left is the moment between that
  read and the server recording a purchase started elsewhere: only the pool
  route can close it (DD-7).
- Opening the panel re-reads the desk's list, and a refused purchase re-reads
  the row, so a person another desk already coded stops being offered one.
- The desk's Edit dialog has a Mobile number field: DET refuses without one,
  and an imported attendee with no number was a dead end at the desk.
- **After a walk-in** that was registered and checked in, the walk-in route's
  `dtcm` answer is read (typed `ClaimDtcmOutcome`, pinned by a route test):
  left without a code, the desk says so and opens that row's panel on Get
  code from DET. A walk-in registered but not admitted (its payment or its
  check-in did not finish) gets the message too, since a desk role that
  cannot see codes has no label to go by, but its row is not opened on a
  purchase. Nothing is bought without a press (D1).
- A desk role that cannot see codes (MEMBER) gets no label and no button,
  since its rows carry no code to read; it gets the walk-in message, worded to
  ask an organiser.
- "Read barcode again" needs `dtcm.import`, so the shared controls now show it
  only to someone who holds it; desk staff are told to ask an organiser.
- Checked as an Onsite Staff account against DET's sandbox: one purchase from
  the desk row (order 68225, reversed afterwards), the spare alternative, a
  walk-in with an empty pool, and the two organiser-only states.

## 6. Reversing (D3)

The DTCM card shows "N codes held by cancelled registrations". Reverse calls
`POST /orders/{orderId}/reverse`, marks the order REVERSED, clears `activeKey`,
and clears `Registration.dtcmBarcode` only if it still equals that barcode.
Audited. Codes that came from CSV or the pool have no order and are listed
separately as "not ours to reverse".

Request shape, from DET's Postman template (the Laravel app never called it):
`POST /orders/{orderId}/reverse` with
`{ "Seller": <clientId>, "refunds": [{ "Amount": <paymentAmount>, "MeansOfPayment": "EXTERNAL" }] }`.
The refund amount mirrors the purchase amount, so `"0"` in production and the
staging amount in UAT. The template's `Seller: "ABART1"` is DET's sample
seller; ours is our own client id, as on the purchase. Partial reverse is
`POST /orders/{orderId}/{lineItemId}` and is not used (§9).

The template's customer body also lists optional `dateOfBirth`, `areaCode`,
`city` and `state`; the Laravel app sends only the required fields plus title,
and production accepts that, so the port does the same.

## 7. Permissions, limits, visibility

- New keys: `dtcm.generate` (bulk + desk), `dtcm.reverse`. Desk staff
  (ONSITE) get `dtcm.generate` on their assigned events only, through
  `gate.eventWhere`. `dtcm.reverse` is not a desk key.
- Credentials: the existing organisation settings key, never a desk key.
- Rate limits: bulk start 5 per event per hour; desk generate 60 per user per
  hour; Test connection 10 per user per hour. All 429s logged.
- The code itself stays behind `barcode.view` as today.

## 8. Build order

Each step ships on its own and is useful alone.

1. **Client + credentials. BUILT Nov 3, 2026.** `src/lib/dtcm-eticket/`
   (`client.ts`: token cache, map, basket create / exists / delete, customer,
   purchase, order, reverse; `credentials.ts`: per-environment encrypted
   storage in `Organization.settings.dtcmEticket`), `/api/organization/dtcm-eticket/{credentials,test-connection}`
   (`org.credentials`), and the "DTCM eTicketing (Dubai)" card in Settings →
   Integrations. **No availabilities call**: §10 showed it reports per price
   category and calls a sold-out section "Ok", so the section map is the only
   source. Vitest with `fetch` stubbed (no test reaches DET); verified in a
   browser against UAT: credentials saved through the card, test connection
   returned `PDUB01DEC2023B` with its nine sections, an unknown code was
   refused with DET's `2001 Performance is not found`. Nothing in EA-SYS calls
   the purchase functions yet; step 3 is the first.

   **Rules the review of step 1 left for steps 3 to 5** (Nov 3, 2026):
   - Branch on `DetApiError.outcomeUnknown`, never on `isNoResponse` alone. It
     is true for no answer, any 5xx (a gateway 504, or a 500 after DET
     committed) and a 2xx whose body was cut off, unreadable or missing its
     field. Each of those can mean the ticket WAS bought.
   - Every call on an existing basket or order passes the environment stored
     on its `DtcmOrder` row, never the organisation's active one. DET answers
     `4001` for another environment's order, so `reverseDetOrder` returns
     `"not-found"`, which is not proof of a reversal.
   - Saving credentials never switches the active environment (except the
     first save); switching is a separate, confirmed, audited action.
2. **Event config + sections view. BUILT Nov 3, 2026.** `Event.settings.dtcm`
   (`src/lib/dtcm-eticket/sections.ts`), written only by
   `/api/events/[eventId]/dtcm-eticket` (GET / PUT, `events.settings`,
   organisation members only) and added to the event edit's route-owned
   settings keys; not on the clone allow-list. Each registration type maps to
   a section and a price type of that section's category; every save is
   checked against DET's live map and records the environment and
   performance code it was checked against, and the card warns when either
   no longer matches. The "DET sections" card under the performance code
   shows each section's capacity and holds beside the registrations mapped
   into it that still need a code (in person, not cancelled or waitlisted,
   no DTCM barcode yet), flagging an over-full section. A stale mapping
   (other environment or code) can be re-checked and saved unchanged, and
   `isMappingCurrent()` in `sections.ts` is the server-side rule every
   purchase path uses to refuse one (review of step 2, Nov 3). "Sold out" is
   not shown because DET does not report it per section (§10); "generated by
   us" arrives with `DtcmOrder` in step 3. Choosing a section pre-selects its
   zero-priced type (the permit is paid in seats). Verified against UAT in a
   browser.
3. **`DtcmOrder` + desk generate. BUILT Nov 3, 2026.** Migration
   `20261103140000_add_dtcm_order` (enum + table, additive) and
   `prisma/rls/dtcmorder.sql`. `src/services/dtcm-eticket-service.ts` holds
   the rules of §5.2: `issueDtcmTicket()` (desk) over `buyForRegistration()`
   (which the bulk run will share), and `resolveDtcmOrder()` for the person
   who settles an UNCERTAIN or crashed-PENDING order ("found" with a DET order
   number, checked with DET first; "not bought"; "read barcode again"). The
   one eligibility rule is `src/lib/dtcm-eticket/eligibility.ts` (DET needs a
   phone number and a recognised country; the attendee's country is sent as
   both nationality and phone country, as the Laravel app did). Routes:
   `POST/GET /api/events/[eventId]/registrations/[registrationId]/dtcm-eticket`
   (`dtcm.assign` + `barcode.view`; falls back to a spare pool code only when
   DET definitely did not sell) and `PATCH /api/events/[eventId]/dtcm-orders/[orderId]`
   (`dtcm.import` + `barcode.view`). The registration sheet's DTCM box gets
   "Get code from DET" where the type is mapped and the mapping current, and
   shows an order that needs a person. Verified against UAT: a purchase put
   DET's barcode on the registration (order 68167); two simultaneous requests
   for one registration bought exactly one ticket (68168), the other stopped
   at the `activeKey` insert; a missing phone was refused before anything
   was written; an uncertain order was resolved as not bought from the
   sheet.
4. **Bulk run. BUILT Nov 3, 2026.** `DtcmIssueRun` (migration
   `20261103180000_add_dtcm_issue_run`, `prisma/rls/dtcmissuerun.sql`; one
   live run per event through `activeKey`; NO stored counters, progress is
   counted from `DtcmOrder.runId`; no stored list of people, each tick takes
   the next registration on a mapped type that this run has not tried).
   `src/services/dtcm-issue-run-service.ts`: preflight (to buy, not needed,
   skipped-and-why, per-section need against capacity), start (refused when
   a section cannot hold it, or when the confirmed count or environment no
   longer matches), cancel, and the tick, which buys through the desk's
   `buyForRegistration()` and stops the run on an UNCERTAIN purchase, DET
   unreachable, a stale mapping, a changed environment or code, or five
   non-sold-out refusals in a row; a `5005` sold-out section is skipped and
   the rest carries on. Worker job `dtcm-issue` (every 2 minutes on even
   minutes, 45-second budget; `src/lib/dtcm-eticket/issue-worker.ts` scans
   with `dbOperator` and works each run in its own lane). Route
   `/api/events/[eventId]/dtcm-eticket/run` (GET, `?preflight=1`, POST,
   DELETE; `dtcm.import`). The registrations page's "DTCM codes from DET"
   card. "Retry failed" is a new run: it only picks up people who still have
   no code. Verified against UAT: the preflight found 2 to buy, 2 coded, 2
   on an unmapped type; the run bought both (orders 68170, 68171, at DET's
   price) and completed; a second preflight found nobody. The sandbox run
   found that a run never completed while unbuyable people remained, fixed
   before commit. Review of step 4 (0 BLOCKER / 3 HIGH / 3 MED / 3 LOW),
   fixed: the confirmation also pins the performance code; an unexpected
   error mid-purchase, or a PENDING order a previous tick left (a worker
   restart during a deploy), STOPS the run; no new purchase starts after
   SIGTERM; the five-refusals rule counts across ticks from the run's own
   orders; WAITLISTED is refused by the shared eligibility rule (preflight and
   run agree); a run buys only for people registered when it started; a
   stale mapping stops the run instead of finishing it; sold-out is read from
   DET's code, not message text. Open for the owner: whether bulk purchase
   should have its own permission key (`dtcm.import` reads "load codes from a
   spreadsheet").
5. **Reverse. BUILT Nov 3, 2026.** `reverseDtcmOrder()` and
   `listUnusedDtcmOrders()` in `dtcm-eticket-service.ts`. Only an UNUSED
   ticket can be reversed (`unusedReason()`: its registration is cancelled or
   deleted, or carries a different code); one on an active registration is
   refused with STILL_IN_USE. Uses the order's own environment; DET's `4001`
   is reported, never taken as "reversed"; a lost answer is settled by reading
   the order back. The registration's code is cleared only if it is that
   ticket's barcode. Routes: `GET /api/events/[eventId]/dtcm-orders` (the
   unused list) and `PATCH .../dtcm-orders/[orderId] { action: "reverse" }`,
   both `dtcm.import`. The registrations page's "Unused DET tickets" card,
   shown only when there are some. Verified against UAT: a cancelled
   registration's ticket (order 68167) was listed and reversed, its code
   cleared and its slot freed; an active one's was refused. Review of step 5
   (0 BLOCKER / 1 HIGH / 1 MED / 5 LOW), fixed: a barcode on ANY active
   registration (a shared code) counts as in use, in the list and the
   reverse; the reversal's writes are one transaction, conditional on the
   order still being PURCHASED, and clear a code only from a still-cancelled
   registration; a "mark as reversed" action (checked with DET: the order
   must be gone) settles a row whose reverse was applied at DET but not
   recorded; the card shows even with DTCM switched off.
6. **Retire the barcodes app** after one live Dubai event runs on EA-SYS with the
   Laravel app on standby.

## 9. Not doing

- Buying on registration (D1).
- Reversing automatically on cancel (D3).
- Writing codes back to EventsAir. EA-SYS is the system of record now; the
  Laravel app's EventsAir push stays with the Laravel app until it is retired.
- Partial reverse (one admit per order, so it never applies).

## 10. Questions

Answered by the owner, Nov 3, 2026:

- **Q1. UAT account active, same `AMMEE1` client in production?** Yes, both.
- **Q2. Does DET whitelist caller IPs?** **Yes; each IP must be submitted to DET.**
  This is the gate on step 1: the EC2 box's outbound address must be on DET's
  list before any call from EA-SYS works, UAT included. The primary box's
  Elastic IP is **`3.108.247.193`** (`i-0b51ab1213d084640`, ap-south-1). The
  Singapore DR box has **no Elastic IP** (it is terraform-created and gets a
  new public address every apply), so it cannot be whitelisted in advance; a
  DR promotion on an event day falls back to the CSV import and the spare
  pool, which is acceptable. A reserved Singapore EIP would close that gap if
  it ever matters. Local development cannot reach DET unless
  the developer's IP is also listed, which is why the client is tested with
  `fetch` mocked and exercised against UAT from the box.
- **Q4. Billing.** Payment amount is **0 in production because the permit is
  paid for with its seat allocation**, not per ticket. So the cost of a
  wasted ticket is a seat out of the permit, not money, and the section
  capacity in the sections view (§8 step 2) is the real budget. The preflight
  shows remaining seats per section next to how many it is about to buy, and
  refuses a run that exceeds them.

### Verified against UAT from a developer laptop, Nov 3, 2026

One full cycle on DET's sample performance `PDUB01DEC2023B` (section SVIP2,
price type C "Comps", amount 0), then reversed. Nothing left held.

- **UAT is not IP-restricted.** It answered from an un-whitelisted laptop, so
  the client can be exercised locally against UAT. The whitelist (Q2) is a
  production gate only.
- **One API key per environment.** DET's Postman template carries two keys;
  the one on the token URL is "Developer Inactive" for every other call, the
  other works for the token and all calls. The Laravel app's single
  `api_key` is correct; the credentials form asks for one.
- **Q3 answered.** Before purchase, `GET /baskets/{id}` returns the basket.
  After purchase it returns `400 {code: "5001", "Basket is not found"}`. The
  order's `payments[0].id` equals the basket id, but there is no endpoint to
  find an order by basket. §5.2 uses this.
- **Q5 answered.** `eventsairid` accepts an arbitrary string (a cuid-shaped
  value was taken). EA-SYS sends the registration id.
- **Barcode** is at `orderLines[0].orderLineItems[0].barcode`, as the Laravel
  app reads it; in UAT it is a UUID. The line item also carries
  `seat.section`, `priceTypeName` and the customer id, worth storing.
- **Reverse:** `204` with an empty body, after which `GET /orders/{id}` is
  `4001 Order not found`. Reversing again also returns `4001`, so the client
  treats `4001` on reverse as "already reversed", which makes the action safe
  to repeat.
- **Category availability is not section availability.** `/availabilities`
  reported VIP "Ok" while section SVIP1 refused a basket with
  `5005 Section soldout`; SILVER sections refused with "Seats are invalid".
  The preflight therefore uses the map's per-section capacity and holds, and a
  `5005` during a run stops further rows in that section instead of burning
  through them.
- Latency: token ~0.4 s, every other call ~0.2 s from Dubai.

Still open:

- **Q6.** Is there a cap on open baskets per seller? Matters only for the
  bulk run, which holds one basket at a time anyway.
- **Q7.** Is a production barcode also a UUID? It decides whether the badge
  renders it as QR (current DTCM handling in `src/lib/barcode.ts`) or Code 128.

### Review of steps 0 to 5, Nov 4, 2026

An independent adversarial review (no context) found 0 BLOCKER, 1 HIGH, 4 MED,
6 LOW. Fixed in one commit, each with a test that fails without the fix:

- **HIGH 1.** A run was not held to its confirmation: the mapping and the
  candidates were re-read every tick. Frozen on the run now (§5.3).
- **MED 2.** A purchase used a registration read up to a tick earlier. It
  re-reads it before the intent row (rule 6 in the service header).
- **MED 3.** Reverse checked "in use" only before DET's call. The recording
  step asks again and reports `codeStillInUse` (logged at error, shown to the
  organiser) when the code went onto an active registration meanwhile.
- **MED 4.** "Mark reversed" skipped the in-use check, and an order did not
  record its DET client id. Both added (`DtcmOrder.detClientId`); reverse,
  mark-reversed and resolve refuse `CREDENTIALS_CHANGED` when the saved
  credentials are another client's. Rows from before the column are not
  checked.
- **MED 5.** One run took the whole tick. Each run now gets a fair share.
- **LOW 8.** Deleting an event cascaded its DET order rows away. The event
  DELETE refuses (409 `EVENT_HAS_DTCM_TICKETS`) while it holds PURCHASED,
  UNCERTAIN or PENDING orders.
- **LOW 11.** Reversing refetched the DET sections map (which can drop an
  unsaved mapping); resolving left the unused list stale. Both corrected.

Deferred until real production answers from DET are seen: **LOW 6** (resolving
by order number trusts a match when DET omits the customer, and does not
compare the performance), **LOW 7** (a price DET sends as a string reads as 0),
**LOW 9** (a basket call that times out may leave a seat held, unlogged).

Second round, on the fix commit itself (0214f336): 0 BLOCKER, 0 HIGH, 1 MED,
7 LOW. Fixed:

- **MED 1.** The start compared only the count, so the same number could hide
  different people or a remapped section. The preflight now returns a
  fingerprint of the people and sections, and the start refuses any other.
- **LOW 2.** A registration moved to another mapped type inside one tick was
  bought in that type's section. A run's purchase now refuses a type or section
  it was not confirmed for (`NOT_CONFIRMED_FOR_RUN`).
- **LOW 3.** A run with nothing frozen (older image, or created before the
  migration) reported COMPLETED. It STOPS.
- **LOW 4.** The delete guard counted sandbox tickets, so a test event could
  become undeletable. Production only now, with a DELETE_BLOCKED audit row.
- **LOW 7.** Twenty runs would each get two seconds and buy nothing. No share
  is below ten seconds; runs past what fits go first next tick.

Accepted, not fixed: the "code now dead" warning is a toast that does not name
the registration (LOW 5); a mark-reversed refused as in use can leave a
DET-reversed ticket recorded PURCHASED after a lost answer (LOW 6, narrow); the
in-use re-check is not locked, so a code typed in the same instant can still
be missed (LOW 8).

## 11. Related

[DTCM.md](DTCM.md) · `src/lib/dtcm-pool.ts` · `src/lib/zoom/client.ts` (the
credential pattern) · `worker/jobs/cert-issue.ts` (the run pattern) ·
the ROADMAP section on the DTCM spare pool's deferred findings.
