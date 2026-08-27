# DTCM compliance codes

Dubai events issue a per-attendee compliance code from Dubai's Department of
Economy and Tourism. EA-SYS stores it on `Registration.dtcmBarcode`, prints it as
a QR on the badge, and accepts it at check-in.

Only events with **`requiresDtcmBarcode`** set do any of this. Everywhere else
the column stays null and every path below short-circuits.

---

## 1. Where a code comes from

Three writers, and knowing there are three is the point — any rule about codes
has to hold for all of them.

| Path | Who | When |
|---|---|---|
| **CSV import** | Organizer | A day or two before the event, when DTCM issues the block |
| **Spare pool** | The system, automatically | A walk-up registers at the desk and there is no code on the row |
| **Typed by hand** | Organizer, on the registration detail sheet | Corrections, and anything the other two missed |

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

- [src/lib/dtcm-pool.ts](../src/lib/dtcm-pool.ts) — the pool, the claim, the counts
- [src/lib/dtcm-walkup.ts](../src/lib/dtcm-walkup.ts) — the desk warning
- [src/lib/barcode-visibility.ts](../src/lib/barcode-visibility.ts) — who may see one
- user-guide § Check-in and badges — the operator-facing version
