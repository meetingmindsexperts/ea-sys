# HR Module: Attendance & Leave Tracker (UAE)

> **Status: LIVE on the master silo (August 31, 2026).** `HR_MODULE_ENABLED` is
> set on production, which holds **23 employees and 943 attendance entries**
> imported from the workbook. All seven build steps shipped, plus one
> post-launch redesign of the recording model that this plan did not anticipate
> (§17).
>
> This file is the plan of record; the source it was written from is the
> validated Excel tracker `UAE_Employee_Attendance_Leave_Tracker_2026` (v5.1),
> which remains the business-logic reference. Where this document and the
> workbook disagree, the workbook wins and this document is wrong.
>
> **All rules are CLOSED.** §3 records what the workbook actually does, read
> from its formulas rather than its numbers. That reading overturned a premise:
> the leave year is the **calendar year**, not the service year, so the
> anniversary-lump model in the first draft was wrong and §5.1 is rewritten. It
> also found a live defect in the workbook: one employee holds a comp-off the
> owner's own rule does not award (§3.2). A negative balance carries into the new
> year, positive carryover is capped at 30 days, and days stay derived with
> month-finalisation deferred as a purely additive follow-on.
>
> **The import reconciled 22 of 23 employees to the digit** against the
> workbook's own Leave Summary, with the single predicted comp-off variance.
>
> ### Open, in the order they will hurt
>
> 1. **CLOSED, Aug 31 2026 (owner): annual leave is charged for every day in the
>    block.** A holiday from Monday the 6th to Friday the 17th costs 12 days, not
>    10. This matches the workbook, which is what every imported balance was
>    calculated from, so a holiday recorded today costs the same as one recorded
>    last year. The scope came from the data rather than the ruling: 86 of 419
>    imported ANNUAL days fall on a weekend and only 2 of 45 sick days do, so the
>    rule is annual-specific and sick leave stays working-days-only. Implemented
>    as `rangeCoversCalendarDays()` in `hr-constants.ts`, resolved in the SERVICE
>    so the grid, MCP and any importer cannot answer it three different ways.
> 2. **A leaver's entitlement (OPEN).** Owner ruling Aug 31: a leaver gets
>    nothing for their exit year, and Muthu must be able to override it by hand.
>    Needs a per-employee entitlement field; not built yet.
> 3. **The year-end roll worker.** `planYearRoll` exists as a pure function; the
>    DB service and `worker/jobs/hr-year-roll.ts` do not. 1 January is a real
>    deadline.
> 4. **The privacy paragraph** in `docs/SECURITY_AND_PRIVACY_POSTURE.md` (§10
>    here). That database now holds colleagues' sick-leave records while the
>    document handed to a federal health authority describes it as event data.
> 5. HR settings screens (holidays, leave codes), dashboard tiles, and the MCP
>    tools of §12. None is blocking.
>
> **Sequencing note.** `docs/PLATFORM_DECISIONS.md` §7 records per-tenant Stripe
> and AI keys as the next build priority. Building HR first reordered that, and
> that is an owner decision, recorded here so nobody later assumes it was an
> oversight.

---

## 1. The ask

Replace the Excel attendance and leave tracker with a first-class EA-SYS module:
per-employee daily attendance, UAE-law leave codes, annual leave accrual, sick
leave tiers, comp-off from working rest days, and the reports HR reads today.

## 2. What already exists, and what is genuinely new

Nothing in EA-SYS models employment. The module is greenfield, with two
touch points worth naming before the schema is written.

- **`Employee` becomes the fourth person-like table** beside `User`, `Contact`
  and `CrmContact`, each of which exists because it answers a different
  question. `Employee` answers "who works here", which none of the others do,
  so a new table is right. The optional `Employee.userId` link is the only
  bridge, and it stays optional: an employee who never signs in is still an
  employee. See `docs/IDENTITY_AND_ROLES.md` for why facets are linked and
  never merged.
- **The module boundary already has a working precedent.** `eslint.config.mjs`
  carries a one-way import rule for `src/crm/**`, and the HR block is a clone of
  it: `src/hr/` may import core, core must never import `src/hr/`, with a named
  exemption list for the worker job shim.

## 2a. Availability: master silo only, tenancy nonetheless first-class

Owner decision, Aug 27, 2026: *"isolate this HR module to master silo only"* and
*"but multi tenancy should be possible."* Those are not in tension; they answer
two different questions, and the module keeps them apart deliberately.

| Question | Answer | Where it lives |
|---|---|---|
| Can a tenant other than us hold HR data? | Yes | The schema: `organizationId` on all five tables, RLS policies from day one |
| Is the module switched on for them? | No | `HR_MODULE_ENABLED`, unset everywhere except master |

The reason for the split is that **only one of them is reversible.** A flag flips
in a deploy. A tenant-blind data shape is a migration and a backfill, and by then
there is real HR data in it. So the module is built tenant-correct and shipped
master-only, which costs nothing now and forecloses nothing later.

`HR_MODULE_ENABLED` **fails closed**: unset means off, so the platform instance, a
DR box and a fresh dev machine do not acquire an HR system by accident. Only the
literal string `true` enables it. It is deliberately **not** derived from
`PLATFORM_ORG_ID`, because inferring "we are master because the platform id is
unset" would couple this module's availability to the silo-detection mechanism,
so a change to how silos identify themselves would silently change who has an HR
system.

Enforced in depth, like every other boundary here:

- API routes **404** when the module is off. 404 rather than 403: a module that
  is not available should not announce that it exists.
