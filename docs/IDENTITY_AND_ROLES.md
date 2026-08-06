# Identity & Roles — one person, many hats

> **Who this is for:** organizers running a real conference where the same human is often
> several things at once — a **committee member** who is also **faculty**, a **speaker**
> who also **registered as a delegate**, an **abstract submitter** who is also on the
> **review committee**. This explains what the system does automatically, what needs a
> manual step, and the one limitation to plan around.
>
> **TL;DR:** Everything at the *person* level (speaker record, badge, check-in, survey,
> certificate, abstract) stacks freely for one email — no duplicates, no conflicts. The
> only thing a person can hold **one of at a time** is a **login account role**
> (Reviewer *vs* Submitter *vs* Delegate/Registrant).
>
> **Scope — this is about participants, not staff.** Roles come in two classes:
>
> - **Staff** — `ORGANIZER`, `ADMIN`, `SUPER_ADMIN`, `MEMBER`, `ONSITE`. These run the
>   event. **An organizer is always an organizer** — staff are *never* speakers, reviewers,
>   or submitters. (The single-role login enforces the reviewer/submitter part: making a
>   staff member a reviewer/submitter would first strip their staff role, and the
>   self-register-as-submitter path returns 409 for an existing staff account.)
>   **One exception — attending:** staff *may* register as an **attendee** (to test the
>   registration flow, or to actually attend). This is safe and does **not** change their
>   role — the attendee registration is a separate facet, so an existing staff account is
>   *linked* to the registration, never downgraded to `REGISTRANT`. "Always an organizer"
>   still holds while they hold a test/real badge.
> - **Participants** — delegate (`REGISTRANT`), faculty (`Speaker`), abstract author
>   (`SUBMITTER`), review committee (`REVIEWER`). **The "many hats" overlap below is entirely
>   within this group.**

---

## 1. The mental model: two layers

EA-SYS models a human at an event as **two independent layers**. Understanding this split
resolves almost every "wait, can they be both?" question.

### Layer 1 — Facets (what a person *is* at the event)

These are event-scoped rows, glued together by **email**, and they **stack freely** — one
person can hold all of them at once with zero conflict:

| Facet | Row | Gives them | Needs a login account? |
|---|---|---|---|
| **Faculty / speaker** | `Speaker` (unique per `eventId + email`) | Listed on agenda, session assignments | **No** |
| **Attendee** | `Registration` + `Attendee` | Badge, entry barcode, DTCM barcode, check-in, survey, certificate | **No** |
| **Abstract author** | `Abstract` (requires a `Speaker`) | A submission in the review pipeline | Account to submit, but the row itself is facet-level |

**The key automation — the companion registration.** When you add a speaker, the system
auto-creates a comp "Faculty" registration so they get a badge, barcode, check-in, survey
and certificate — *the same machinery a delegate uses*. This is **idempotent by email**
([`speaker-companion.ts` → `ensureSpeakerCompanionRegistration`](../src/lib/speaker-companion.ts)):

- If that email **already has a registration** for the event (e.g. they registered
  themselves as a delegate first), the speaker is **linked to that existing registration** —
  **no second badge, no duplicate**.
- If the speaker already has a linked registration, it's a **no-op**.
- Only if neither exists does it create a fresh comp Faculty registration.

So a faculty member who also self-registers ends up with **one** registration, correctly
linked to their speaker record.

### Layer 2 — Login account (how a person *signs in*)

- A `User` row. **`User.email` is globally unique** (across the whole system, all events).
- **`User.role` is a single value**: `SUPER_ADMIN`, `ADMIN`, `ORGANIZER`, `MEMBER`,
  `REVIEWER`, `SUBMITTER`, `REGISTRANT`, `ONSITE`.
- **This is the only place "many hats" collides** — a login is exactly one role at a time.

A person only needs a login if they must **do** something logged-in: review abstracts
(`REVIEWER`), edit their own abstract (`SUBMITTER`), or manage their own registration
(`REGISTRANT`). **Pure faculty who just show up and present need no account at all** — their
badge and check-in run entirely off the Registration facet.

### Why external logins have NO organization — and never inherit the event's (ruled Aug 6, 2026)

`User.organizationId` is **deliberately null** for REVIEWER / SUBMITTER / REGISTRANT, and
the question "can't they just inherit the event's org id?" was asked and **ruled NO** by
the owner after the Aug 6 warning-triage round (a guard sweep had wrongly treated org-null
as "not allowed in", 403'ing submitter pages for 13 days — the fix restored linkage-based
access, NOT an org stamp). The operating rule:

