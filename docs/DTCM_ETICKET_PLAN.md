# DTCM eTicketing: generating Dubai compliance codes inside EA-SYS

**Status: PLANNED, NOT BUILT (Nov 3, 2026).** Owner decisions in §2.

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

Section mapping, still to build:
`Event.settings.dtcm = { sections: { [ticketTypeId]: { area, priceTypeCode } } }`.

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
  - **Basket still there** → the purchase did not happen. Delete the basket,
    mark FAILED, clear `activeKey`. Safe to retry. This settles the common
    case (timeout before DET processed the request) with no human.
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

### 5.4 Desk

A Generate DTCM button on the desk row and the detail sheet, and offered after a
walk-in is created. Runs inline (one purchase, a few seconds). If DET fails, the
desk falls back to `claimSpareDtcmCode()` so the attendee still leaves with a
code, and the warning says which happened.

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

1. **Client + credentials.** `src/lib/dtcm-eticket/client.ts` (token cache, the
   four calls, map, availabilities, delete basket, reverse), Settings UI, Test
   connection against UAT. Vitest with `fetch` mocked; no test reaches DET.
2. **Event config + sections view.** Performance code, type mapping from the
   live map, a sections table (capacity / holds / sold out / generated by us).
3. **`DtcmOrder` + desk generate.** Migration, service, the desk button with
   pool fallback. Smallest path that buys a real ticket, so it gets the most
   scrutiny.
4. **Bulk run.** Preflight, `DtcmIssueRun`, worker job, progress, retry failed.
5. **Reverse.** Card + action.
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

## 11. Related

[DTCM.md](DTCM.md) · `src/lib/dtcm-pool.ts` · `src/lib/zoom/client.ts` (the
credential pattern) · `worker/jobs/cert-issue.ts` (the run pattern) ·
the ROADMAP section on the DTCM spare pool's deferred findings.
