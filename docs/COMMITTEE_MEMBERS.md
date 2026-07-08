# Committee members — how EA-SYS models them

> **Who this is for:** organizers and engineers who need to add **committee members**
> (organizing committee, scientific committee, or a single generic "committee") to an
> event, and pull them back out via the API. This is a **design decision record** — it
> explains the model, *why* it's shaped this way, what works today, and the one thing that
> would only need building if capacity limits ever arrive.
>
> **TL;DR:** A committee member is a normal **registration** that is **complimentary**,
> carries a **`committee` tag** (the durable, queryable anchor), and prints a **committee
> badge**. Committee is a **tag, not a ticket type** — because a committee member can *also*
> be faculty, and a registration only holds one ticket type. Pull them with
> `GET …/registrations?tags=committee`.
>
> Companion reading: [IDENTITY_AND_ROLES.md](IDENTITY_AND_ROLES.md) (the "one person, many
> hats" model this builds on) and [../CLAUDE.md](../CLAUDE.md) (faculty / `isFaculty`).

---

## 1. The requirement

Committee members are different from delegates and from faculty:

- They **don't self-register** — the organizer adds them manually.
- They **don't pay** — they're comp.
- On an uncapped event they **don't need a seat reserved**, and they shouldn't be counted
  as paying delegates for revenue.
- But they **do need everything operational**: joining instructions, an entry badge,
  check-in, DTCM barcode where applicable, CME/attendance certificate, survey.
- A conference may have **one generic "Committee"**, or a **split** into
  **Organizing Committee** + **Scientific Committee**.
- **A committee member can also be faculty** (a speaker) — or a paying delegate. The model
  must let those stack on one person, one identity, one email.

---

## 2. The key decision: committee is a **tag**, not a ticket type

A `TicketType` is **one-per-registration** — a mutually-exclusive slot. Faculty already
live on a hidden `isFaculty` ticket type (see `EXCLUDE_FACULTY_WHERE` in
[../src/lib/faculty-filter.ts](../src/lib/faculty-filter.ts)). If "Committee" were *also* a
ticket type, a person who is **both a speaker and on the scientific committee** couldn't
sit on both — the two types would collide.

So committee is modeled as a **stackable designation (a tag)**, following the Layer-1
"facets stack, slots collide" rule from [IDENTITY_AND_ROLES.md](IDENTITY_AND_ROLES.md).
Behavior (pay / seat / count) comes from the person's **ticket type** (their primary
facet); committee-ness rides *on top* as a tag.

| The committee member is also… | Their registration sits on… | Pay / seat / count | Committee marker |
|---|---|---|---|
| **Faculty (a speaker)** | the hidden Faculty type (auto companion) | comp, no seat, **already excluded** from delegate counts | `committee` tag + badge |
| **A paying delegate** | their delegate ticket type | pays, **counts as a delegate** (correct — they *are* one) | `committee` tag |
| **Pure committee** (nothing else) | any comp type | comp; **counts as a delegate** unless capacity work is added (see §6) | `committee` tag + badge |

---

## 3. The moving parts (all existing primitives — no new schema)

1. **Tags** on the attendee — the anchor:
   - `committee` — **always present** on any committee member (the single stable anchor).
   - `committee-organizing` — organizing committee (optional sub-tag).
   - `committee-scientific` — scientific committee (optional sub-tag).

   **Anchor rule:** whenever a sub-tag is set, `committee` is set too. That way
   `?tags=committee` never misses anyone, and the sub-tags exist only to distinguish the
   split conferences. A "just committee" event uses only the `committee` tag.

2. **`badgeType`** on the registration — the printed label: `"Committee"`,
   `"Organizing Committee"`, or `"Scientific Committee"`. Free text, so single or split
   both work.

3. **`paymentStatus = COMPLIMENTARY`** — no money owed, no Stripe path, no invoice.

4. Everything operational (badge/barcode, check-in, DTCM, survey, certificate) is
   **registration-level** and works automatically once the comp registration exists.

---

## 4. How to pull committee members via the API

**REST API-key surface — works today, no code change.** The registrations GET route
already filters on tags ([registrations/route.ts](../src/app/api/events/%5BeventId%5D/registrations/route.ts),
`attendee.tags hasSome`, any-of, up to 20 tags):

```
GET /api/events/{eventId}/registrations?tags=committee
    → every committee member (faculty, delegate, or pure) in one call

GET /api/events/{eventId}/registrations?tags=committee-scientific
    → just the scientific committee
```

This is the anchor for pulling committee onto a website or into any integration.

**MCP `list_registrations` (agent / claude.ai / n8n) — needs one additive param.** That
tool currently filters by `status` + `ticketTypeId` only
([tools/registrations.ts](../src/lib/agent/tools/registrations.ts)) — no `tags` filter yet.
A small additive `tags` param mirroring the REST `hasSome` closes the gap. Until then, the
agent path can't filter by committee tag.

---

## 5. Faculty overlap — handled for free

A committee member who is **also a speaker** needs no special case. They're a `Speaker`
with an auto-created **Faculty companion registration** (comp, no seat, excluded from
delegate counts). Add the `committee` tag on top and:

- they're pullable via `?tags=committee` like everyone else;
- they can hold **two certificates** — a *Speaker/Appreciation* one (routed by their
  speaker tags) **and** a *Committee* one (routed by the `committee` tag) — because the
  certificate model is **one issued cert per template**, so role-specific certs stack.

One person, one email, one identity — two hats.

---

## 6. The one open fork — only if capacity limits ever arrive

Tags give everything **except** seat-skip + delegate-count-exclusion, because those are
anchored on `ticketType.isFaculty`, not on tags. This **only matters for _pure_ committee
members on a _capped_ event** (faculty-committee and delegate-committee are already
correct — see §2).

**As of 2026-07-08, EA-SYS events are uncapped**, so this is a non-issue and the tag model
is sufficient. If a capped event ever needs pure-committee out of the sold/seat count, the
change is: generalize `isFaculty` → `isInternal` and add one hidden internal **"Committee"**
ticket type (comp, uncapped, off the public form) — same machinery as Faculty, additive
migration, blue-green safe. Documented here so the future path is obvious; **not built**.

---

## 7. Status — what's built vs pending

| Piece | State |
|---|---|
| Comp registration + `badgeType` + all operational facilities | ✅ works today (existing primitives) |
| `committee` / sub-tags as the anchor | ✅ works today (manual tag entry) — the tag infra + REST filter exist |
| REST pull `?tags=committee` | ✅ works today |
| 3-checkbox convenience UI (Committee / Org / Scientific) on the registration form, auto-writing the anchor tag | ⏳ pending (convenience over manual tags) |
| MCP `list_registrations` `tags` param | ⏳ pending (additive) |
| Internal "Committee" ticket type for capped-event count-exclusion | ⛔ not needed while uncapped (§6) |

---

## 8. Decision log

| Date | Decision | Rationale |
|------|----------|-----------|
| 2026-07-08 | Committee = a **tag** (`committee` + optional `committee-organizing` / `committee-scientific`), not a ticket type | Committee stacks with faculty; a ticket type is a mutually-exclusive slot and would collide. Facets stack, slots collide. |
| 2026-07-08 | Anchor rule: any sub-tag also sets `committee` | Keeps `?tags=committee` a single reliable pull. |
| 2026-07-08 | Pay = `COMPLIMENTARY`, label = `badgeType` | Reuse existing primitives; zero schema. |
| 2026-07-08 | No internal ticket type for now | Events are uncapped, so count-exclusion isn't needed. Revisit only if capacity limits arrive. |
