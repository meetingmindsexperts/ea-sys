# Group Registration — plan of record (July 30, 2026)

> Owner request: a company rep ("coordinator", e.g. Krishna) registers first, can add
> **up to 50 registrations**, with a checkbox for **whether he himself is attending**
> (companies outsource this). He enters the full public-registration details for each
> person (incl. role), sees a **cumulative payment**, and receives a **consolidated
> single invoice** — all **linked to "Charge to another account"** (BillingAccount).
>
> Status: **PLANNED — not built.** This doc is the blueprint + decision record.

---

## 1. Owner decisions (locked July 30, 2026)

| Decision | Choice |
|---|---|
| Payment | **Both** — one Stripe checkout for the cumulative total, OR pay-later (consolidated invoice → bank transfer, organizer records payment manually). |
| Payer details | **Coordinator enters them** in the public flow → `findOrCreateBillingAccount()` (exact-name reuse; near-duplicates created with `needsReview` for finance to merge — the machinery already exists and its comment anticipated exactly this). |
| Post-submission | **Full group portal** — coordinator account + "My Group" page: see members + payment status, ADD members later up to the cap, edit member details. |
| Pricing | **Per-person registration type** at the tier active at submission; cumulative total = Σ individual prices; invoice lines grouped by type ("2 × Physician, 2 × Nurse"). |

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
  rendering.

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

**Enablement**: `Event.settings.groupRegistration = { enabled: boolean, maxMembers: number }`
(settings JSON, no migration; default disabled, `maxMembers` default 50, hard server cap 50).

## 4. Public flow — `/e/[slug]/group/register`

Entry: a "Registering a group?" link on the public register page when enabled.

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
   Cap enforced client + server.
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
documents email. Idempotency keys on the group id.

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

- Registrations list: **Group** column/badge + filter (members link to their group).
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
   *The null-guard sweep for Invoice/Payment.registrationId lands here.*
2. **Card payment** — group Stripe checkout + webhook branch + PAID promotion.
3. **Portal** — My Group page: view, add-member (+ invoice reissue/delta), edit.
4. **Polish** — organizer group sheet, CSV export group column, docs/user-guide.

## 8. Deliberately NOT in v1 (recorded so nobody builds them opportunistically)

- Group discounts / promo codes on groups (per-person tier pricing only).
- Member substitution self-service (organizer does it via the existing edit paths).
- Partial payments / per-member payment splitting (one payer, one total).
- CSV upload of members into a group (the 50-cap form is manageable; revisit if reps ask).
- MCP tools (`list_groups`, `create_group`) — fast-follow when an integration needs it.
- Multi-event groups (a group belongs to one event).

## 9. Risks / review focus

- The **nullable-FK sweep** (Invoice/Payment.registrationId) touches money paths — the
  Stripe webhook, invoice-service, refund/reconciliation workers. Every one needs the
  group-vs-single branch verified; this is where the adversarial review should aim.
- **Seat-claim atomicity for N members** — all-or-nothing per group create; the bulk
  claim helpers (`claimSeats`) exist but the group path must compose type-claims +
  event-cap claim in one transaction.
- **Invoice reissue vs delta** on member additions — never mutate a PAID snapshot.
- Member confirmations must never render Pay Now (dunning the wrong party).