- `src/proxy.ts` redirects `/hr*` when off.
- The sidebar entry is hidden when off.
- **`HR_USER` is not offered in the invite dropdown when off.** The enum value
  exists on every silo because the enum is shared, but existing and being
  grantable are different things, and a role that can reach nothing is a support
  ticket waiting to happen.

The RLS policies are applied on the platform too, even though the module is off
there. The tables ship in the shared migration chain so they exist regardless,
and an existing unpoliced table is a latent hole the day somebody flips the flag.
"We will add the policy when we enable it" is precisely the sentence that does
not survive a year.

**Operator note.** `.env.example` is gitignored in this repo, so the variable is
documented here and nowhere else:

```
HR_MODULE_ENABLED=true   # MASTER SILO ONLY. Unset/absent everywhere else.
```

Setting it on the platform instance switches the module on for every tenant at
once. There is no per-tenant toggle today, deliberately: one flag with one
meaning is easier to reason about than a per-org setting nobody audits, and a
per-tenant version is additive if it is ever wanted.

### 2a.1 The person entering the data is also in the data

Owner note, Aug 27: *"Muthu logs into the system and captures attendance too."*

Muthu is EMP003 (Admin and Accounts Manager) and is both the operator and a
subject. So `Employee.userId` is used from day one rather than being the future
self-service hook the first draft called it, and **his own leave is a
self-entry**. There is no separation of duties, which is entirely normal at 25
people and is exactly why every attendance write carries the acting user into
`AuditLog`. The module does not block self-entry; it makes it visible.

---

## 3. What the workbook actually does (read from the formulas, Aug 27, 2026)

The v5.1 workbook was parsed directly (formulas, not just cached values), and
three things in the original plan were wrong. This section is the evidence.
Shape: **9,125 rows** (25 employees x 365 days), **2026-01-01 to 2026-12-31**.

### 3.1 The leave year is the CALENDAR year, not the service year

This is the correction that matters most, because the original plan built an
anniversary-lump service-year ledger and the workbook does nothing of the kind.

```
Employee Master G:  =IF(EDATE(joining,12) <= TODAY(), 30, 0)      # entitlement
Employee Master H:  manual "Carryover / Unused AL (manual)"
Leave Summary   D:  =N(G) + N(H)                                   # entitlement + carryover
Leave Summary   E:  =COUNTIFS(AL, date <= exitDate or 2027-01-01)
                     + 0.5*COUNTIFS(AL-HD, same bound)             # taken
Leave Summary   F:  =D - E                                         # balance
```

There is **no lower date bound on E**, and the sheet spans exactly one calendar
year. So: entitlement is a flat 30 for the year, the anniversary is only the
eligibility gate for a first-year employee, and "taken" means "taken in 2026".
Nothing accumulates across years inside the sheet; last year arrives as the
manual `H`.

Two consequences worth stating before they surprise someone:

- **The entitlement gate is evaluated against `TODAY()`, so it moves mid-year.**
  EMP021 (Adelina) shows entitlement 0 and balance **-23** today. The moment her
  first anniversary passes, entitlement flips to 30 and her balance becomes +7.
  That is a live number that changes without anyone editing anything.
- **After year one the gate is permanently true**, so `G` is simply 30 forever
  and only new joiners ever see 0.

### 3.2 D1 CLOSED: only a Saturday plus Sunday pair earns a comp-off

Owner ruling, Aug 27: *"fri + sat + sun give only 1, because fri is a workday.
Only sat + sun consecutive will earn a comp-off."*

**The workbook does not implement that.** Its formula is the broader
previous-day rule:

```
Daily Attendance J:  =IF(inactive, 0,
                        IF(AND(F="OD", COUNTIFS(sameEmp, date-1, "OD") > 0), 1, 0))
```

Any OD day whose previous calendar day is also OD earns 1, regardless of which
days of the week they are. On weekend pairs the two rules agree, which is why
this has gone unnoticed.

**The divergence is live in the data, in exactly one row.** Of 58 OD days across
16 employees, every earning pair is Sat+Sun except one:

| Employee | OD days | Earned (workbook) | Earned (owner rule) |
|---|---|---|---|
| EMP002 Nawfer | Wed 2026-01-14 + Thu 2026-01-15, Sat 06-27, Sat 07-04 | **1** | **0** |
| everyone else | Sat+Sun pairs and lone Saturdays | matches | matches |

So Nawfer's comp-off balance is 1 in the workbook and should be 0. **The
reconciliation gate in §13 must expect this single deliberate difference**,
not treat it as an import failure. It is also the reason the gate exists.

Implementation rule: **an OD on a weekend day earns 1 comp-off when the other
day of the same weekend is also OD.** Compute from the weekend pair, not from
"yesterday was OD". A lone Saturday earns 0. Wed+Thu earns 0.

**Small follow-up, not blocking:** under this rule, working a **public holiday**
earns nothing, even though §6.4 defines OD as working a weekly off *or* a
holiday and Art. 28 covers both. The live data has no holiday OD, so nothing is
affected today. Confirm when convenient.

### 3.3 D2 CLOSED, and reversed from the first draft

Owner ruling, Aug 27: *"they get carried forward. Muthu will manually enter them
for last year, and going forward they will be carried forward."*

So `Employee.carryoverDays` is the **seed** (manual, one time, for the year
before go-live), and from then on the system rolls the closing balance into the
next year automatically. Given §3.1, the boundary is **1 January**, not the
anniversary.

Both follow-on questions are now answered (owner, Aug 27):

- **A negative balance DOES carry forward.** Leena closes 2026 at -15 and opens
  2027 at 15, not 30. The debt follows the employee, which is the only reading
  under which leave taken in advance means anything.
