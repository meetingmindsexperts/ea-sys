# Per-registration-type supporting document

> **Status: BUILT 2026-08-13**, the same day it was planned (owner un-parked it
> immediately). This doc is kept as the design record; what actually shipped is
> summarised at the end of §5 and in the CLAUDE.md entry.
>
> **Deviations from the plan, and why** (all three are recorded so the next
> reader does not think the plan was simply ignored):
>
>  1. **Registration columns were NOT renamed in SQL.** §3.3 called for it;
>     deploys are blue/green and migrations run BEFORE the container swap, so an
>     `ALTER ... RENAME COLUMN` would leave the still-live old container
>     querying a column that no longer exists. Prisma `@map` gives the honest
>     field name at zero migration risk. Verified with `prisma migrate diff`:
>     the rename produces no DDL at all.
>  2. **The storage prefix stayed** `/uploads/resident-letters/` (§3.4 option 1,
>     as recommended), and so did the worker's `JOB_NAME`. Both are KEYS rather
>     than labels: the job name is matched by `EXPECTED_JOBS` for the daily
>     digest's cadence check and carried in `JobRun` history.
>  3. **The Required/Optional choice is asked as an explicit pair**, not as a
>     "refuse without it" checkbox (owner's framing, and better: the organizer
>     is choosing a policy, not opting out of one).
>
> **Goal:** let an organizer tick a box on ANY registration type to demand a
> supporting document, instead of the system guessing from the type's name.
>
> **Origin:** the Resident official letter shipped 2026-08-12 keyed on a name
> pattern (`/resident|trainee/i`). The owner then asked the obvious next
> question: what if Member needs a document too? Adding a second hardcoded
> pattern is the wrong shape, so this replaces the guess with a switch.

---

## 1. What exists today

Three conditional requirements, all triggered by **substring matching on the
ticket type's name**. None of them is configurable.

| Name contains | Registrant must supply | Kind |
|---|---|---|
| `member` | Member ID | text |
| `student` | Student ID + expiry | text + date |
| `resident` or `trainee` | Official letter | **file upload** |

