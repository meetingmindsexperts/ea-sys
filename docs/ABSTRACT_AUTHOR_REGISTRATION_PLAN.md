# Abstract authors are not Faculty: registration and the Presenter mark

**Status: PLANNED, not built.** Owner, Nov 19, 2026. Amends decision D4 of
[PRESENTER_REGISTRATION_PLAN.md](PRESENTER_REGISTRATION_PLAN.md); everything else
in that plan stands.

---

## 1. What the owner decided

> "We will stop putting [abstract submitters] under Faculty, as we agreed. Faculty
> is reserved for speakers, committee and so on."

The organisers' complaint behind it: a person who submits an abstract sees
**Faculty** as their registration type (portal, emails, badge) before anyone has
read the abstract. They are not faculty. Once accepted they are **presenters**,
and if rejected they are ordinary delegates.

### The owner's model (Nov 20, 2026)

> "Abstracts go through presenter registration, and we share the link by
> email, so why do they have to be Faculty? If they are accepted they can be
> presenters with badge and complimentary registration and everything. If they
> are not accepted, they attend by paying if [their type is] paid, if not, free."

In one table:

| The author's abstract is | Their registration |
|---|---|
| Not decided yet | On their own profession type, at the presenter rate they chose at sign-up; owing if that rate has a price, free if not |
| **Accepted** | Same type, **Complimentary**, badge **Presenter** |
| **Not accepted** | Same type; **pays** if it has a price, **free** if it does not |

This settles P2 (Presenter is a mark and a badge, not a registration type) and
P3 (a rejected author pays their type's fee). Section 5a lists the cases the
table does not answer.

**Presenter registration is always pay later (owner, Nov 20, 2026).** "We
don't offer Pay Now, we always suggest to pay later." The abstract sign-up
never shows or emails a Pay Now link; the fee is quoted and paid later, from
the person's own portal or offline, once the organisers have decided. The
August plan made this a per-event switch (Settings, Presenter registration,
Show Pay Now), off by default; it is off on all 30 production events that
carry the setting (read Nov 20, 2026) and step 7 removes it.

## 2. How a submitter ends up on Faculty today

Both abstract sign-up doors (`/submitter` for a new account, `abstract-start`
for a signed-in one) call `ensureSubmitterRegistration` in
[presenter-signup.ts](../src/lib/presenter-signup.ts). What it creates depends
on whether the event has **presenter rates** (pricing tiers named "Presenter…"
under each registration type, decision D1):

| The event has | The submitter gets |
|---|---|
| Presenter rates | They choose their registration type and rate on the form; a real registration on that type (`createdSource = PUBLIC_SUBMITTER`) |
| No presenter rates (D4) | A free **Faculty companion** registration (`SPEAKER_COMPANION`), exactly what an invited speaker gets |
| A session proposal (not an abstract) | Nothing is created; an existing same-email registration is linked (owner, Aug 5) |

D4 was chosen in August so that no event changed until an organiser set rates.
It is the only path that puts a submitter on Faculty.

**On production (read Nov 19, 2026):**

- MEHF2027 has presenter rates (Physician 400, Nurse 200, Allied Health 200,
  Resident and Student free), and presenter sign-ups began on Sep 26. Before
  that, the D4 path put **22 abstract authors (34 abstracts) on Faculty**,
  between Sep 1 and Oct 2. 20 of them are on no session; 2 are real speakers
  who also submitted.
- Since Sep 26: 94 `PUBLIC_SUBMITTER` registrations (83 Complimentary, 11 still
  owing).
- hemnet2026: 1 author on Faculty.
- Abstracts on MEHF2027: 165 submitted, 4 drafts, **none accepted yet**.

## 3. The rule from now on

- **Faculty** is for people the organisers invite: speakers, moderators,
  committee. It is never given for submitting an abstract.
- **Submitting** gives a real registration on the person's own profession type
  where the event has presenter rates, as today. Where it has none, see
  decision P1.
- **Presenter** is what an author becomes when their abstract is **accepted**.
  It is read from the abstract, not stored by hand (decision P2 on how it is
  shown).
- **Rejected** authors keep the registration they hold. A resident or student
  is already on their own free presenter rate, so they attend free with
  nothing moved. Whether a rejected physician pays is the organisers' call
  per person (decision P3).

## 4. The steps

Each step is its own commit, reviewed, deployable alone.

**Step 1. Stop the Faculty registration at abstract sign-up.**
Replace the D4 branch in `ensureSubmitterRegistration` with the outcome chosen
in P1. Both doors are covered because both call it. Tests: an abstract sign-up
on an event without presenter rates creates no Faculty registration; a session
proposal is unchanged; staff adding a speaker still gets the Faculty companion.

**Step 2. "Abstract" filter and marker on Registrations.**
A filter with: Accepted (presenters), Rejected, Submitted or under review, Has
no abstract; and a "Presenter" marker on each row of an accepted author. This
is what makes the announcement day two bulk actions instead of a hunt:
tick the filtered rows, then Change type (already built, see §6). Also a
count: "Accepted authors without a registration", so nobody arrives with no
badge.

**Step 3. "Make presenters"**: the bulk action on Registrations for ticked
accepted authors: Complimentary and badge Presenter, skipping and naming
anyone with money on their registration (5a, A1 to A3, A7, B1).

**Step 4. The authors already on Faculty.**
A read-only list per event (name, email, abstract status, the registration's
payment status, whether they are on a session) for the team to decide each
person. The move itself is the existing bulk Change type, which moves a
registration OFF Faculty and keeps a Complimentary one free. No script writes
anything.

**Step 4a. The abstract form does not ask a registered person for a rate**
(5a, T1): no type or rate step when they already hold a registration on the
event; a line says what they are registered as.

**Step 7. Remove the presenter Pay Now switch.** Settings loses "Presenter
registration, Show Pay Now"; the reader (`isPresenterPayNowEnabled`) answers
no for every event, whatever an old setting says; the welcome email never
carries a Pay Now button. Paying later from the person's portal is untouched:
that IS the pay-later route. The user guide's paragraph on the switch goes.

**Step 5. Copy and docs.** The sign-up page and welcome email say what the
person registered as; CLAUDE.md, the user guide, ROADMAP, CHANGELOG.

**Step 6. Make a speaker's registration Faculty.** (Owner, Nov 20, 2026: built
as part of this work, not ahead of it. Until then the one known case,
skourihadi73 on MEHF2027, stays Physician, Complimentary, badge Faculty.)
For the person who submitted first and was invited later (section 4a). On
the registration sheet, a "Make Faculty" action, offered only for a registration
linked to a speaker record (`Speaker.sourceRegistrationId`), never for an
ordinary delegate. It moves the registration onto the event's Faculty type,
Complimentary, through the same seat planner as every type move (the Faculty
type holds no seat, so the delegate seat is released), and is audited. What
it does with money is decision P5. Moving back off Faculty is the existing
Change type. Tests: a registration with no speaker is refused; one with a
payment is refused until refunded; an owing one moves only with the
confirmation; the speaker's badge and barcode carry over.