- **Positive carryover is CAPPED at 30 days** (`HR_CARRYOVER_CAP_DAYS`).
- **The cap applies in one direction only.** A negative carries in full and is
  never floored, because capping a debt would forgive it and thereby cancel the
  first ruling. This asymmetry is the kind that reads as an oversight later, so
  it is stated at the constant, in the schema comment and here.

### 3.4 D3 informed: the workbook pre-generates everything, and 90% of it is noise

All 9,125 rows exist. Only **943 carry information**:

| | rows |
|---|---|
| P | 4,801 |
| OFF | 2,191 |
| PH | 264 |
| blank (mostly outside the employment window) | 926 |
| **AL** | **419** |
| **WFH** | **386** |
| **OD** | **58** |
| **SL-F** | **45** |
| **CO** | **29** |
| **ABS** | **4** |
| **SL-HD / AL-HD** | **1 each** |

The §4 design note is vindicated: storing only the 943 is right, and the
pre-generated 7,256 are exactly the phantom rows the module should not have.

**DECIDED (Aug 27): days stay derived, and month-finalisation is deferred.**

A derived P still cannot be distinguished from nobody-recorded-anything, and the
two places that matters are today's dashboard (which reads confidently wrong
before anyone opens the grid) and end-of-service evidence years later (where an
inference is weaker than a record).

**The first draft claimed this had to be settled before the schema. That was
wrong**: a finalisation table is purely additive and changes nothing about the
day-to-day model, so building derived-first forecloses nothing. Recorded because
an incorrect blocker in a plan costs more than a missing one.

The argument for adding it later is worth keeping, because it is not the obvious
one. **Public holidays are entered by HR by hand each year**, since Islamic dates
move with the moon. So the recipe that derives a day can change after the fact:
add a holiday retroactively and a day that read Present last month reads PH
today, silently, with no edit anyone made. Finalising freezes the answer. The
storage cost is about 7,300 rows a year for 25 people, which is nothing.

### 3.5 Two data-quality items the import must handle

- **EMP024 and EMP025 are placeholder rows** with the literal name `0` and no
  joining date. Skip them; do not create employees.
- **Negative comp-off balances already exist** (EMP011 -2, EMP015 -2, EMP016 -2,
  EMP022 -1): people have taken comp-offs they had not earned. This confirms
  warn-rather-than-block as the right default in §6.4, and means negative
  comp-off must display as plainly as negative annual leave.

---

## 4. Domain model (Prisma)

```prisma
model Employee {
  id             String    @id @default(cuid())
  organizationId String
  empCode        String
  name           String
  department     String?
  jobTitle       String?
  joiningDate    DateTime  @db.Date
  exitDate       DateTime? @db.Date   // last working day, INCLUSIVE
  status         EmployeeStatus @default(ACTIVE)   // ACTIVE | RESIGNED | TERMINATED
  carryoverDays  Decimal   @default(0) @db.Decimal(5,1)
  userId         String?
  notes          String?
  @@unique([organizationId, empCode])
}

model LeaveCode {
  id             String  @id @default(cuid())
  organizationId String
  code           String
  label          String
  lawReference   String?
  paid           Boolean
  dayWeight      Decimal @db.Decimal(2,1)   // 1.0 or 0.5
  countsAs       LeaveCategory
  active         Boolean @default(true)
  @@unique([organizationId, code])
}

model AttendanceEntry {
  id             String   @id @default(cuid())
  organizationId String
  employeeId     String
  date           DateTime @db.Date
  leaveCodeId    String
  remarks        String?
  approvedById   String?
  source         String   // "ui" | "mcp" | "import" | "cron"
  @@unique([organizationId, employeeId, date])
}

model LeaveGrant {
  id             String   @id @default(cuid())
  organizationId String
  employeeId     String
  grantDate      DateTime @db.Date
  days           Decimal  @db.Decimal(4,1)
  serviceYear    Int
  @@unique([organizationId, employeeId, serviceYear])
}

model PublicHoliday {
  id             String   @id @default(cuid())
  organizationId String
  date           DateTime @db.Date
  label          String
  @@unique([organizationId, date])
}
```

### 4.1 Two conventions this introduces, and the rules that must come with them

**`@db.Date` appears ZERO times in the current schema.** Every date in EA-SYS
today is a full `DateTime`. Using a date-only column for calendar dates is
correct (a leave day is a date, not an instant, and giving it a time invites a
timezone to change which day it is) but it is a new convention, so it arrives
with one hard rule:

> Weekday and holiday resolution reads the calendar date, never `getDay()` on a
> `Date` whose timezone is unstated. A `@db.Date` value comes back through
> Prisma as UTC midnight; `getDay()` on it is correct only while every reader
> is in UTC, and the moment one is not, weekends move by a day silently.

`src/lib/event-time.ts` already owns this class of helper for events. HR gets
`src/hr/lib/hr-date.ts` with its own date-only primitives rather than reusing
the event ones, because event dates are instants in an event timezone and HR
dates are calendar dates in the org's working week. Two different concepts that
happen to render similarly is exactly how the wrong one gets called.

**`Decimal`, never `Float`, for every day count.** Half days must be exact. A
float sum of thirty 0.5s is not 15.

### 4.2 The leave year is one helper, used everywhere

Per §3.1 the leave year is the **calendar year**, and both annual leave and the
sick tiers reset on it (the sick formulas have the same unbounded COUNTIFS
shape as the annual one, so they are calendar-year too). The employment
anniversary survives in exactly two places: the first-year eligibility gate, and
the "next grant date" shown to HR.

Two small functions, called by every consumer, never re-derived:

