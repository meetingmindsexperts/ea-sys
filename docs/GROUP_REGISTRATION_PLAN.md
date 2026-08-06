# Group Registration — plan of record (July 30, 2026; refreshed Aug 6, 2026)

> Owner request: a company rep ("coordinator", e.g. Krishna) registers first, can add
> **up to 50 registrations**, with a checkbox for **whether he himself is attending**
> (companies outsource this). He enters the full public-registration details for each
> person (incl. role), sees a **cumulative payment**, and receives a **consolidated
> single invoice** — all **linked to "Charge to another account"** (BillingAccount).
>
> Status: **PHASE 1 BUILT (Aug 6, 2026)** — schema + group create + pay-later +
> consolidated invoice + public flow + organizer enablement, live-verified on
> the local DB end-to-end (browser + API: 2 groups, correct totals/tiers/seat
> counters, invoice PDF emailed to payer+coordinator, member confirmations with
> the covered-by note, contact-only coordinator). Phases 2 (card payment) /
> 3 (My Group portal) / 4 (polish: organizer roll-up view, CSV group column)
> remain per §7. Key Phase-1 files: `src/services/group-registration-service.ts`,
> `src/lib/group-registration-settings.ts`, `createGroupInvoice` +
> `sendGroupInvoiceEmail` in invoice-service, the
> `group-registration-confirmation` system template,
> `POST /api/public/events/[slug]/group-register`, `/e/[slug]/group/register`,
> the Event Settings → Registration card, migration `20260806150000`.
>
> Status: **PHASE 2 BUILT (Aug 6, 2026)** — group card payment (Stripe checkout
> for the whole company + webhook settlement + invoice promotion). See §7 item 2
> for the shipped scope and the refund ruling. Phases 3 (My Group portal) and
> 4 (polish) remain.
>
> **Aug 6, 2026 refresh** (verified against the codebase; owner chose "refresh the
> plan, hold the build"): all referenced helpers still exist under the same names
> (`findOrCreateBillingAccount`, `claimSeats`/`claimSeat`/`claimEventSeats`,
> invoice-service, `ensureRegistrantAccount`). Three subsystem changes since July 30
> are folded in below — (a) the **Phase-2 tenancy sweep completed Aug 4**, so the new
> model/routes must ship with the full tenancy convention (see §3a); (b) **per-tenant
> Stripe keys** landed Aug 4 — `getStripe(organizationId)` is now async with an
> org→env fallback chain, and the webhook body was extracted into ONE dispatcher
> (`handleStripeEvent()` in `src/lib/stripe-webhook-handler.ts`) behind BOTH endpoints
> (`/api/webhooks/stripe` + `/api/webhooks/stripe/[orgId]`), so the group webhook
> branch lands exactly once (see §2/§4); (c) `Payment.organizationId` now exists
> (Registration-core sweep) — group Payment rows stamp it like member rows do.

---

## 1. Owner decisions (locked July 30, 2026)

| Decision | Choice |
|---|---|
| Payment | **Both** — one Stripe checkout for the cumulative total, OR pay-later (consolidated invoice → bank transfer, organizer records payment manually). |
| Payer details | **Coordinator enters them** in the public flow → `findOrCreateBillingAccount()` (exact-name reuse; near-duplicates created with `needsReview` for finance to merge — the machinery already exists and its comment anticipated exactly this). |
| Post-submission | **Full group portal** — coordinator account + "My Group" page: see members + payment status, ADD members later up to the cap, edit member details. |
| Pricing | **Per-person registration type** at the tier active at submission; cumulative total = Σ individual prices; invoice lines grouped by type ("2 × Physician, 2 × Nurse"). |
| Tier inventory | **A group BURNS the tier's seats** (owner ruling Aug 6, 2026 — review M4). The group door is public self-service, so a member priced at Early Bird claims an Early-Bird seat exactly like an individual public registration; a group that doesn't fit is refused whole ("Physician — Early Bird sold out"). Otherwise one large group drains the discount allocation invisibly and the tier never sells out for individuals. The **staff** manual-add courtesy-seat exemption is unchanged. |
| Link distribution | **One shared event link** — the organizer enables group registration, sets the member bounds, and copies ONE link (the proposer-link pattern) to send to company reps. No per-company invite tokens in v1. |
| Member bounds | **Organizer-controlled min AND max** (e.g. min 2, max 10): Krishna can register any group size within the range. Hard server ceiling 50 regardless of settings. |

## 2. What already exists (build on, don't duplicate)

- **`BillingAccount` + `EventBillingAccount`** — the payer entity, per-event attachment,
  `needsReview` dedup flag, `findOrCreateBillingAccount()` in
  [billing-account-service.ts](../src/services/billing-account-service.ts). The group's
  company becomes/reuses a payer; every member registration gets `billingAccountId` set,
  and the invoice bill-to rendering (payer name/address/VAT, attendee as reference line)
  already works.
- **`Registration.billingAccountId` / `payerReference` / `attendeeIsGuarantor`** — the
  per-registration payer linkage. `payerReference` = the PO/grant number field (offer it
  in the payer step).
- **Public register machinery** — full person field-set + role + per-type/tier pricing +
  tax math + atomic seat claims (`claimSeat`/`claimEventSeats`) + serial/qrCode minting +
  `ensureRegistrantAccount()` + confirmation emails.
- **Invoice service + PDF** — numbering, branding, tax, PAID promotion, bill-to-payer
  rendering. The confirmation-email param object is the exported
  `RegistrationConfirmationParams` type in [email.ts](../src/lib/email.ts) — the
  "suppress the pay-now block for group members" rule (§4) becomes a new explicit
  param on it, not a caller-side hack.
- **Per-tenant Stripe + the single webhook dispatcher (Aug 4, 2026)** —
  `getStripe(organizationId)` is **async** (org-key decrypt → env fallback; bounded
  TTL client cache), so the group checkout-session creation passes the event's org.
  The entire webhook event-dispatch body lives in `handleStripeEvent()`
  ([stripe-webhook-handler.ts](../src/lib/stripe-webhook-handler.ts)), delegated to
  by BOTH the legacy `/api/webhooks/stripe` and the per-org
  `/api/webhooks/stripe/[orgId]` endpoints — the group `checkout.session.completed`
  branch is written ONCE there and both entry points get it for free.

## 3. The structural gap (the heart of the build)

**`Invoice.registrationId` is a required FK to ONE registration** (and
`Payment.registrationId` likewise). A consolidated invoice/payment spanning N
registrations needs a new anchor:

```prisma
model RegistrationGroup {
  id                   String   @id @default(cuid())
  eventId              String
  organizationId       String?          // tenancy convention (denormalized, stamped at create)
  coordinatorUserId    String           // the REGISTRANT account that manages the group
  billingAccountId     String           // the payer — required (the whole point)
  coordinatorAttending Boolean  @default(true)
  createdAt / updatedAt

  event / organization / coordinator / billingAccount relations
  registrations Registration[]          // via Registration.groupId
  invoices      Invoice[]               // via Invoice.groupId
  @@index([eventId])
  @@index([coordinatorUserId])
}
```

Schema deltas (all additive / blue-green safe — `DROP NOT NULL` is instant in Postgres):

- `Registration.groupId String?` (SetNull) + `RegistrationCreatedSource.GROUP_REGISTER`
  (additive enum value).
- `Invoice.registrationId` → **nullable** + `Invoice.groupId String?` — app-level
  invariant: exactly ONE of the two is set. Group invoice line items are **derived at
  render time** from the group's member registrations (same as single invoices derive
  from theirs), grouped by ticket type.
