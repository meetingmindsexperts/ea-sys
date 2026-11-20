# Abstract authors are not Faculty: registration and the Presenter mark

**Status: IN BUILD.** Steps 1, 2, 3, 4 and 4a built Nov 20, 2026; steps 5 to 8 not started. Owner, Nov 19, 2026. Amends decision D4 of
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

## 4. The approach: a few general tools, not a rule per case

Owner, Nov 20, 2026: "We cannot do each case independently, there will always
be one or the other edge case we would miss. What we need is generalist work
that is flexible enough to handle edge cases, even if it is done manually."

So this plan builds no machinery that knows about "a rejected physician" or
"a delegate who paid and then submitted". It builds three general things, and
every case in section 5a, and the ones nobody has thought of yet, is handled
with them by a person:

1. **Facts are read, never stored.** "Presenter" (has an accepted abstract),
   "author" (has an abstract), "faculty" (on the Faculty type or on the
   programme) are answered from the abstracts and sessions at the moment of
   asking. Nothing to keep in step, so nothing goes stale when an abstract is
   withdrawn or a decision reversed.
2. **Find anyone.** Registrations gets two more filters beside the ones it has
   (type, status, payment, tags, sponsor): **Abstract** (accepted, rejected,
   awaiting a decision, signed up but nothing submitted, no abstract) and
   **Speaker** (on the programme, a speaker record only, not a speaker). They
   combine: "rejected and owing", "accepted and not Complimentary", "a
   speaker, on a delegate type, owing".
3. **Do anything to the ones ticked.** Today's actions on ticked rows are
   Change type, tags, email, assign certificate. Added: **Set payment status**
   (Complimentary, or back to owing), **Set badge type**, **Cancel**. Each is
   the single registration's own rule run many times, never a second rule:
   what the sheet would refuse for one person (money paid, an invoice issued)
   is skipped and named in the result. And the registration sheet can do all
   of it for one person, Make Faculty included (step 6).

**The only things that happen by themselves** are the ones the owner asked
for by name: what sign-up creates (step 1), and the Complimentary offered when
an organiser accepts (step 4, a tick box, never silent). Every shortcut is a
preset of a general action ("Make presenters" = Set payment status
Complimentary + Set badge type Presenter on the Accepted filter), so a
shortcut can never do something the general action cannot undo.

**What stays hard, whatever is ticked:** money never disappears silently (a
paid registration is refunded first), seats move through the one planner,
Faculty is only for a registration that belongs to a speaker, and every action
is written to the history with who did it.

### The steps

Each step is its own commit, reviewed, deployable alone.

**Step 1. Abstract sign-up never creates a Faculty registration.** BUILT Nov 20,
2026 (`src/lib/author-rates.ts`, `presenter-signup.ts`). After its review: the
ordinary rate is only ever an open rate whose name is ticked for the main
Register link, and a registration type's own price is never offered, so an
event priced by type alone (no rates; one draft event on production) offers
authors nothing and the organisers give the registration.
Replace the D4 branch in `ensureSubmitterRegistration` with the outcome of P1.
Both doors are covered because both call it. Tests: an abstract sign-up on an
event without presenter rates creates no Faculty registration; a session
proposal is unchanged; staff adding a speaker still gets the Faculty companion.

**Step 2. The Abstract and Speaker filters on Registrations, and the Presenter
mark** on each row of an accepted author. BUILT Nov 20, 2026
(`src/lib/author-facts.ts`; the mark reads "Accepted presenter", because the
rate beside it is often named Presenter too). NOT built with it: the count of
accepted authors who have no registration at all. They are not rows of this
page; it belongs on the authors list of step 5. One shared reader answers "what is
this person's abstract outcome" for the filter, the mark, the count and the
Speakers page (step 5). Also a count: "Accepted authors without a
registration", so nobody arrives with no badge.

**Step 3. The general actions on ticked rows:** BUILT Nov 20, 2026
(`src/services/registration-bulk-service.ts`, `POST registrations/bulk-update`,
the "Payment, badge or cancel" button). A row with an invoice on it is
skipped and named, not cancelled-and-comped as A3 first said: the person
decides on its own page. Set payment status, Set badge
type, Cancel. Same permission keys as the single edit; the result names every
row skipped and why; no re-pricing (a registration keeps its rate, R1).

