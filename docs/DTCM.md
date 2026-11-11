# DTCM compliance codes

Dubai events issue a per-attendee compliance code from Dubai's Department of
Economy and Tourism. EA-SYS stores it on `Registration.dtcmBarcode`, prints it as
a QR on the badge, and accepts it at check-in.

Only events with **`requiresDtcmBarcode`** set do any of this. Everywhere else
the column stays null and every path below short-circuits.

**The event's DET performance code (2026-11-03).** An event with DTCM on also
carries `Event.dtcmPerformanceCode`, the DET eTicketing performance its codes
are issued against (e.g. `PDUB01DEC2023B`). One rule, in
[src/lib/dtcm-performance-code.ts](../src/lib/dtcm-performance-code.ts):
**turning DTCM on, or clearing the code while it is on, needs a code**.
Re-sending stored values is not a change, so the one event that had DTCM on
before the column existed still saves. Every writer of the switch calls it: the
event edit, `createEvent()` and the agent's `update_event`. A clone starts with
DTCM off and no code. Nothing reads the code yet; it is step 0 of buying codes
from DET inside EA-SYS ([DTCM_ETICKET_PLAN.md](DTCM_ETICKET_PLAN.md)), which
would add a fourth way a code arrives (§1).

---

## 1. Where a code comes from

Three writers, and knowing there are three is the point — any rule about codes
has to hold for all of them.

| Path | Who | When |
|---|---|---|
| **CSV import** | Organizer | A day or two before the event, when DTCM issues the block |
| **Spare pool** | The system, automatically | A walk-up registers at the desk and there is no code on the row |
| **Typed by hand** | Organizer, on the registration detail sheet | Corrections, and anything the other two missed |
| **Bought from DET** | Desk or organiser, "Get code from DET" on the sheet (Nov 3, 2026) and on the onsite desk's row (Nov 11, 2026) | The event's DET sections are mapped; one `DtcmOrder` per attempt (`src/services/dtcm-eticket-service.ts`, [DTCM_ETICKET_PLAN.md](DTCM_ETICKET_PLAN.md)) |

The **pool** is the leftovers: codes imported without an owner. Availability is
**derived, never stored** — a code is spare when no registration on that event
holds it. There is deliberately no `assignedRegistrationId` column, because with
three independent writers a stored flag would have to be reconciled by every one
of them, and missing one means the pool believes a code is free while an
attendee is wearing it.

---

## 2. Shared codes (2026-08-27)

**Two registrations may hold the same DTCM code.** Owner decision, made after the
desk hit the old constraint twice during the Aug-28 badge rehearsal, and
reaffirmed after the trade-offs below were put in writing.

`Registration.dtcmBarcode` was globally `@unique` until then. Migration
`20260827060000` drops that.

### What it costs, and what was done about each

- **A scan can no longer identify one person.** This is the real cost. Check-in
  accepts either the entry barcode or the DTCM code; a shared DTCM code matches
  two rows, and the previous `findFirst` would have checked in whichever one
  Postgres returned, leaving the other un-checked-in with nothing saying why.
  The scan route now **refuses an ambiguous DTCM match** (409 `AMBIGUOUS_SCAN`)
  and tells the desk to scan the entry barcode, which is still unique per
  registration and is what a badge leads with. **The ordinary desk flow is
  unaffected** — an entry-barcode match always wins and is never ambiguous.
- **The pool lost its contention signal.** Two desk stations claiming the same
  spare used to be caught by the unique index throwing P2002. That is gone, so
  `claimSpareDtcmCode` re-reads the holders after claiming and keeps the code
  only if it is the lowest registration id among them, else releases and takes
  the next spare. Deterministic on purpose: both racers backing off would leave
  a walk-up with no code at all. **The POOL still gives each spare to exactly one
  person — only a human typing a code may duplicate it.**
- **The spare count is unaffected.** `spare` is derived from a Set of held codes,
  so it counts distinct codes and a shared one still counts once.
- **Sharing is recorded.** The constraint used to be the only thing that noticed;
  the per-row audit shows a row gaining a code, never that someone else already
  had it. `registration-update:dtcm-code-shared` logs both registration ids at
  info when a code is assigned to a row another already holds.

### The part that is not reversible

Re-adding the unique index requires the data to be duplicate-free, which it will
not be once the desk uses this. That is a known, accepted cost of the decision.

### What is genuinely on the organizer now

Nothing in the system stops one code covering two people at a DTCM-inspected
door. That was previously impossible and is now a policy question, not a
technical one.

---

## 3. On the badge

A DTCM code renders as a **QR**, not Code 128. The value is a 36-character UUID,
which as Code 128 would be roughly 0.19 mm bars at badge width and unscannable in
print. The QR sits in the badge's bottom band; nothing above it moves, so a
non-DTCM event prints a byte-identical badge.