- `Payment.registrationId` → nullable + `Payment.groupId String?` — one card settlement
  covers the whole group.
- ⚠ Sweep required: every reader of `invoice.registrationId` / `payment.registrationId`
  must null-guard (the compiler finds them once the schema changes). This is the risky
  part — budget review time for the Stripe webhook + invoice-service + reconciliation
  worker paths.

### 3a. Tenancy convention (added Aug 6, 2026 — the Phase-2 sweep is COMPLETE)

All 20 domains are swept, so a NEW domain must be born compliant rather than swept
later. Concretely for `RegistrationGroup` + the group routes:

- **`organizationId` stamped at create** (denormalized from the Event, the LoginEvent
  convention — the schema sketch above already carries it). Group `Payment` /
  `Invoice` rows stamp it too (both columns exist).
- **Interactive transactions use `tenantTransaction`**, never bare `db.$transaction`
  — the group-create tx, the invoice reissue/delta tx, the webhook PAID-promotion tx.
- **`runWithTenant(orgId, …)` wraps every new handler** (public group-register route
  after the `publicEventWhere` event resolution; the My Group routes; the organizer
  group routes) + the new route dirs go into `scripts/check-tenant-als.sh`'s
  `SWEPT_ROUTE_DIRS`/`SWEPT_ROUTE_FILES` so a dropped wrap fails CI.
- **RLS policy file** `prisma/rls/registrationgroup.sql` (flat
  `"organizationId" = current_setting('app.current_org', true)` policy, NO FORCE —
  the contact.sql shape) + tenancy-harness fixtures/assertions. Applied by the
  harness + the future platform bootstrap ONLY — **never a prisma migration**.
  Without a policy the table **fails closed** on the platform, so the policy ships
  in the same PR as the model.