- `leaveYearBounds(year)` gives the Jan 1 to Dec 31 window.
- `hasCompletedFirstYear(employee, asOf)` is the entitlement gate.

`hasCompletedFirstYear` is the one with a trap in it: a joining date of
29 February has no anniversary in three years out of four, and whichever way
that resolves (28 Feb or 1 Mar) it must resolve the same way for every caller.
Two implementations that disagree there is a defect nobody finds until the year
it matters. This is the no-cross-caller-duplication rule (AGENTS.md).

---

## 5. Business rules

Every rule below is validated in the workbook. Implement exactly; do not
invent, and do not "improve" one because it looks inconsistent with another.

### 5.1 Annual leave: calendar year, flat 30, manual seed then automatic carry

Per §3.1, read from the workbook formulas. This replaces the anniversary-lump
model in the first draft of this plan, which the workbook does not implement.

- **Entitlement for a calendar year is a flat 30 days**, granted in full, once
  the employee has completed twelve months. Before that it is **zero**: the
  law's pro-rata minimum for months 7 to 12 was declined as company policy, so
  a config flag `accrueProRataFirstYear` defaults to `false` and leaves that
  reversible without a schema change.
- **The gate is evaluated against the current date, so it moves mid-year.** An
  employee sits at 0 entitlement, possibly with a negative balance, until their
  first anniversary passes, at which point 30 appears. EMP021 is exactly this:
  -23 today, +7 the day after her anniversary. The UI must make that legible
  rather than let it look like a correction nobody made.
- **Carryover** is `Employee.carryoverDays`: manual for the one-time seed of the
  year before go-live, then written by the year-end roll (below).
- **Balance** = entitlement + carryover - annual leave taken in the calendar
  year, where `AL` counts 1.0 and `AL-HD` counts 0.5.
- **Negative balances are allowed, displayed, and never clamped.** They are
  leave taken in advance, which is legal by agreement, and four employees are
  negative in the live data. A `Math.max(0, ...)` anywhere in this module is a
  bug.
- **Year-end roll**, the piece the workbook does not have because it only holds
  one year: on 1 January the closing balance becomes the new `carryoverDays`.
  Two rules on it are still OPEN, see §3.3: whether a negative balance follows
  the employee into the new year, and whether carryover is capped.
- Each employee exposes a **next anniversary date**, which is informational
  after year one.

**`LeaveGrant` is retained even though the workbook has no equivalent.** A flat
30 could be computed rather than stored, but the year-end roll writes a value
derived from a whole year of entries, and a derived number that later disagrees
with the entries it came from is unanswerable. One row per employee per leave
year, carrying the entitlement and the carried-in figure, makes "why does this
person have 34 days" a question with a dated answer.

### 5.2 Half days

- `AL-HD` and `SL-HD` carry `dayWeight = 0.5`.
- `AL-HD` debits the annual balance. `SL-HD` debits the **full-pay sick tier**.
- **Naming invariant, and it is a trap:** `-HD` means half **day**; `SL-H`
  means half **pay** (days 16 to 45 of the Art. 31 tiers). `SL-H` and `SL-HD`
  are different concepts that differ by one character. Both stay, both get a
  comment, and the UI never abbreviates them further.

### 5.3 Sick leave tiers (Art. 31 FDL 33/2021)

Per leave year (calendar, per §4.2): first 15 days full pay (`SL-F`), next 30
half pay (`SL-H`), next 45 unpaid (`SL-U`). `SL-HD` counts 0.5 against the
full-pay tier. Consumption is tracked per tier and the balances view shows all
three, because "days of sick leave left" is not one number.

`Employee.openingSickLeaveUsed` carries the seed, mirroring the workbook's
"Opening Sick Leave Used" column.

### 5.4 On-Duty and Comp-Off (Art. 28)

- `OD` marks working a weekly off or a public holiday, for example delivering a
  conference on a Saturday.
- **Comp-off earning, per the owner ruling closed in §3.2: an OD day on a
  weekend day earns 1 comp-off when the OTHER day of the same weekend is also
  OD.** Sat plus Sun earns 1. A lone Saturday earns 0. Two working days marked
  OD earn 0, which is where the workbook's own formula is wrong and where the
  import will legitimately differ from it by one comp-off for EMP002.
- Compute the rule from the weekend pair, not from "the previous day was OD".
  The two agree on every weekend case and diverge everywhere else, so the
  broader rule looks correct right up until it is not.
- The balance is **derived** (earned plus opening, minus taken), never stored as
  a counter, so it cannot drift away from the entries that justify it.
- `CO` marks taking an earned comp-off. Taking one with a zero balance is a
  **warning by default**, with a config flag to make it a hard block. Four
  employees are already negative in the live data, so blocking by default would
  refuse to import the truth.
- No comp-off is earned after the exit date.

### 5.5 Employment window

- An attendance entry is valid only for `joiningDate ≤ date ≤ exitDate`, with
  the exit date inclusive.
- Entries outside the window are **rejected on write** with a clear error. The
  workbook could only ignore them when counting; the app refuses them, which is
  strictly better and is also why the import script needs an explicit bypass
  (§13).
- Exit sets `exitDate` and `status`. Everything after is excluded from reports,
  and **the history stays visible**: it is the evidence for end-of-service
  gratuity and leave encashment. Nothing in this module soft-deletes an
  employee.

### 5.6 Weekends and public holidays

- Weekend defaults to Saturday and Sunday, configurable per org
  (`weekendDays`), because some GCC entities run Friday and Saturday.