**Step 4. Complimentary offered at acceptance** (A1). BUILT Nov 20, 2026
(`src/services/presenter-service.ts`, `POST abstracts/make-presenters`; the box
is in Set status or type and in the list's status dialog, not yet on the
abstract's own page; it starts unticked every time). Where an organiser sets
Accepted (the abstract's page, the list's accept button, Set status on ticked
abstracts), a tick box: "Also make their registration Complimentary, with a
Presenter badge". Ticked, it runs step 3's actions for those authors and
reports who was skipped (already paid, no registration, sponsor-paid). Left
unticked, the team does it later from the Accepted filter. Its default (on or
off) is remembered per person, never forced.

**Run end to end on Nov 20, 2026** (a local test event, in a headed browser
against the local database; screenshots in `screenshots/2026-11-20-author-e2e/`):
nothing on sale, ordinary rates only, then presenter rates with Resident paid
(150) and Student free; eight sign-ups, an invited faculty member, a delegate
registered first, a desk payment, accept with and without the box, reject,
the filters, Make presenters from Registrations, a bulk cancel, the export.
It found two defects the unit tests and four reviews had not, both fixed
(`8eaa3550`): Make presenters from the Registrations page overwrote an invited
speaker's Faculty badge (the presenter rules now live in the bulk action's
preset, for both pages), and the Invited speaker filter missed an invited
speaker who had also submitted. Not covered by the run: the author signing in
and submitting through their own screens (abstracts were entered by staff),
any email actually arriving (the local server has no mail), and a refund.

**Step 4a. The abstract form does not ask a registered person for a rate** BUILT
Nov 20, 2026, with step 1. A new account cannot be told (a stranger typing an
address must not learn it is registered): they pick a type, and nothing is
created or charged.
(5a, T1): no type or rate step when they already hold a registration on the
event; a line says what they are registered as.