## 4a. One person, one registration: which one wins

A person holds one registration per event, and every path links the one that
already exists rather than making a second (`ALREADY_REGISTERED` is turned into
a link; the Grant button refuses a speaker who has one). So **the first
registration wins**, in either order:

| Order | Result |
|---|---|
| Invited as a speaker first, submits later | Their **Faculty** registration stays. The presenter rate picked on the form is never charged. Correct. |
| Submits first, invited later | The **sign-up registration** stays (e.g. Physician on the presenter rate, possibly owing). Adding them as a speaker again is refused (their speaker record exists from the submission); confirming the speaker settles only a Faculty registration; Grant refuses; the sheet refuses Faculty. **Stuck.** |

The second row is the case found on MEHF2027 on Nov 19, 2026
(skourihadi73@gmail.com: invited speaker, Physician, Complimentary, created
by abstract sign-up). Step 6 is the way out.

## 5. Decisions needed

**P1. An event with abstracts but no presenter rates: what does sign-up create?**

- **(a) Nothing, link only** (as session proposals since Aug 5). The author
  submits; once accepted, staff grant a registration from the speaker's Grant
  button. Simplest and honest. Cost: until granted, no barcode or badge; the
  step 2 count is the safety net.
- **(b) A free registration on the type they pick** at sign-up. Keeps everyone
  registered from day one, but it is a free delegate place for every submitter,
  rejected ones included, and they count as delegates while still pending.
- **Recommendation: (a).** It matches the proposals rule, gives nothing away
  before a decision, and every conference that takes abstracts can set
  presenter rates (MEHF2027 already has).

**P2. Presenter: a registration type, or a mark?** DECIDED Nov 20, 2026: (a),
a mark and a badge; the author keeps their profession type.

- **(a) A mark read from the accepted abstract**, on Registrations, the badge
  and the stats; the person keeps their profession type and their presenter
  rate (D1). Nothing to move when results are announced, and it can never be
  out of date when an abstract is later withdrawn.
- **(b) An ordinary "Presenter" registration type** the team creates and moves
  accepted authors onto with bulk Change type. Works today with no build.
  Cost: the profession is lost (the Physician and Resident counts no longer
  include them), the per-profession presenter fee is replaced by the Presenter
  type's own price (an unpaid one is re-priced on the move), and a withdrawal
  after the move leaves them on Presenter.
- **Recommendation: (a), with (b) left open** for an event that wants a
  separate Presenter fee.