> **Rows carry the org; external logins don't; a request derives the org from the
> resource.**

Three reasons, all load-bearing:

1. **Org-null is a security fence, not a missing value.** Throughout the codebase, a
   non-null `organizationId` on a User means *"one of the org's own people"* — the
   internal-domain rule, the team-roles filter, and every org-scoped check lean on it.
   Stamp the org onto external submitters and every org-scoped route that forgets a role
   check silently opens to them (a leak class that has produced real findings — e.g. the
   contacts-export H1). Org-null keeps outsiders outside *by default*.
2. **One codebase serves both silos.** The future multi-tenant platform instance runs the
   same image; there, a submitter can be linked to events in *different* tenants — one
   stored org id is guaranteed wrong for someone. Code can never rely on it, so stamping
   it on the single-org master buys nothing.
3. **The org is already available where it's needed — per request.** The "resource-org"
   pattern: authorization asks *"is this user linked to this event?"*
   (`buildEventAccessWhere` — a stranger still 404s), then `event.organizationId` (always
   correct, always fresh) drives the tenant lane, org-stamped writes, and branding. An
   account-level copy would add zero capability and one staleness/leak risk.

**Corollary for guard authors:** `requireOrgId` is for org-admin routes ONLY. A read that
serves submitters/reviewers (event details, theme pickers, their own rows) must authorize
via `buildEventAccessWhere` — and gets an "org-null role can read its surfaces" regression
test so the next sweep can't re-break it.

**The one sanctioned future version:** the platform identity model (PLATFORM_DECISIONS
item 6 — email unique *per tenant*) makes external accounts tenant-bound **by design**,
with the supporting redesign (tenant-scoped login, membership seam). That is the right
layer for "submitters belong to an org" — not a column stamp on today's master.

*(Related housekeeping, Aug 6, 2026: the vestigial second org "Meeting Minds" — one empty
draft event, no users/keys/data — was deleted from prod. Master is single-org, MM Group,
permanently, per the two-silo decision.)*

---

## 2. Quick reference: can the same person be both?