- **Slug lookups** on the public group pages/routes go through `publicEventWhere`
  (the grep-gate `check-tenant-scoping.sh` enforces this).
- The **coordinator is a REGISTRANT (org-null)** — same identity seam as every other
  registrant; the group row itself is org-bound via the event. No new identity
  decisions needed here.

**Enablement + organizer controls**: `Event.settings.groupRegistration =
{ enabled: boolean, minMembers: number, maxMembers: number }` (settings JSON, no
migration; default disabled, defaults min 2 / max 10, hard server ceiling 50 — a
maxMembers above 50 is clamped). Managed from a **Group Registration card** on Event
Settings → Registration: enable toggle, min/max inputs, and a **"Copy group
registration link"** button (the proposer-link pattern). The link is **deliberately NOT
advertised on the public register page in v1** — "organizer controls sending" means
targeted distribution; a "show on the register page" discoverability toggle is a cheap
later add. Disabled event → the group page renders a branded "Group registration is not
open" state and the POST 403s (defense in depth, same shape as REGISTRATION_CLOSED).

## 4. Public flow — `/e/[slug]/group/register`

Entry: **link-only** — the organizer copies the URL from the Group Registration card and
sends it to company reps (not surfaced on the public register page in v1; see §3).

1. **Account** — email + password (reuses `check-email` + existing-account sign-in, like
   the submitter register). Coordinator = REGISTRANT (org-null), same
   `ensureRegistrantAccount` semantics.
2. **Coordinator details + "I am attending" checkbox** — full person form. If attending,
   these details become member #1 (their registration links `userId`, so it also shows in
   `/my-registration`). If not, the coordinator is contact-only (no registration row —
   just the group manager + invoice contact).
3. **Company (payer)** — name, contact, email, address, tax number, optional PO
   (`payerReference`). Submitted → `findOrCreateBillingAccount` + auto-attach
   `EventBillingAccount`.
4. **Members** — repeatable person form (full public field-set + role + per-person
   registration type at the live tier price). Live cumulative subtotal / tax / total.
   **Bounds enforced client + server**: submit blocked below `minMembers` (with copy
   naming the minimum) and above `maxMembers`; the server re-validates both (400
   `GROUP_SIZE_OUT_OF_BOUNDS` naming the allowed range) — a crafted request can't
   bypass the organizer's limits. (If the coordinator is attending, they count as a
   member toward both bounds.)
5. **Review + pay** — **Card**: one Stripe checkout session for the total (line items
   grouped by type; metadata carries `groupId`); **Pay later**: group created UNPAID,
   consolidated invoice emailed to the company + coordinator.

Backend `POST /api/public/events/[slug]/group-register` — ONE transaction: account
create/link → payer find-or-create → `RegistrationGroup` → N registrations through the
NORMAL creation machinery (per-type atomic seat claims, event-cap `claimEventSeats(n)`,
serials, qrCodes, `billingAccountId` + `groupId` + `createdSource: GROUP_REGISTER`,
attendee rows, `syncToContact` fan-out post-commit). Sold-out mid-group → whole
transaction rolls back with an error naming the type. Rate limits mirror the public
register (burst + sustained + per-email).

**Stripe webhook**: `checkout.session.completed` with group metadata → flip ALL member
registrations PAID + one group `Payment` row + promote the consolidated invoice PAID +
documents email. Idempotency keys on the group id. *(Aug 6 refresh: the branch is
written ONCE in `handleStripeEvent()` — `src/lib/stripe-webhook-handler.ts` — and both
webhook endpoints inherit it; checkout-session creation uses the async
`getStripe(event.organizationId)` so per-tenant Stripe keys apply automatically.)*

**Emails**: coordinator gets the group confirmation (member summary + consolidated
invoice/quote PDF). Each member gets their own confirmation **with barcode but WITHOUT
the pay-now block** (the company pays — members must never be dunned). Reuses
`sendRegistrationConfirmation` with the payment block suppressed for group members.

## 5. Group portal — "My Group"

Coordinator signs in → `/my-group` (or a group section on `/my-registration`):

- Members list: name, type, payment status, checked-in, barcode issued.
- **Add member** (until cap): same person form; seat-claimed atomically. Invoicing rule:
  consolidated invoice still UNPAID → cancel + reissue it covering all members; already
  PAID → issue a **delta invoice** for the additions (never mutate a paid financial
  snapshot).
- **Edit member details** — reuses the registrant self-edit field rules, ownership =
  `group.coordinatorUserId === session.user.id` (member registrations are editable by the
  coordinator even though `userId` is null on them).
- Payment status + Pay Now (card) for an unpaid group; download invoice.

## 6. Organizer surfaces (v1: minimal)