- `PublicHoliday` is seeded from **the PH rows the workbook actually holds**,
  not from a published list. That distinction earned its keep: the first draft of
  this plan carried eleven dates and the workbook has **thirteen**, because it
  also holds **Jan 2** and **May 25**, making the Eid al-Adha block five days
  rather than four. Seeding the published list would have marked two real
  holidays as ordinary working days, and since an unrecorded day derives to
  Present, **nobody would ever have seen an error**. The seed and its exact-count
  test live in `src/hr/lib/hr-seed-data.ts`.
- Admin CRUD for future years. **No auto-generation:** Islamic dates are
  moon-dependent, so HR confirms them annually and a generated guess would be
  wrong in a way that silently shifts a payroll month.
- **Effective status for an (employee, date) with no entry:** outside the
  employment window gives not-applicable; a public holiday gives `PH`; a
  weekend gives `OFF`; otherwise `P`. An explicit entry always wins, so `OD` on
  a Saturday overrides `OFF`.

---

## 6. Services (`src/hr/services/`)

Errors as values, already-typed inputs, `source` tagging into `AuditLog`, and
no service imports `next/server`. Same contract as `src/services/README.md`.

- **`employeeService`**: CRUD, exit flow, carryover updates.
- **`attendanceService`**: upsert one entry (validating window and code),
  bulk range entry (for example "AL from Sep 7 to 18" expands to working days
  only, skipping weekends and holidays), delete.
- **`leaveBalanceService`**: **the single source of truth for every balance**:
  annual, the three sick tiers, comp-off. Pure functions over queried data,
  exhaustively unit-tested. Every UI, report, MCP tool and export calls it.
  There is no second implementation of balance maths anywhere in the module,
  and a review that finds one treats it as a defect.