| They are already… | …and you also want them to be | Works automatically? | What to do |
|---|---|---|---|
| A delegate (registered) | Faculty (speaker) | ✅ Yes | Add them as a speaker — the companion links to their existing registration. |
| Faculty (speaker) | A delegate who checks in | ✅ Yes | Nothing — the companion registration *is* their check-in record. |
| An abstract submitter | Faculty who presents | ✅ Yes | Submitting already made them a Speaker row; assign them to a session to make them a presenter. |
| Faculty (speaker) | On the review committee | ✅ Yes (facets don't clash) | Add them via the event's **Reviewers** page. If they have no login yet, one is created. |
| A delegate **or** submitter **with a login** | On the review committee | ⚠️ One manual step | Their login already has a different role. See §3. |
| On the review committee (`REVIEWER`) | Submitting **their own** abstract | ❌ Not on one login | See §5 — a login can't be both `REVIEWER` and `SUBMITTER`. |

**Note on "an abstract submitter can be a speaker, or not":** every submitter **is** a
`Speaker` row (created at submission time — `Abstract.speakerId` is required). "Or not"
really means *presenter or not*: being a speaker record ≠ presenting. Presenting =
a **session assignment** (`SessionSpeaker`). A rejected abstract still leaves the person as
a speaker record; it just carries no session.

---

## 3. Runbook: make an existing delegate/submitter into a committee reviewer

This is the one workflow with a manual step, because their **login already has a role**.

**Symptom:** On the event's **Reviewers** page, "Add reviewer" (by email or from speakers)
fails with:

> *"User already exists with role SUBMITTER. Change their role in Settings > Users first."*

(or `REGISTRANT`, etc.) — from [`reviewers/route.ts`](../src/app/api/events/[eventId]/reviewers/route.ts).

**Fix (verified path):**

1. Go to **Settings → Users**.
2. Click **Invite** (do **not** look for the person in the list — attendees/submitters are
   *not* shown there; only staff/reviewers are).
3. Enter their **exact email**, name, and role **Reviewer**, then submit.
   - This **promotes their existing account in place** — keeps their password and all their
     registrations, just changes the role to `REVIEWER`
     ([`organization/users/route.ts`](../src/app/api/organization/users/route.ts)). You'll see a
     *"…account was promoted to Reviewer"* confirmation.
4. Go back to the event's **Reviewers** page and add them again — the role check now passes,
   and they're added to the event's reviewer list (and can be assigned to specific abstracts).

**If they have no account at all** (pure manually-added faculty/committee): skip steps 1–3.
Just add them on the Reviewers page — a `REVIEWER` login is created and an invitation email
is sent. Their speaker facet, badge, and check-in are untouched.

---

## 4. What each role change gains / loses

Because a login holds one role, promoting someone **swaps** their portal access. Their
**facets (badge, check-in, companion registration, speaker record) are never affected** — only
what they can do when logged in.

| Change | Gains | Loses |
|---|---|---|
| `REGISTRANT` → `REVIEWER` | Reviewer portal (`/my-reviews`), can score abstracts | Self-service `/my-registration` editing (their badge & registration still exist — an organizer just edits them instead) |
| `SUBMITTER` → `REVIEWER` | Reviewer portal | Ability to **edit their own abstract** (`/my-abstracts`); the abstract itself remains |

Staff roles (`ORGANIZER`/`ADMIN`/etc.) are **not** part of this participant table — they are
set when the person is invited as staff and don't flip into participant roles. A staff member
registering as an attendee is a *facet*, not a role change (see §1 Scope), so it's not a row
here.

> **Direction matters.** The Invite/promote path moves accounts *toward* team/reviewer
> roles. Reverting a `REVIEWER` back to `SUBMITTER`/`REGISTRANT` is **not** a one-click UI
> action — plan role assignments so you're not fighting to undo one mid-event.

---

## 5. The one real limitation (plan around it)

**A single login cannot be both `REVIEWER` and `SUBMITTER` at the same time.**

If a committee member also submits **their own** abstract, their login can only be one of the
two — they can review others *or* edit their own submission, not both, on the same account.

Options if this comes up:
- **Most common:** the committee member submits, then hands editing to an organizer; keep
  their login as `REVIEWER`. (Their own abstract's review is separately protected — a reviewer
  flagged with a conflict of interest is blocked from scoring it, via
  `AbstractReviewer.conflictFlag`.)
- **Or** keep them as `SUBMITTER` until submissions close, then promote to `REVIEWER` for the
  review round (they lose self-edit at that point — see §4).
- A second email/login is the only way to truly hold both at once.

This is a deliberate consequence of the single-role model, not a bug. If your committees
routinely need reviewer + submitter on one identity, that's the trigger to revisit the model
(per-event reviewer membership decoupled from `User.role`) — raise it before scoping.

---

## 6. Conference-day cheat sheet

- **"Is this faculty member checked in?"** — Yes if their companion registration is checked
  in. Faculty check in through the normal desk flow; no special handling.
- **"They registered as a delegate AND they're a speaker — two badges?"** — No. One
  registration, linked to both. One badge.
- **"A committee member can't be added as a reviewer."** — Their login has another role.
  Settings → Users → Invite with their email + role Reviewer (promotes in place), then add on
  the Reviewers page. §3.
- **"They submitted an abstract but aren't on the agenda."** — Expected. Submitting makes a
  speaker *record*, not a *presenter*. Assign them to a session to put them on the agenda.
- **"Pure committee/faculty person, never registered."** — Fine. They can hold a speaker
  facet + badge with no login, or a reviewer login with no registration, or both.
- **"How do we mark and pull committee members?"** — Committee is a **tag**
  (`committee` + optional `committee-organizing` / `committee-scientific`), *not* a ticket
  type — so it stacks with faculty. Comp registration + committee badge + the tag. Pull with
  `GET …/registrations?tags=committee`. Full model: [COMMITTEE_MEMBERS.md](COMMITTEE_MEMBERS.md).
- **"Can I (an organizer) register myself as an attendee to test?"** — Yes. Register through
  the public form with your organizer email + a password and it *links* the test registration
  to your account **without** changing your `ORGANIZER` role (a brand-new email becomes a
  `REGISTRANT` instead). Registering with no password just makes an unlinked registration.
  Either way your organizer access is untouched — delete the test registration afterward.

---

*Sources: [`prisma/schema.prisma`](../prisma/schema.prisma) (User/Speaker/Registration/Abstract),
[`speaker-companion.ts`](../src/lib/speaker-companion.ts),
[`reviewers/route.ts`](../src/app/api/events/[eventId]/reviewers/route.ts),
[`organization/users/route.ts`](../src/app/api/organization/users/route.ts),
[`submitter/route.ts`](../src/app/api/public/events/[slug]/submitter/route.ts),
[`event-access.ts`](../src/lib/event-access.ts). Read-only audit, 2026-07-02.*