- Registrations list: **Group** column/badge + a **Group filter** (all / a specific
  group / non-group), so "show me all group registrations" is one click; members link
  to their group.
- A **Groups roll-up view** (a view toggle or tab on the registrations page): one row
  per group — company (payer), coordinator, member count vs allowed range, cumulative
  total, invoice/payment status, created date — with a detail expansion listing the
  members. This is the organizer's "see all the group registrations" surface.
- Registration detail sheet already shows "Billed to: <payer>" — add the group name line.
- Settings → Billing already surfaces `needsReview` payers for merge
  (`mergeBillingAccounts` exists).
- Cancel semantics: cancelling a single member releases their seat (existing machinery);
  cancelling the whole group = per-member cancel + invoice cancellation (organizer
  action; v1 can do this member-by-member).

## 7. Build order (each phase ships + gates independently)

1. **Schema + group create + pay-later** — migration, `RegistrationGroup`,
   `group-registration-service.ts` (the transaction), public flow pages, consolidated
   invoice (`createGroupInvoice` in invoice-service), emails, organizer Group column.
   *The null-guard sweep for Invoice/Payment.registrationId lands here — plus the
   full §3a tenancy package (org stamping, `tenantTransaction`, `runWithTenant` +
   CI-gate entries, the RLS policy file + harness assertions) in the SAME phase.*
2. **Card payment** — group Stripe checkout + webhook branch + PAID promotion.
   ✅ **BUILT (Aug 6, 2026).** `POST /api/public/events/[slug]/group-checkout`
   (one session for the whole company, charging the INVOICE snapshot rather
   than a fresh computation so the card statement and the document can never
   disagree; descriptive per-type lines only while they still reconcile);
   `handleGroupCheckoutCompleted` in the shared webhook dispatcher (ONE Payment
   row anchored to the group with `registrationId` null, N members flipped
   together, consolidated invoice PROMOTED — deliberately no second numbered
   document, since a group receipt would double-count in the AR ledger);
   `checkout.session.expired` releases only the members that session parked;
   `issuePaidGroupDocuments` in invoice-service. UI: the success card offers
   "Pay by card" on top of the invoice (the invoice is issued either way — a
   coordinator often isn't the person holding the company card), plus the
   Stripe-return states. **Refund policy (owner ruling, Aug 6): a refunded
   group payment is RECORDED and ALERTED, never auto-reconciled** — one charge
   covers N members, so "this was refunded" doesn't say which members lost
   their place, and guessing would either strand paid attendees or leave
   withdrawn ones holding badges. Full automated group refund reconciliation
   (incl. the partial "3 of 40 dropped out" case) remains unbuilt.
3. **Portal** — My Group page: view, add-member (+ invoice reissue/delta), edit.
4. **Polish** — organizer group sheet, CSV export group column, docs/user-guide.

## 8. Deliberately NOT in v1 (recorded so nobody builds them opportunistically)

- Group discounts / promo codes on groups (per-person tier pricing only).
- Member substitution self-service (organizer does it via the existing edit paths).
- Partial payments / per-member payment splitting (one payer, one total).
- CSV upload of members into a group (the 50-cap form is manageable; revisit if reps ask).
- MCP tools (`list_groups`, `create_group`) — fast-follow when an integration needs it.
- Multi-event groups (a group belongs to one event).
- **Per-company tokenized invite links** (Dinner-RSVP style: per-invite caps, pre-filled
  payer, sent/started/completed tracking) — owner chose the one-shared-link model for
  v1; invites are the natural v2 if companies need individually negotiated allowances.
- Public discoverability of the group link on the register page (toggle, later).

## 9. Risks / review focus

- The **nullable-FK sweep** (Invoice/Payment.registrationId) touches money paths — the
  Stripe webhook, invoice-service, refund/reconciliation workers. Every one needs the
  group-vs-single branch verified; this is where the adversarial review should aim.
  *(Aug 6: partially de-risked — the webhook dispatch is now single-sited in
  `handleStripeEvent()`, so the group-vs-single branch there is written and reviewed
  once instead of per-endpoint. The invoice-reconciliation + refund-reconciliation
  workers and payment-service remain the multi-site sweep.)*
- **Tenancy fail-closed** — a new table without its `prisma/rls/*.sql` policy is
  invisible under platform RLS; a new route without `runWithTenant` is the silent
  class the `check-tenant-als.sh` gate exists for. Ship the §3a package with Phase 1,
  not as a follow-up.
- **Seat-claim atomicity for N members** — all-or-nothing per group create; the bulk
  claim helpers (`claimSeats`) exist but the group path must compose type-claims +
  event-cap claim in one transaction.
- **Invoice reissue vs delta** on member additions — never mutate a PAID snapshot.
- Member confirmations must never render Pay Now (dunning the wrong party).