**Settled in the build, Nov 20, 2026 (reviews of `8eaa3550` and `54404a7a`):
how "invited" is told for someone who has submitted.** The organisers put them
on the Faculty type: a speaker the organisers added themselves (no sign-up
door on the record) whose registration is on Faculty, or a registration made
Faculty by hand (Add registration as Faculty, or Make Faculty; marked
`FACULTY_ADMIN`). Tried and dropped: the Faculty type alone (the old sign-up
gave every author one: 33 on MEHF2027, 2 on hemnet2026, who would have landed
on the Invited tab and in the certificates' default group); the sign-up door
alone (stamped on an invited speaker's record when they sign in to submit,
absent on a record staff made to enter an author's abstract); a place on the
programme (an accepted author given a talk is scheduled like any speaker).
With nothing submitted, the older rules stand. `speakerKindOf` in
`src/lib/speaker-kinds.ts` is the one rule; the Registrations filter asks it
with each row's own facts. Consequences: an invited speaker on a delegate
type who submits, and an invited speaker who signs in to submit (the door is
stamped), are listed as authors until Make Faculty is used on them, which on
a registration already on Faculty only confirms it. Leaving the Faculty type
clears its own "Faculty" badge.

**Step 5. The Speakers page keeps authors apart from invited faculty** (P4).
BUILT Nov 20, 2026. The tabs existed (Invited speakers, Abstract submitters,
Session proposers); what changed: someone who is both invited and an author is
listed with the invited speakers (on the Faculty type, as settled above), on
the page and in the certificate recipients' groups; the page opens on the
Invited tab when the event also has authors or proposers, and a search that
finds people on another tab says so; and a notice counts the **accepted
authors who hold no registration**, with "Show them" (it needs the
registrations key; an API key is never given the answer). Giving them one is
Add registration on Registrations, on their own type: the speaker page's
Grant button makes a Faculty registration and is not for an author.

**Step 6. Make a speaker's registration Faculty.** BUILT Nov 20, 2026
(`src/services/make-faculty-service.ts`, `POST registrations/{id}/make-faculty`,
the button beside the registration type on the sheet; keys
`speakers.companion.grant` and, on the event, `registrations.update`, so the
desk cannot). As planned below, with these settled in the build: the
registration is marked as made Faculty BY HAND (`FACULTY_ADMIN`), which is what
lists the person with the invited speakers, and means that moved back off
Faculty later it is a delegate with a seat again; the person is found by the
speaker record that points at the registration or carries its address, and
that record is then pointed at it; a fully refunded registration moves and
keeps saying Refunded; a sponsor-paid one, a group member and one with a card
checkout open are refused; the badge becomes Faculty where it was blank or
Presenter, and one the team chose is kept. On a registration ALREADY on the
Faculty type that the organisers did not put there (the old sign-up's, or an
invited speaker who signed in to submit) the button reads "Confirm as invited
faculty" and sets only the mark. The one known case, skourihadi73 on MEHF2027
(Physician, Complimentary, badge Faculty), can now be moved.
(Owner, Nov 20, 2026: built as part of this work, not ahead of it.)
For the person who submitted first and was invited later (section 4a). On
the registration sheet, a "Make Faculty" action, offered only for a registration
linked to a speaker record (`Speaker.sourceRegistrationId`), never for an
ordinary delegate. It moves the registration onto the event's Faculty type,
Complimentary, through the same seat planner as every type move (the Faculty
type holds no seat, so the delegate seat is released), and is audited. Money
follows P5. Moving back off Faculty is the existing Change type. Tests: a
registration with no speaker is refused; one with a payment is refused until
refunded; an owing one moves only with the confirmation; the speaker's badge
and barcode carry over.

**Step 7. Remove the presenter Pay Now switch.** BUILT Nov 20, 2026: the
switch, its reader (`presenter-registration-settings.ts`) and the email's Pay
Now branch are deleted; a `presenterRegistration` setting saved earlier is
read by nothing (no production event had it on). As planned:
Settings loses "Presenter
registration, Show Pay Now"; the reader (`isPresenterPayNowEnabled`) answers
no for every event, whatever an old setting says; the welcome email never
carries a Pay Now button. Paying later from the person's portal is untouched:
that IS the pay-later route. The user guide's paragraph on the switch goes.

**Step 8. The authors already on Faculty, and the words.** With steps 2 and 3
the 22 on MEHF2027 are a filter (Faculty type + has an abstract + not on the
programme) and a Change type; no list or script is built for them. The sign-up
page and welcome email say what the person registered as; CLAUDE.md, the user
guide, ROADMAP, CHANGELOG.

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

**P1. An event with abstracts but no presenter rates: what does sign-up create?** DECIDED Nov 20, 2026: (b). "Reg type as what they chose, badge also how it is currently": the registration is on the type the author picks, and the badge is whatever that registration gets today; Presenter goes on the badge only at acceptance.

What it is about: "presenter rates" are the special prices an organiser adds
under each registration type (Physician, Presenter, 400). Where they exist,
the abstract form asks the author for their type and creates a real
registration on it, to pay later. Where the organiser added none, the form
has no price to offer, and until now it gave a free Faculty registration
instead, which is what the owner has stopped. So something must take its
place. On production one upcoming event is in this state today (hemnet2026,
2 abstracts); MEHF2027 has rates.

- **(a) Nothing.** The author submits with no registration. After the
  decision, staff give one from the speaker's Grant button, or the author
  registers through the normal form. Cost: no badge or barcode until someone
  acts, and a different journey from an event that has rates.
- **(b) The same journey as an event with rates, at the ordinary price.** The
  form asks for their type and creates a registration on it at the delegate
  rate on sale that day (Early Bird now), to pay later, no Pay Now. Accepted:
  Complimentary. Rejected: they pay that rate, or the organiser cancels.
  Presenter rates then become what they are meant to be: an optional special
  price, not a switch that changes the whole journey. If no rate is on sale
  or the type is full, it falls back to (a) and says so in the log.
- **(c) A free registration on the type they pick.** A free place for every
  submitter, rejected ones included.
- **Recommendation: (b)** (changed from (a) on Nov 20, 2026, after the owner's
  model: "abstracts go through presenter registration"). One journey on every
  event, and the model's table in section 1 holds everywhere with no special
  case. Its cost is the one the owner already accepted for events with rates:
  a submitter counts as a delegate and holds a seat while awaiting a decision.

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

**P4. The Speakers page.** DECIDED Nov 20, 2026: "Absolutely, keep separate,
except for those who are invited and submitted, and submitted and later got
invited." The Speakers page shows invited faculty; people who are only
abstract authors are in their own list beside it (a tab, "Abstract authors").
Someone who is both appears with the faculty. To settle in the build: how
"invited" is told for a person who submitted first. Proposed: on the Faculty
type, or on the programme (a session or topic). An author the organisers have
decided to invite but not yet scheduled shows as an author until Make Faculty
is done, which is the action that says "this one is faculty".

**P5. Make Faculty on a registration with money on it.** DECIDED Nov 20, 2026:
as recommended below.

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

- **A1. Automatic, or one action by the team?** DECIDED Nov 20, 2026: both,
  the organiser chooses each time. When they mark an abstract Accepted they
  are offered "make the registration Complimentary now"; or they skip it and
  the team does it in bulk later (step 4). Worth knowing when ticking it: the
  author's portal shows Complimentary from that moment, before any
  announcement email, and un-accepting later does not take it back (A5).
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
  who set it. DECIDED Nov 20, 2026 (owner: "go with your recommendation"): it
  is also offered on ticked rows, as the general Set payment status action of
  step 3, since that same action is what Make presenters is made of.

### Never decided

- **N1. Signed up through the abstract door and never submitted anything:**
  13 people on MEHF2027 (9 free, 4 owing). They hold a registration like any
  delegate. Harmless here because the presenter rate equals the delegate rate;
  where an organiser sets the presenter rate BELOW the delegate rate it is a
  discount for anyone who opens the abstract form. DECIDED Nov 20,
  2026: they are treated as attendees, like any delegate: they keep the
  registration and pay the rate they registered on. The filter shows them
  under "signed up, nothing submitted".
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
