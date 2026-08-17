# Speaker TBA on the programme

**Status: PLANNED, not built.** Owner asked for this on 2026-08-17 after an
organizer worked around it by creating a placeholder speaker.

A session on the public programme that has no speaker currently renders a blank
space. Attendees cannot tell whether the slot is still being filled or whether
the page is broken. This adds a derived **TBA** label so the programme says the
slot is real and a name is coming.

---

## 1. Decisions locked with the owner

| Question | Decision |
|---|---|
| Wording | **TBA**, not "To be announced" |
| Scope this round | **TBA only.** TBC (named but unconfirmed speaker) is deferred, see §7 |
| Organizer's own agenda | **No TBA on the cards.** A count note instead: *"2 sessions still need a speaker"* |
| Stored or derived | **Derived in code.** Nothing is written to the database |
| Constants | Yes, one shared definition of the label. **Labels only, not something an organizer attaches to a session** |

### Why derived and not a placeholder record

The organizer's workaround was to create a `Speaker` named `TBC TBC` and assign
it to a topic. It displays correctly, and the instinct is reasonable, but a
`Speaker` row is an identity rather than a label. That one row also produced:

- companion registration **#008**, CONFIRMED, badge type Faculty, with a minted
  entry barcode, so a physical badge reading "TBC TBC" would print and could be
  scanned at the door
- an email address of `r_casison@hotmail.com`, borrowed from a real person
  because `Speaker` is `@@unique([eventId, email])` and the form required one.
  Every speaker email for that event addressed to "TBC" reaches that inbox

It is also limited to one placeholder per event without inventing further
addresses, and each new one mints another phantom registration.

**The general rule: a placeholder is safe in a presentation field and dangerous
in an identity table.** The tell that a workaround is fighting the schema is
when it forces you to invent data the schema insists must be real.

Derived state has none of that. It needs no cleanup, and it disappears on its
own the moment a real speaker is assigned.

---

## 2. The rule

> For a session whose type is a **program** kind, if **no speaker is visible
> anywhere in that session**, render **TBA** in place of the speaker line.
> Additionally, for any **topic** with no speaker of its own, render TBA on that
> topic row.

Two parts of that wording are load-bearing, and both were established from live
data rather than assumed.

### 2.1 "Program kind", not `type === "SESSION"`

Use `SESSION_TYPE_KIND[type] === "program"` from
[session-enums.ts](../src/lib/session-enums.ts), which classifies SESSION,
WORKSHOP and SYMPOSIUM as program and REGISTRATION, BREAK, LUNCH, NETWORKING as
break.

**An equality check on `SESSION` would miss both slots that need TBA today**, as
both are Symposia (§3). This is the same trap the classification record was
created to prevent: `isBreakSessionType` once meant "anything that is not
SESSION", which would have silently reclassified Workshop and Symposium as
coffee breaks when they were added. A new session type must fail the build, not
quietly behave wrong.

### 2.2 "Anywhere in the session", not just session level

A session carries speakers in two places: session-level roles (`SessionSpeaker`)
and per-topic speakers (`TopicSpeaker`). TBA fires only when **both** are empty.

**Checking only session level would print TBA above a named keynote speaker.**
"Keynote Lecture" on EHS has zero `SessionSpeaker` rows and one topic that names
its speaker (§3).

### 2.3 Break items never show TBA

They are legitimately speakerless. They already render through a separate band
path on the public agenda, so they are structurally safe today, but the guard
and a test go in anyway so a later refactor cannot merge the paths and start
printing "Coffee Break: TBA".

---

## 3. Live state, verified read-only on prod 2026-08-17

Program sessions on PUBLISHED events with no session-level speaker:

| Session | Type | Session speakers | Topic speakers | Verdict |
|---|---|---|---|---|
| Keynote Lecture | SESSION | 0 | **1** | **Not TBA.** Speaker is named on the topic |
| Industry Symposium | SYMPOSIUM | 0 | 0 | **TBA** |
| Industry Symposium | SYMPOSIUM | 0 | 0 | **TBA** |

**Exactly two cards change.** All 26 topics across published events already carry
a speaker, so the topic-level TBA is a forward-looking safety net rather than
something that alters the current view.

Also relevant: `agendaPublished` is `false` on all 7 published events, so no
public agenda is live. This ships before first publication, not as a fix to
something attendees have already seen.

---

## 4. Surfaces