**P3. A rejected physician on a Complimentary registration.** DECIDED Nov 20,
2026: a rejected author pays their type's fee (free types stay free). What is
left open is in 5a (R1 to R3).
Keep free, or set to the delegate fee? Per person or a rule? (D6 of the August
plan says nothing happens automatically; this plan keeps that.)

**P4. The Speakers page.** Abstract authors are speaker records (status
Invited), so the Speakers page lists them beside invited faculty. Separate
them there too, or leave the Speakers page as it is?

**P5. Make Faculty on a registration with money on it.**

- **No money** (Complimentary, or a free rate, nothing paid, no invoice):
  moves at once.
- **Owing** (Unassigned or Unpaid, an amount due): moves only after a
  confirmation that names the fee being waived ("Physician, Presenter, AED
  400 will no longer be owed"). An unpaid invoice on it is cancelled with a
  note, never deleted.
- **Paid, partly or in full**: refused until it is refunded (the existing
  refund and credit note flow), so a payment never disappears silently.
- **Recommendation: as above.** The alternative, keeping the payment on a
  Faculty registration, would leave money attached to a type every finance
  report treats as free.

## 5a. Edge cases the model does not answer

Read on production on Nov 20, 2026 (MEHF2027) where a number is given. Each
has a recommendation; the owner rules.

### When an abstract is accepted

- **A1. Automatic, or one action by the team?** Decisions are applied first
  and announced later, and an accepted abstract can be un-accepted (it has
  happened on production). If the registration turns Complimentary the moment
  the status is set, the author's portal shows it before the announcement.
  **Recommendation:** not automatic. On the Registrations page, filter
  "Accepted", tick all, one action "Make presenters" (Complimentary, badge
  Presenter), done by the team on announcement day.
- **A2. Already paid.** DECIDED Nov 20, 2026. Through presenter registration
  this should not arise: it never offers Pay Now. It can still happen two
  ways: the author paid later from their portal before the decision, or they
  registered and paid as an ordinary delegate and then submitted (T3). In both
  the owner's rule is **refund, then Complimentary**. Never automatic: Make
  presenters skips them and lists them; the team refunds through the existing
  refund flow (credit note first) and then sets Complimentary. None on
  MEHF2027 today (no payment, invoice or promo code on any of the 94 sign-up
  registrations). To check in the build: that a fully refunded registration
  can then be set Complimentary on the sheet.
- **A3. An invoice issued or a promo code applied, nothing paid.** The invoice
  is cancelled with a note, the code's use released; listed in the result.
- **A4. Several abstracts** (29 authors). One accepted is enough to be a
  presenter; the rest rejected changes nothing.
- **A5. Accepted, then withdrawn or the decision reversed.** Nothing
  automatic; the filter gets "Presenter with no accepted abstract" so the team
  sees them and decides.
- **A6. Co-authors** are names on the abstract, not accounts. Only the
  submitting author is a presenter. A co-author who will present instead
  registers as a delegate and the team makes them a presenter by hand.
- **A7. Sponsor-paid (Inclusive) or group registrations.** Left as they are:
  the fee is already covered and the sponsor's attribution must not be lost.
  They still get the Presenter badge.

### When it is not accepted

- **R1. Which price?** DECIDED Nov 20, 2026: the price stays at the rate they
  registered on. Someone who registered at the early bird rate pays the early
  bird rate, whenever they pay. (On MEHF2027 Presenter = Early Bird: Physician
  400, Nurse and Allied Health 200; Standard is 500 and 250.) Nothing to
  build: a registration keeps its rate, and no bulk action here re-prices.
- **R2. A rejected author who will not attend.** DECIDED Nov 20, 2026: the
  organiser cancels the registration; nothing is cancelled automatically.
  Until then it is an owing registration: counted as a delegate, holding a
  seat, chased by payment reminders. The filter "Rejected, owing" (step 2) is
  how the team finds them.
- **R3. Residents and students** are free either way on MEHF2027 (every rate
  is 0): nothing to do.

### A complimentary registration the team gives anyway

- **C1. The team sometimes makes an author Complimentary though the rule says
  they pay** (owner, Nov 20, 2026): a rejected author, one still under review,
  one who never submitted. Setting Complimentary on the registration sheet
  exists and stays the way. The rule this plan adds: **the system never undoes
  it.** Nothing here turns a Complimentary registration back into an owing
  one: "Rejected, owing" and every bulk action act on owing rows only, and a
  rejected author the team made free stays free. The history already records
  who set it. Open: whether the team needs it on ticked rows (many at once)
  or the sheet, one at a time, is enough.

### Never decided

- **N1. Signed up through the abstract door and never submitted anything:**
  13 people on MEHF2027 (9 free, 4 owing). They hold a registration like any
  delegate. Harmless here because the presenter rate equals the delegate rate;
  where an organiser sets the presenter rate BELOW the delegate rate it is a
  discount for anyone who opens the abstract form. **Recommendation:** treat
  as not accepted (they pay the quoted rate); show them under "No submitted
  abstract" in the filter.
- **N2. Still under review or revision requested when the event opens:** stays
  as at sign-up (owing or free); the desk handles it like any delegate.

### People with two roles

Invited faculty are added in either order (owner, Nov 20, 2026): before they
submit an abstract, or after.

- **T1. Added as faculty first, submits later:** Faculty stays (first
  registration wins, section 4a), badge Faculty; an accepted abstract adds
  nothing they do not have. **Two rough edges in the form today:**
  (i) on an event with presenter rates the abstract form still makes them
  choose a registration type and a presenter rate ("Physician, Presenter, AED
  400"), though nothing is created or charged and no fee email goes out; it
  reads as if they owe. The form already knows they are registered
  (`registeredHere`, used to skip the ID and document questions).
  **Recommendation:** skip the rate step for someone already registered and
  say "You are already registered for this event as Faculty. There is no fee."
  (ii) a speaker the organisers added has no account, so the form asks them to
  confirm their email before they can take over that speaker profile. That is
  deliberate (it stops someone else claiming a speaker), and stays.
- **T2. Submitted first, added as faculty later:** the stuck case. Their
  sign-up registration stays on the delegate type, possibly owing. Step 6,
  Make Faculty, on that person's registration sheet. Until it is built: set
  Complimentary and badge Faculty by hand (they still count as a delegate).
- **T3. Registered as a delegate first, then submitted** (14 on MEHF2027, all
  free so far). Their delegate registration is the one. DECIDED Nov 20, 2026:
  if they PAID as a delegate and are then accepted, the organisers refund them
  and make the registration Complimentary (the steps are in A2).
- **T4. A committee member or reviewer who submits:** Faculty stays, as T1.

### Around it

- **B1. Badge.** "Presenter" is set by the Make presenters action. A badge
  already printed says something else: the result lists who needs a reprint.
  The barcode does not change.
- **B2. The emails.** The acceptance email says the registration is
  complimentary; the rejection email says they are welcome to attend, the fee,
  and how to cancel. Both are template wording, checked in step 5.
- **B3. Counts.** A presenter stays a delegate on their own type in every
  count (decision D5 of the August plan); the Presenter mark is a filter and
  a figure beside it, not a separate bucket.
- **B4. Events with no presenter rates:** decision P1.

## 6. What exists and needs nothing

- **Bulk Change type** on Registrations (`registrations/bulk-type`): refuses
  Faculty as a destination, allows moving off it, keeps the price of a settled
  row (Complimentary stays free), re-prices only unpaid rows with no promo code,
  invoice or payment, and moves seats through the shared planner.
- **Grant registration** on a speaker (`grant-companion`): `payable` mode
  creates a real registration on a chosen type.
- **Presenter rates** (tiers per profession), the rate step on the sign-up
  form, and the fee in the welcome email (August plan, phases 1 to 3).

## 7. Foot guns

- **A forgotten grant (P1 a):** an accepted presenter with no registration has
  no badge or barcode at the door. The step 2 count must be on the page the
  team uses on announcement day, not in a report.
- **Moving off Faculty keeps the price.** A Faculty companion is
  Complimentary, so a rejected physician moved to Physician still attends free
  unless someone changes the payment (P3).
- **Seats.** A Faculty companion holds no seat; moved to a delegate type it
  claims one. Bulk Change type refuses the whole move if the type is full.
- **The two real speakers** among the 22 on MEHF2027 should stay on Faculty:
  step 4's list shows "on a session" so they are not moved by accident.
- **Staff-added speakers are unchanged.** Adding a speaker by hand, the speaker
  CSV import and the assistant's bulk speaker tool still create a Faculty
  companion; that is correct for invited faculty, but an abstract author added
  that way would land on Faculty again.
- **Emails already sent** (the welcome, a badge) said Faculty; nothing recalls
  them.
- **Make Faculty is a fee waiver in one click** (step 6). On MEHF2027 about
  100 speaker records are abstract authors on delegate types; the action must
  stay on the single registration sheet, never in a bulk tool, and the
  confirmation must name the amount.
- **An invited speaker who submitted first and owes a presenter fee** is not
  marked anywhere today (ROADMAP, the Nov 12 postmortem). Step 2's filter
  should be able to show "a speaker, on a delegate type, owing".

## 8. Not in scope

- Changing presenter rates or what the welcome email quotes (August plan).
- Automatic moves on acceptance or rejection (D6 stands).
- Session proposals (unchanged since Aug 5).
