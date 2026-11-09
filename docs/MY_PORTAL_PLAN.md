# My portal: one place for a person's whole journey (Nov 9, 2026)

**Status: BUILT Nov 9, 2026, all five phases** (`71981b3e` phone layout,
`2504de88` sidebar + My certificates, `abf9d639` journey, `6a65c77e` Take
survey, `134a2e86` My abstracts). Not yet deployed at the time of writing.

Owner request (Nov 9, 2026): "under this one portal, I should see my entire
journey, if I completed surveys; in the sidebar, show collated certificates as
My certificates and My abstracts". Priority for the day.

## What the portal is today

- `/my-registration` lists every event a person is registered for, newest
  first, with each event's released certificates inside its card and a CME
  total when there is one (Nov 4, 2026). Each card links to
  `/e/{slug}/my-registration`, which stays the place to view, edit and pay.
- A **REGISTRANT** gets no sidebar at all (`computeSidebarNav` returns
  `hidden`). A **SUBMITTER** or **REVIEWER** gets Events + My registrations
  (+ My Reviews).
- **The dashboard shell has no phone layout.** The sidebar is a fixed 224px
  column at every width, so on a 390px phone `My events` is squeezed into a
  sliver and its buttons clip. Most people open the portal from an email on a
  phone.
- **Surveys are invisible.** Nothing says a survey is waiting or was answered.
- **Abstracts** are reachable only inside each event's dashboard Abstracts page.

Production on Nov 9, 2026 (read-only): 590 registrant and submitter accounts,
50 of them registered for two or more events; 120 people have abstracts, none
in more than one event; 15 active surveys, 13 of them certificate surveys; 108
survey responses in total.

## Decisions (owner, Nov 9, 2026: "go ahead", on these recommendations)

| # | Decision | Taken |
|---|---|---|
| D1 | A plain REGISTRANT gets a sidebar | Yes, holding only their own pages |
| D2 | Survey: status first, a "Take survey" button second | Yes, in that order |
| D3 | My abstracts matches submissions by the account link (`Speaker.userId`) only | Yes, never by email address |

## Shape

**URLs live under `/my-registration/`** (`/my-registration/certificates`,
`/my-registration/abstracts`). Every confinement rule already lets a signed-in
person into `/my-registration*` (the REGISTRANT redirect, `PERSONAL` in
`route-confinement.ts`, the middleware matcher), so the new pages need no
change to who may go where.

**Sidebar for portal people** (REGISTRANT, SUBMITTER, REVIEWER):

| Role | Items |
|---|---|
| REGISTRANT | My events · My certificates |
| SUBMITTER | Events · My events · My certificates · My abstracts |
| REVIEWER | My Reviews · Events · My events · My certificates |

My abstracts is listed for submitters, the role that submits. The page itself
works for anyone signed in and shows an empty state.

**My events** shows each event as a journey, one row of steps:

`Registered → Payment → Checked in → Survey → Certificate`

- Payment: Paid / Complimentary / Sponsored / Group invoice / Refunded /
  **Payment due** (computed with `readRegistrationBasePrice` +
  `computeRegistrationFinancials`, the event page's own money math). Never an
  amount: the event page shows the money.
- Checked in: done, or "At the event" for an upcoming event, or "Not checked
  in" once it has passed.
- Survey: shown only once the event has started, or once answered. One line
  per open survey: **Answered** or **Not answered yet**. The rule for
  "answered" is `hasAnswered`'s, applied in one batch (certificate survey:
  `surveyCompletedAt`; answer-once: any answer; daily: an answer today).
- Certificate: **Download** when one is released, else "Not issued yet".

Upcoming events and past events are split, upcoming first.

**My certificates**: every released certificate, grouped by year, CME totals
on top, a download each. Uses `findReleasedCertificates`, so the list cannot
show a certificate the download route refuses.

**My abstracts**: abstracts and session proposals linked to the account,
grouped by event, with number (A-001 / S-001), title, status and submitted
date, each linking to the event's existing Abstracts / Session Proposals page.

## Phases (each ships on its own)

| # | What | Risk |
|---|---|---|
| 0 | Phone layout: the sidebar becomes a slide-out menu below `md`; content padding tightens on a phone | Low. Changes the shell for every role on a phone, nothing on a desktop |
| 1 | Sidebar for portal people + My certificates page | Low. Reuses the certificate rule |
| 2 | Journey steps on My events (payment, check-in, survey, certificate) | Low. Read-only |
| 3 | "Take survey" button: an owner-only route that issues a fresh personal link | **Security-sensitive.** Owner check through `ownRegistrationWhere`, rate limited, adversarial review |
| 4 | My abstracts page | Low. Read-only |

### Phase 3 detail

`POST /api/registrant/registrations/[registrationId]/survey-link` with
`{ surveyId }`:

1. Signed in; the registration found through `ownRegistrationWhere(scope)`,
   status CONFIRMED or CHECKED_IN, event started.
2. The survey is this event's and open; not already answered (`hasAnswered`).
3. Mint through ONE helper extracted from `bulk-email.ts` (the two inline
   copies there move onto it), with the same revoke rules: a certificate
   survey link replaces the emailed one, a daily survey's earlier links keep
   working.
4. Rate limited per user; every refusal logged; returns the URL, the browser
   goes there.

A fresh link is minted per click rather than storing the raw token, which the
database never holds (only its hash).

## Out of scope

- Editing or paying from the portal: the event page stays that place.
- Abstracts matched by email address (D3).
- Reviewer feedback text on My abstracts: the event's Abstracts page shows it.