| Surface | Change |
|---|---|
| Public agenda [page](../src/app/e/%5Bslug%5D/agenda/page.tsx) | Session card speaker line and topic rows |
| Public session [page](../src/app/e/%5Bslug%5D/session/%5BsessionId%5D/page.tsx) | Speakers section and topic rows |
| Speaker emails, `{{presentationDetails}}` and `{{moderatorDetails}}` in [speaker-agreement.ts](../src/lib/speaker-agreement.ts) | The moderator run-sheet's "Presented by" column |
| Dashboard [agenda](../src/app/%28dashboard%29/events/%5BeventId%5D/agenda/page.tsx) | Count note only. No TBA on cards |

**Deliberately out of scope:** the registration-page
[speakers preview](../src/components/public/speakers-agenda-preview.tsx). It
renders a deduped photo grid of faculty across the whole event, not a per-session
line, and TBA has no meaning in a grid of people. It already hides itself when no
speakers exist anywhere.

### The run-sheet is the one that gets forgotten

A moderator's run-sheet lists each topic with who presents it. A blank cell there
reads as a mistake in a document handed to someone running a room. It should say
TBA for the same reason the web page does.

This is why the rule lives in **one shared helper** that every surface calls,
rather than in the agenda component. Put it in the component and the email drifts
from the web page the first time either is edited. That is the cross-caller
duplication rule.

---

## 5. Where the code goes

A small client-safe module, in the shape of the other label helpers
(`formatPersonName`, `session-enums`):

- `TBA_LABEL` and `TBC_LABEL` constants. One definition of the words, so a later
  wording change is one edit. `TBC_LABEL` is defined now and unused until §7.
- A predicate that answers "does this session need TBA?", taking the session type
  plus its session-level and topic speaker lists.
- A predicate for the topic-level case.

Pure functions, no database access, so they are unit-testable and safe to import
from a `"use client"` component. **No Node-only imports**, which would bundle as
`undefined` and fail silently at click time.

**No schema change. No migration. No data written.**

### The count note

The dashboard agenda already loads sessions with their speakers, so the count is
computed from data on hand. No new endpoint.

---

## 6. Tests

- The two live cases as fixtures: a Symposium with nothing (TBA) and a session
  with a topic speaker but no session speaker (**not** TBA)
- Every break type returns no TBA
- Workshop and Symposium **do** return TBA, mutation-verified: changing the
  predicate to `type === "SESSION"` must fail these
- Topic with no speaker returns TBA, topic with one does not
- The run-sheet renders TBA in "Presented by" for an unassigned topic
- The count note matches the number of sessions the predicate flags

---

## 7. Not in this round

### TBC is PARKED (owner, 2026-08-17)

Not deferred with intent to follow, **parked**. Do not build it without an
explicit owner go-ahead. The analysis below is kept so the work can start cold
if it ever un-parks.

`TBC_LABEL` stays defined in `session-enums.ts` and unused. It costs one line and
settles the wording, which was the only open question; it is not scaffolding for
imminent work.

---

**TBC, meaning a speaker who is named but has not accepted.** Derivable from
`Speaker.status === "INVITED"`, which no public surface currently reads, so an
invited speaker renders identically to a confirmed one. On the Hematology Summit
that is **29 of 34** session assignments.

Parked because it is the more sensitive half: it puts a real person's name on a
public page with a qualifier next to it, and the choice between hiding the name
and marking it is a judgement about how the organizer wants to market the
programme, not a technical call.

**The reason it is not urgent:** no public agenda is live, so those 29 names are
not on display today. The exposure only begins at Publish Agenda, and by then the
organizer may simply have confirmed them. Revisit if an agenda is published while
a material share of the faculty is still unconfirmed.

**A related item worth carrying forward:** one **DECLINED** speaker (Manuel
Algora) is still attached to a workshop on the Hematology Summit. A declined
speaker must not appear publicly at all, and specifically must not show as TBC,
which would claim we are still waiting on them. If that hiding is added later, a
session whose only speaker declined falls through to TBA on its own, with no
extra rule. The two behaviours compose, which suggests the logic is in the right
place.

**A tick box for "no speaker needed"**, for sessions that are speakerless by
design such as opening remarks or a poster viewing slot. Derived TBA would
wrongly promise a speaker there. Not built because no such session exists on any
current programme. Add it when one appears rather than guessing the need now.

---

## 8. Follow-up for the organizer, independent of this build

The `TBC TBC` speaker on EHS International Mental Health Conference 2026 should
be dealt with regardless of when this ships, because its side effects are live
today even though the agenda is not:

1. Repoint the email off `r_casison@hotmail.com` to an address MMG controls
2. Decide whether companion registration **#008** should exist, since it holds a
   Faculty badge type and a scannable entry barcode for a person who does not
   exist
3. Delete the placeholder once TBA ships
