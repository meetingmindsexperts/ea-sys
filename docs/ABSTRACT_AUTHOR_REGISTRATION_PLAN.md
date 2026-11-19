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

**Step 3. Presenter on the badge** (shape decided in P2).

**Step 4. The authors already on Faculty.**
A read-only list per event (name, email, abstract status, the registration's
payment status, whether they are on a session) for the team to decide each
person. The move itself is the existing bulk Change type, which moves a
registration OFF Faculty and keeps a Complimentary one free. No script writes
anything.

**Step 6. Make a speaker's registration Faculty.**
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

**Step 5. Copy and docs.** The sign-up page and welcome email say what the
person registered as; CLAUDE.md, the user guide, ROADMAP, CHANGELOG.

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

**P2. Presenter: a registration type, or a mark?**

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

**P3. A rejected physician on a Complimentary registration.**
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

- Changing presenter rates, the Pay Now switch, or what the welcome email
  quotes (August plan).
- Automatic moves on acceptance or rejection (D6 stands).
- Session proposals (unchanged since Aug 5).