Only the third takes a file. All three are enforced twice: in the browser form
and again on the server, so a crafted POST is refused
([register/route.ts:338](../src/app/api/public/events/%5Bslug%5D/register/route.ts#L338)
for member/student, and the resident-letter block just below it).

**Live on production (read-only query, 2026-08-13):**

```
Resident            6 registrations
Trainee / Student   3
Student             1
Member              0     type exists, never used
Student/Resident    0
```

Two things fall out of that table and both matter to the design:

1. **The Member path has never been used**, so there is no live behaviour to
   preserve for it. That makes this change unusually low-risk.
2. **Names already overlap.** "Trainee / Student" matches BOTH the student rule
   and the resident rule, so it currently asks for a Student ID *and* a letter.
   That may well be correct, but it happens as a side effect of substring
   matching rather than because anybody chose it. Explicit per-type config
   removes the accident.

---

## 2. Why name-matching is the wrong mechanism

Worth stating plainly, because it is the whole argument for the change.

- **It is invisible.** An organizer renaming "Resident" to "Junior Doctor"
  silently switches the requirement off. Nothing warns, and the next registrant
  is admitted without the document that substantiates their discount.
- **It cannot express intent.** There is no way to say "ask Members for a card
  but not Residents for a letter", because the trigger is the name, not a
  setting.
- **It does not scale.** Each new document need is another regex in shared code
  and another deploy. The owner's question ("what about Member?") arrived one
  day after the feature shipped, which is the signal.
- **It collides.** See "Trainee / Student" above.

The general class: **configuration encoded in a name is configuration nobody can
see, change, or audit.** The same reasoning retired `settings.maxAttendees` as a
dormant JSON key in favour of a real `Event.maxAttendees` column.

---

## 3. Design

### 3.1 Where the config lives

Add to **`TicketType`**, not to `Event.settings`. The requirement is a property
of the rate being claimed, and `TicketType` is already the row an organizer
edits on the Registration Types page.

```prisma
model TicketType {
  // ...
  /// Ask this type's registrants for a supporting document (letter, card,
  /// certificate). null/false = no document. Replaces the name-pattern guess.
  requiresDocument      Boolean  @default(false)
  /// Refuse the registration when the document is missing. false = collect it
  /// if offered, but never block the door.
  documentRequired      Boolean  @default(false)
  /// Organizer-authored label, e.g. "Official letter" / "Membership card".
  documentLabel         String?
  /// Organizer-authored instructions shown above the file input.
  documentInstructions  String?  @db.Text
}
```

Four additive nullable/defaulted columns. Additive + idempotent + blue-green
safe, per the standing migration rule.

**Note the two booleans are deliberately separate.** `requiresDocument` asks the
question; `documentRequired` decides whether a missing answer blocks. Collapsing
them into a tri-state enum reads tidier but makes "show the field, do not block"
unrepresentable, and that is the default the Resident letter shipped with for a
real reason: some events would rather take the registration and chase the
paperwork than lose the delegate at the form at 11pm.

### 3.2 What happens to the existing event-wide switch

`Event.settings.residentLetter.required` becomes **redundant** once the flag is
per type. Migration path in §5. Do not leave both live: two switches that can
disagree about the same question is the drift shape this codebase keeps paying
for.

### 3.3 Storage: reuse, do not duplicate

Keep the **single** column pair on `Registration`, renamed to drop the
"resident" framing:

```
residentLetterUrl       →  supportingDocumentUrl
residentLetterFilename  →  supportingDocumentFilename
```

Justification: a registration holds exactly ONE ticket type, so it can be asked
for at most one document. A second pair would be dead columns on every row.

**The limit this accepts, stated up front:** one document per registration. If
an event later wants two from the same type (passport *and* letter), this design
does not stretch, and the answer is a `RegistrationDocument` child table. That
is a bigger change and should not be pre-built for a need nobody has expressed.

Everything else on the file path is already generic and needs no change: the
magic-byte check, the 5 MB cap, the 10/hr/IP limit, the private storage prefix,
the authed streaming route, and the nightly orphan prune.

### 3.4 The prefix rename question

`/uploads/resident-letters/` is baked into `isResidentLetterPath()`, the public
catch-all block list, the streaming route and the prune job. Two options:

- **Keep the prefix, rename only the code.** Zero risk, mildly confusing name on
  disk forever.
- **Move to `/uploads/registration-documents/` and keep the old prefix
  accepted on read.** Cleaner, but the path is validated on the way in AND on
  the way out, so both validators must accept both prefixes for the lifetime of
  the old rows, and the prune job must sweep both directories.

Recommend the first for v1. The prefix is invisible to organizers, and a
half-migrated private-file namespace is a genuinely bad thing to own.

---

## 4. Scope

**In:**
- The four `TicketType` columns and their UI on the Registration Types page.
- Trigger by flag instead of by name, both in the public form and on the server.
- Per-type label/instructions replacing the hardcoded Resident copy.
- Backfill so the existing Resident/Trainee types keep behaving identically.
- The column rename plus its call sites.

**Out, deliberately:**
- **Member ID / Student ID stay name-matched.** They are text fields, not
  uploads, and no one has asked. Converting them is the same idea applied twice
  more and can follow if this lands well. Recorded so the inconsistency is a
  choice rather than an oversight.
- **Multiple documents per registration.** See §3.3.
- **Document review workflow** (approve/reject, chase emails). Today an
  organizer downloads the file from the registration sheet and judges offline.
  Nothing here changes that.
- **Documents on any door other than public registration.** The admin add-
  registration form, CSV import and MCP do not collect the file today and would
  not start to.

---

## 5. Migration and rollout

The risky part is not the schema, it is that **9 live registrations already hold
a letter** and 2 ticket types currently trigger by name.

1. **Ship the columns defaulted off.** No behaviour change: every type has
   `requiresDocument = false`.
2. **Backfill from the current rule**, so the same types keep asking:
   ```sql
   UPDATE "TicketType"
      SET "requiresDocument" = true,
          "documentLabel" = 'Official Letter',
          "documentInstructions" = '<the shipped Resident copy>'
    WHERE lower(name) ~ 'resident|trainee';
   ```
   And set `documentRequired` from each event's existing
   `settings.residentLetter.required`, so no event's blocking behaviour flips.
3. **Switch the trigger** from `requiresResidentLetter(name)` to the flag, in
   one commit, with the name-pattern helper deleted rather than left as a
   fallback. A fallback here means two sources of truth for the same question.
4. **Retire `settings.residentLetter`** once step 2 is verified on production.

**Do not skip step 2's verification.** A type that silently stops asking is the
exact failure the feature exists to prevent, and it is invisible: the form just
renders without the field.

---

## 6. Blast radius

19 files reference the resident-letter surface today
(`grep -rl "residentLetter\|resident-letter" src worker prisma __tests__ docs`).
Most are mechanical renames. The ones that need thought:

| File | Why |
|---|---|
| [resident-letter.ts](../src/lib/resident-letter.ts) | the pattern helper is deleted; path validation stays |
| [register/[category]/page.tsx](../src/app/e/%5Bslug%5D/register/%5Bcategory%5D/page.tsx) | trigger + label + instructions now come from the selected type |
| [register/route.ts](../src/app/api/public/events/%5Bslug%5D/register/route.ts) | server gate reads the flag off the resolved ticket type |
| [public/events/[slug]/route.ts](../src/app/api/public/events/%5Bslug%5D/route.ts) | must expose the four fields per type so the form can render |
| [settings/page.tsx](../src/app/%28dashboard%29/events/%5BeventId%5D/settings/page.tsx) | event-wide switch removed |
| tickets page | new per-type controls |
| [prune worker](../src/lib/resident-letter-prune-worker.ts) | rename only, unless §3.4 option 2 is chosen |

---

## 7. Test plan

Beyond renames, the cases that would actually catch a regression:

1. **A flagged type demands the document; an unflagged one does not.** The
   whole point, and the one thing name-matching got wrong.
2. **`requiresDocument` true + `documentRequired` false** collects the file but
   admits a registrant without one. The two-boolean split is unrepresentable if
   this is not pinned.
3. **Renaming a type does not change its behaviour.** This is the defect being
   fixed, so it deserves an explicit test, not just an absence of the old one.
4. **Backfill parity**: a type named "Resident" behaves after migration exactly
   as it did before. Assert against the shipped copy, not a paraphrase.
5. **The path guard still refuses traversal** after the rename, on both the
   write and the read side. Both were mutation-verified when the feature
   shipped; a rename must not quietly drop one.

---

## 8. Open questions for the owner

1. **Does Member want a letter, or a membership card image?** A card is what a
   member actually has to hand; a letter is what an institution issues. It
   changes only the default copy, but it changes what organizers get for free.
2. **Should Member ID and Student ID also become per-type config?** (§4 leaves
   them name-matched.) Consistent, but doubles the UI on the type editor.
3. **Prefix rename** (§3.4): keep `/uploads/resident-letters/`, or move?
4. **Is one document per registration enough**, or is a passport-plus-letter
   case already known to exist? This is the one decision the design cannot
   cheaply reverse later.

---

*Survey performed against the code and a read-only production query on
2026-08-13. Re-check §1 before starting if significant time has passed: its
value is that the counts were verified, and a stale count here is worse than
none.*