The human-readable line was **removed** on 2026-08-25. A badge is worn in public
and photographed, and printing a compliance credential legibly put it in every
group photo. If a scan fails, the value is on the registration detail sheet.

---

## 4. Who can see a code

`dtcmBarcode` is a door credential, so it follows `barcode-visibility.ts`, not
the finance rules: SUPER_ADMIN, ADMIN, ORGANIZER and ONSITE. **MEMBER is excluded
on purpose** — internal read-only staff have no reason to hold one.

That exclusion is also why the spare-pool route composes `BARCODE_ROLES` with the
desk allow-list rather than using the desk list alone: `REGISTRATION_DESK_ALLOW`
answers *who staffs the desk*, which is a different question from *who may hold a
door credential*.

**The desk's answers, not only the list (Nov 11, 2026).** The list and the
detail read stripped the entry barcode and the DTCM code from July 2026, but
four other staff routes answered with the whole registration row, or the code
just assigned, to anyone who could call them, and a MEMBER can call all four:
the registration save, the create, check-in (by id, by scan, the "already
checked in" refusal and the undo), and the walk-in. The first three now go
through `registrationForCaller` in `barcode-visibility.ts`; the walk-in, which
returns the pool's outcome and not a row, trims its own answer to the status.
**A new route that answers with a registration row uses the helper too.** The
create adds `hasDtcmCode` and the walk-in keeps `dtcm.status`, so a screen can
still say "no code was assigned" to someone who may not see the code. Two
older answers only a custom role can reach still carry the codes (the event
activity feed and the accommodation create: docs/ROADMAP.md DD-13), and a
printed badge carries both by design: whoever may print badges holds the
credential on paper, whatever `barcode.view` hides on screen.

**Who can WRITE one by hand.** `dtcm.assign` together with `barcode.view`, on
every door a person or an agent acting for them uses: the spare pool, the DET
purchase, since Nov 11, 2026 the registration save (typing a code, or "Use
this code"), and the agent's `update_registration` tool, which calls the
service directly and so asks the two keys through `toolInputPermissions`
(`DTCM_CODE_WRITE_KEYS`). Not covered by that pair, on purpose: the CSV import
and the DET bulk run (`dtcm.import`, the organisers' key), and an API key with
no role, which is the organisation's full key and passes no tool gate.

Before Nov 11, 2026 the save
took `dtcmBarcode` from anyone holding `registrations.update`, and the
registration sheet sent a blank for it on every save, so **a MEMBER editing
anything on a registration cleared its DTCM code** (found by review; production
held no code at the time). The rule is `dtcmCodeWriteRefusal`. From someone
who cannot see codes, a value is refused (403 `DTCM_CODE_FORBIDDEN`) and a
blank is dropped, so the stored code survives and an old tab can still save.
From someone who can see codes but may not assign one (a custom role), only
the code as it stands is let through; a new value or a clear is refused, since
their blank is a decision and not an accident. The sheet no longer sends the
field unless it was changed, and shows every DTCM write control (the edit
field, Assign a spare code, Enter a code, Get code from DET) only to someone
who holds both keys on the event.

---

## 5. Known gaps

- **A cancelled registration keeps its code forever**, so a no-show's code never
  returns to the pool.
- Group registration, MCP bulk create and speaker-companion creates **skip the
  automatic claim**, so those registrations arrive without a code.
- Only the first 10 spares are tried, and every caller starts at `spares[0]`.
- The availability read is two full-table scans on the public register hot path.

---

## 6. Related

- [DTCM_ETICKET_PLAN.md](DTCM_ETICKET_PLAN.md) - getting codes from DET's eTicketing API instead of a CSV, with the UAT findings
- [src/lib/dtcm-eticket/](../src/lib/dtcm-eticket/) - the DET client and the organisation's credentials (Settings → Integrations), step 1 of that plan; `sections.ts` is each event's registration type → DET section mapping (`Event.settings.dtcm`, step 2)
- [src/lib/dtcm-performance-code.ts](../src/lib/dtcm-performance-code.ts) - the performance code rule
- [src/lib/dtcm-pool.ts](../src/lib/dtcm-pool.ts) — the pool, the claim, the counts
- [src/lib/dtcm-walkup.ts](../src/lib/dtcm-walkup.ts) — the desk warning, and `lacksDtcmCode`, the one condition for "should carry a code and does not"
- [src/lib/desk-dtcm.ts](../src/lib/desk-dtcm.ts) - the onsite desk's side (Nov 11, 2026): which rows it flags "No DTCM code", the walk-in message, and what it says when nothing can issue a code, and when a spare may be offered at all (`deskMayOfferSpare`: never beside a live DET order). On the desk's panel DET leads and a spare code is the alternative (owner). That is the panel only: a new registration still takes a spare by itself in `createRegistration` when the pool has one
- [src/lib/barcode-visibility.ts](../src/lib/barcode-visibility.ts) — who may see one
- user-guide § Check-in and badges — the operator-facing version