- **`accrualService`**: the daily grant materialiser, idempotent.
- **`hrReportService`**: dashboard aggregates, the per-employee annual summary
  (the workbook's "Leave Summary" sheet as an API), and the monthly register.

## 7. API routes (`src/app/api/hr/*`)

Thin handlers over services, Zod validated, org scoped, every failure path
logged.

- `GET/POST /api/hr/employees`, `PATCH /api/hr/employees/[id]`,
  `POST /api/hr/employees/[id]/exit`
- `GET/PUT /api/hr/attendance?from&to&employeeId` (grid read, bulk upsert)
- `GET /api/hr/balances/[employeeId]`, `GET /api/hr/reports/summary?year=`
- `GET/POST /api/hr/holidays`, `GET/POST /api/hr/leave-codes`

---

## 8. RBAC: the `HR_USER` sweep, enumerated

This is the largest and most error-prone part of the module, and it is not the
enum value. `CRM_USER`, the closest precedent, touches **32 files**. The work is
deciding this role's answer in every predicate that already exists.

**The single most important line, and the one that fails OPEN if missed:**

> `RESTRICTED_WRITE_ROLES` in `src/lib/auth-guards.ts` is the **only deny-list**
> in the set. A role absent from it can write to every non-HR route in the
> application. Every other predicate listed below is an **allow-list**, so a new
> role is excluded by default and omission fails closed.

That asymmetry is the same allow-list lesson the check-in payment gate produced
in August 2026: a status was admitted at the door purely because nobody had
remembered to add it to a deny-list.

### 8.1 Edits genuinely required

| File | Decision |
|---|---|
| `prisma/schema.prisma` | `HR_USER` on `UserRole`, additive enum migration (`ADD VALUE IF NOT EXISTS`) |
| `src/lib/auth-guards.ts` | **Add to `RESTRICTED_WRITE_ROLES`.** Fails open if missed |
| `src/lib/team-roles.ts` | Add to `TEAM_ROLES` so it is invitable from Settings → Users |
| `src/app/api/organization/users/route.ts` + `[userId]/route.ts` | Display label and `ASSIGNABLE_USER_ROLES`. The `_AssignableCoversTeamRoles` compile-time guard **breaks the build** if a role joins `TEAM_ROLES` without becoming assignable, which is a safety net, not a reason to skip it |
| `src/lib/event-access.ts` | `HR_USER` branch returning zero events, mirroring the `CRM_USER` branch |
| `src/proxy.ts` | Confine to `/hr*`; redirect every other dashboard path |
| `src/components/layout/sidebar.tsx` | `hrOnly` nav entry, HR-only visibility |
| `src/components/layout/header.tsx` | Role badge label |
| `src/app/(dashboard)/settings/page.tsx` | Invite role option |
| `src/hr/lib/hr-roles.ts` (new) | `canViewHr` / `canWriteHr` / `denyNonHr`, cloned from `src/crm/lib/crm-roles.ts`. **Its own predicate**, because none of the existing nine has the right shape |

### 8.2 Predicates that need NO edit, and why that is the point

`finance-visibility.ts`, `barcode-visibility.ts`, `login-visibility.ts`,
`registration-export-visibility.ts`, `contact-visibility.ts` and
`supporting-document-visibility.ts` are all allow-lists. `HR_USER` is excluded
from every one of them by construction, with no line written. Confirm each by
reading it rather than by assuming, and record the confirmation, because "we
checked and no change was needed" is a different fact from "we did not look".

### 8.3 The reverse direction

HR routes must refuse `ORGANIZER`, `MEMBER`, `ONSITE`, `WEBINARS`, `CRM_USER`
and every org-null role. `ADMIN` and `SUPER_ADMIN` keep full HR access.
Employee self-service (a linked `userId` reading only its own attendance and
balances) is **out of scope for v1** and is the obvious v1.1.

---

## 9. Tenancy and worker conventions the module must ship with

Born compliant, in the same commit, not deferred. This is the Phase-2 sweep
convention and the early tables are the reason it exists.

- **`organizationId` on all five tables**, stamped by every writer.
- **RLS policies from day one** in `prisma/rls/employee.sql`,
  `leavecode.sql`, `attendanceentry.sql`, `leavegrant.sql`,
  `publicholiday.sql`, flat on `organizationId`, applied by the harness and the
  platform bootstrap and **never by a Prisma migration**.
- **`runWithTenant` wrapping every route handler**, plus entries in
  `scripts/check-tenant-als.sh` `SWEPT_ROUTE_DIRS`. The gate is what stops a
  dropped wrap from being invisible on master and load-bearing on the platform.
- **`tenantTransaction`** for any multi-statement write (bulk range entry).
- **A tenancy harness test** per `tests/tenancy/*-rls.test.ts`, with two orgs
  holding **the same `empCode`**, since a shared value is what proves scoping
  rather than counting.
- **The accrual job is a worker job**, `worker/jobs/hr-accrual.ts`, with a
  `JobLease` and its own `JOB_ID`, plus an `expectedPerDay` entry in
  `EXPECTED_JOBS` so the daily digest notices if it stops running. It is **not**
  an `/api/cron/*` route: those are the deprecated shims, and the advisory-lock
  approach they used does not survive the transaction pooler.

## 10. Privacy posture: the part the original plan omitted

Sick-leave records are health-adjacent personal data about named employees.
`docs/SECURITY_AND_PRIVACY_POSTURE.md` is a document handed to clients
including EHS, a UAE federal health authority, and it currently describes a
database holding event data. This module changes what is true, so:

- **That document gains a paragraph** naming the HR dataset, its legal basis
  (employment records under UAE labour law), its retention (kept after exit,
  deliberately, as gratuity evidence) and its access boundary (`HR_USER` plus
  `ADMIN`).
- **HR data enters the DR stream automatically**, since `pg_dump --schema=public`
  takes everything. That is correct and needs no work, but it should be stated
  rather than discovered.
- **Log lines must never carry an employee name together with a leave code.**
  Log `employeeId`, the date and the action. `/logs` is readable by the platform
  operator, and "who was off sick on the 14th" is not an operational question.
  The new `/admin/lookup` will resolve an `employeeId` to a name for whoever is
  entitled to it, which is exactly the split we want.
- **`AuditLog.changes` for an attendance write** records the code, not the
  remarks free-text, which is where a medical detail would realistically land.

## 11. UI (`src/app/(dashboard)/hr/*`, shadcn + TanStack Query)

1. **Attendance grid**: month view, employees by days, colour-coded codes,
   click to set with keyboard entry, bulk range dialog. Pre-joining and
   post-exit cells greyed, keeping visual parity with the workbook people
   already read.
2. **Employee list**: joining and exit dates, next grant date, carryover editor.
3. **Balances / Leave Summary**: per-employee card plus an org table mirroring
   the workbook's summary columns. Negative balances highlighted, never hidden.
4. **Dashboard**: headcount, on leave today, anniversaries due in 30 days,
   comp-off liability, over-entitlement flags. Today's figures labelled
   according to **D3**.
5. **Settings**: leave codes, public holidays, weekend configuration.

## 12. MCP tools (`src/lib/agent/tools/hr/*`)

`list_employees`, `get_leave_balance`, `mark_attendance` (single and range),
`get_attendance`, `hr_summary_report`, `set_exit_date`.

Registered in both the executor map and `mcp-server-builder.ts`, `source: "mcp"`
on every mutation, `package.json` version bumped on ship as the client
cache-invalidation hint. **Access is `ADMIN` or `HR_USER` only**: the org API
key is admin-equivalent everywhere else in this codebase, and that equivalence
has to be re-examined here before these tools ship, because an API key is not a
person and HR data is about people.

## 13. Excel import, and the gate that makes it trustworthy

`scripts/import-hr-excel.ts`, run once, against the v5.1 workbook. The workbook
is a zip of XML, so it can be read with the standard library; no new dependency
is needed, and reading the **formulas** rather than only the cached values is
what produced §3.

1. Employee Master into `Employee`, including joining, exit, carryover, opening
   sick used and opening comp-off. **Skip EMP024 and EMP025**, which are
   placeholder rows with the literal name `0` and no joining date.
2. Leave Codes sheet into `LeaveCode`, with the `dayWeight` and `countsAs`
   mapping.
3. Daily Attendance into `AttendanceEntry` for the **943 rows that carry
   information** (`AL`, `AL-HD`, `SL-F`, `SL-HD`, `OD`, `CO`, `WFH`, `ABS`) plus
   any `P`, `OFF` or `PH` that deviates from the computed default. The other
   7,256 are derivable and are not imported (§3.4).
4. **The gate: recompute every balance through `leaveBalanceService` and diff
   against the workbook's Leave Summary.** Print the diff table either way.

### 13.1 The reconciliation baseline (read from the workbook, Aug 27, 2026)

Entitlement is 30 for everyone except the three with an unreached first
anniversary. Every figure below must reproduce exactly, with one deliberate
exception.

| Emp | Name | Entitlement | AL taken | AL balance | Sick full | OD | C-off earned | C-off taken | C-off balance |
|---|---|---|---|---|---|---|---|---|---|
| EMP001 | Leena | 30 | 45 | **-15** | 0 | 2 | 0 | 0 | 0 |
| EMP002 | Nawfer | 30 | 30 | 0 | 0 | 4 | **1 → 0** | 0 | **1 → 0** |
| EMP003 | Muthu | 30 | 34 | -4 | 2 | 0 | 0 | 0 | 0 |
| EMP004 | Richard | 30 | 12 | 18 | 0 | 4 | 1 | 1 | 0 |
| EMP005 | Dinalyn | 30 | 1 | 29 | 4 | 5 | 4 | 4 | 0 |
| EMP006 | Vivek | 30 | 22 | 8 | 0 | 7 | 5 | 4 | 1 |
| EMP007 | Aimon | 30 | 12 | 18 | 1 | 0 | 0 | 0 | 0 |
| EMP008 | Bassem | 30 | 29 | 1 | 0 | 4 | 3 | 3 | 0 |
| EMP009 | Jinan | 30 | 9 | 21 | 1 | 2 | 1 | 0 | 1 |
| EMP010 | Mohammad Salah | 30 | 33 | -3 | 5 | 1 | 0 | 0 | 0 |
| EMP011 | Zaid | 30 | 33 | -3 | 0 | 6 | 2 | 4 | **-2** |
| EMP012 | Muhammad Ahsan | 30 | 15 | 15 | 6 | 0 | 0 | 0 | 0 |
| EMP013 | Tabian | 30 | 31 | -1 | 6 | 2 | 1 | 1 | 0 |
| EMP014 | Krishna | 30 | **9.5** | **20.5** | **1.5** | 0 | 0 | 0 | 0 |
| EMP015 | Saleh Mahmoud | 30 | 12 | 18 | 1 | 2 | 0 | 2 | **-2** |
| EMP016 | Sohail | 30 | 27 | 3 | 10 | 4 | 2 | 4 | **-2** |
| EMP017 | Karim | 30 | 5 | 25 | 0 | 0 | 0 | 0 | 0 |
| EMP018 | Nahil | 30 | 5 | 25 | 0 | 0 | 0 | 0 | 0 |
| EMP019 | Seif | 30 | 26 | 4 | 3 | 5 | 1 | 1 | 0 |
| EMP020 | Anisha Sodhi | 30 | 5 | 25 | 4 | 4 | 1 | 1 | 0 |
| EMP021 | Adelina | **0** | 23 | **-23** | 0 | 4 | 1 | 1 | 0 |
| EMP022 | Priyanka | **0** | 0 | 0 | 0 | 2 | 2 | 3 | **-1** |
| EMP023 | Burhan | **0** | 1 | -1 | 1 | 0 | 0 | 0 | 0 |

**The single expected difference is EMP002.** The workbook credits Nawfer one
comp-off for a Wed plus Thu OD pair; under the owner rule (§3.2) that earns
nothing, so the import produces 0 earned and 0 balance. Every other cell must
match to the digit, and the importer prints the EMP002 line as an expected
variance rather than a failure.

**Why these particular rows are the ones to watch**, since each is hidden by a
different plausible bug:

- **EMP021 at -23 with entitlement 0** fails if anything clamps a negative, and
  fails differently if the first-year gate is missing (she would show +7).
- **EMP001 at 45 taken** fails if the leave year is scoped to the service year
  rather than the calendar year, which is exactly the mistake the first draft of
  this plan made.
- **EMP014 at 9.5 and 1.5** fails if half-day weighting is wrong in either the
  annual or the sick path.
- **EMP011, EMP015, EMP016, EMP022 at negative comp-off** fail if comp-off is
  floored at zero.
- **EMP002** fails if the comp-off rule is copied from the workbook formula
  instead of the owner ruling.

The importer needs an **explicit bypass** for §5.5's write-time window
rejection, plus a pre-flight report of any row it would otherwise refuse.

## 14. Testing

Unit tests on `leaveBalanceService` are the core; the rest is plumbing. Port the
§13.1 baseline as fixtures, so the suite asserts against real numbers rather
than invented ones.

- **Comp-off:** Sat plus Sun earns 1; a lone Saturday earns 0; **Wed plus Thu
  earns 0** (the EMP002 case, and the one that fails if the workbook formula is
  copied); a Sat plus Sun straddling a month boundary still earns 1; OD after
  the exit date earns 0; a negative comp-off balance is preserved, not floored.
- **Annual:** one `AL` plus two `AL-HD` equals 2.0; entitlement is 0 before the
  first anniversary and 30 after it, with time frozen so the flip is asserted on
  the exact date; carryover 5 plus entitlement 30 minus 45 taken equals -10 and
  stays -10.
- **Leave year:** leave taken in December of one year does not count against the
  next year's balance. A joining date of 29 February resolves its anniversary
  the same way in `hasCompletedFirstYear` for every caller.
- **Sick:** one `SL-HD` is 0.5 in the full-pay tier; 15 full then 30 half then
  45 unpaid, with the tier boundaries asserted at 15 and 45 exactly.
- **Window:** exit on Sep 30 means annual leave on Sep 28 and 29 counts and
  Oct 5 is rejected; entries before joining are rejected; a duplicate
  `(employee, date)` is rejected.
- Integration tests per route including RBAC denials in both directions, and RLS
  tests per the Phase-2 template.

**Mutation-verify the four guards that fail silently**: remove the negative
clamp, the employment-window rejection, the first-year entitlement gate, and the
weekend-pair condition in the comp-off rule. Each removal must fail a specific
named test. A guard whose removal breaks nothing is not a guard.

## 15. Build order and gates

| Step | Gate |
|---|---|
| 0. Close every rule against the workbook | **DONE** (§3). D1, D2, D3 and both follow-ons are closed. |
| 1. Schema, two additive migrations, five RLS policies, availability gate, import boundary, seed catalogue | **DONE.** tsc, eslint, vitest, build green; `prisma validate` clean. Migration not yet applied to any database. |
| 2. Date primitives, leave-year and anniversary helpers, the comp-off rule, the effective-status resolver, the pure balance engine and the year-roll planner, plus 44 tests | **DONE.** Every §14 fixture passes; **five** mutation checks verified (clamping a negative, dropping the employment bound, removing the first-year gate, reverting comp-off to the workbook formula, capping carryover symmetrically). |
| 3. Employee and attendance services, REST routes, integration tests | RBAC denials both directions |
| 4. Excel import and reconciliation diff | **Exact match on every employee, or the import is not accepted** |
| 5. UI: grid, then balances, then dashboard, then settings | Browser-verified, both themes |
| 6. MCP tools, version bump plus lockfile | MCP clients reconnect |
| 7. Worker wiring, `EXPECTED_JOBS`, AGENTS.md invariants, CLAUDE.md entry, privacy paragraph | Full gate: tsc, eslint, vitest, build |

Each step is independently committable and independently revertable. If a real
conference lands mid-build, the conference wins: this schema is additive and
referenced by no live path, so pausing costs nothing.

## 16. Explicitly out of scope for v1

Payroll integration, WPS files, gratuity calculation (balances feed it, the
calculation itself is a separate piece of work), employee self-service portal,
biometric device ingestion, and a leave request and approval workflow. HR enters
attendance directly, exactly as today.

---

## 17. Standing rules: the redesign this plan did not anticipate (August 31, 2026)

The plan assumed one recording primitive, an `AttendanceEntry` per person per
day. That shipped, and the owner reported it as "a nightmare". **The data said
the form was not the problem.**

### 17.1 The measurement

Of the 386 work-from-home days imported from the workbook:

| shape | days | what it actually is |
| --- | ---: | --- |
| Twelve company-wide dates | 252 | 20 to 22 people all remote together: Ramadan Fridays, the full week 2–6 March, and 24–27 March after Eid |
| One permanently remote employee | 120 | spread evenly across every weekday, all year |
| Genuinely ad hoc | 14 | five people, scattered |

**386 rows were holding 27 facts.** March alone is 243 rows for what is 3
company days, 1 standing arrangement and 12 individual entries. The other 359
existed only because the schema had no way to say *"the company"* or
*"always"* — so every company decision was retyped once per person.

Annual leave, by contrast, was already well served: 34 recordings produced 419
days at an average block of 12.3. The range form was right for it all along.
**The entire complaint was WFH, and 97% of WFH volume was two missing concepts.**

### 17.2 `AttendanceRule`

Scope `ORG` or `EMPLOYEE`, a date range (`endDate` null means open-ended), a
leave code, and the organiser's own words for why. Migration
`20260831120000_add_attendance_rule`, additive and DO-guarded; RLS policy in
`prisma/rls/attendancerule.sql`; five harness assertions.

**It stores no days.** Creating a rule writes nothing per person and removing
one deletes nothing, because the days it covers were never rows — they are
derived at read time. That is what makes a rule reversible, and it is why the
delete is safe as a hard delete: nothing an operator typed can be lost, because
a rule is not a record of what somebody typed.

### 17.3 Precedence, which lives in exactly one place

`src/hr/lib/hr-effective-status.ts`, extended from §4:

1. Outside the employment window → `NOT_EMPLOYED`
2. An explicit `AttendanceEntry` → that entry
3. A public holiday → `PH`
4. A weekend → `OFF`. **A rule must never turn a Saturday into a working day**;
   only an explicit entry (an OD) can do that.
5. A standing rule → its code. `EMPLOYEE` beats `ORG`, because the narrower
   statement is the more specific one; within a scope the later start date wins,
   with the id as a stable tiebreak.
6. Otherwise → assumed `P`

`ruleFor` sorts internally rather than trusting the caller's ordering: a pure
function whose answer depends on the order it was handed is not pure enough to
trust with a payroll number.

### 17.4 The half that costs money

A rule can carry **any** leave code, so a company-wide shutdown booked as `AL`
has to reach the balance engine. Both paths — one employee, and the org summary
— expand rules through `ruleDerivedDays`, bounded by `candidateDates` rather
than by the employment window (walking every day since 2010 for a long-serving
employee is ~5,800 iterations per person, and a day no rule covers cannot be
changed by one).

Skipping this would let ONE record hand twenty-three people free annual leave
with nothing on screen to show it. Because that failure is silent, the adoption
is asserted at **source level in both places** and mutation-verified: dropping it
from the summary path alone fails the guard while every other test stays green.
This is the "a guard that exists but is never called" lesson applied in advance.

### 17.5 The grid became the input

Drag across cells and press a key. The five codes that are 99.3% of every entry
(`AL`, `WFH`, `SL-F`, `OD`, `CO`) carry shortcuts; the other sixteen sit behind
an inline "Another code" list. The grid now imports the shared resolver instead
of the second copy of the precedence its own header had already worried about.

**A bug worth keeping for its shape.** The secondary codes were first a Radix
`Select`, and picking one silently did nothing — not for one code, for all
sixteen. Radix renders the list in a **portal**, so an option is not a DOM
descendant of the popover; the click-away handler read the click as "outside",
unmounted the popover and took the `Select` with it before `onValueChange` could
fire. Popover closed, no toast, no error, **zero network requests**. Generalise
it: **a portal breaks every "is this click inside me?" check**, and *zero*
requests is what distinguishes "the handler never ran" from "it ran and failed".
The guard is structural — that popover may contain no `Select`, `Popover`,
`Dialog`, `DropdownMenu`, `Tooltip` or `createPortal`.

### 17.6 Deliberately not built

**A weekday filter ("every Friday").** The imported data refuses it: individual
non-company WFH is spread evenly across all five weekdays, and a contiguous
range covers every real case in the file. It is an additive column the day that
stops being true.
