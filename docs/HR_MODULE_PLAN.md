# HR Module: Attendance & Leave Tracker (UAE)

> **Status: PLANNED, NOT BUILT (August 27, 2026).** No schema, no migration, no
> code. This file is the plan of record; the source it was written from is the
> validated Excel tracker `UAE_Employee_Attendance_Leave_Tracker_2026` (v5.1),
> which is the business-logic reference. Where this document and the workbook
> disagree, the workbook wins and this document is wrong.
>
> **Three rules are OPEN (§3) and block the build.** Each has a definite answer
> inside the workbook. Do not start §14 step 1 until all three are closed, and
> do not guess: two of the three are the kind of rule that produces plausible
> numbers while being wrong, which is the worst failure mode a leave tracker has.
>
> **Sequencing note.** `docs/PLATFORM_DECISIONS.md` §7 records per-tenant Stripe
> and AI keys as the next build priority. The CRM, which is the closest
> comparable in scope, took roughly a month. Building HR first reorders that,
> and that is an owner decision, recorded here so nobody later assumes it was an
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

## 3. OPEN decisions (blocking)

### D1. Comp-off on a run longer than two days

The stated rule is: *an OD day whose immediately preceding calendar day (same
employee) is also OD earns exactly one comp-off.* That yields N−1 for a run of
N consecutive OD days. Sat plus Sun gives 1, which matches. A lone OD day gives
0, which matches. But Friday plus Saturday plus Sunday gives **2**.

Art. 28 FDL 33/2021 is usually read as one compensating day (or 50% extra pay)
per rest day worked, which would give **3** for that run. The pair rule and the
per-day rule agree on every two-day case and diverge on every longer one.

**Question: what does the workbook produce for a three-day OD run?** If the
answer is 2, the pair rule is correct and gets a comment explaining that it is
deliberate and not an off-by-one. If the answer is 3, the rule is "one per OD
day that falls on a rest day or holiday" and the pairing is an artefact.

### D2. Do unused prior-year annual leave days vanish?

§5.1 computes the balance as `current grant + carryoverDays − taken in the
current service year`. On the second anniversary the year-one grant is replaced
rather than added to, so any unused year-one days disappear unless HR types
them into `Employee.carryoverDays` by hand.

That is very likely what the workbook does, and it is a legitimate policy
(UAE law permits carryover limits by contract). It is recorded here because in
code it will read as a lost-update bug to whoever maintains this next.

**Question: confirm that prior-year remainder is manual-only.** If confirmed,
`leaveBalanceService` carries a named comment saying so, and the dashboard shows
"unused days from last year are not carried automatically" beside the carryover
field so HR is reminded at the moment it matters.

### D3. Derived-present versus recorded-present

§4 stores no row for an ordinary working day, and resolves an absent row to
Present at query time. That is the right call for storage (it removes the
phantom-row and pre-fill-cleanup class of bug the workbook has) but it has one
consequence worth accepting knowingly: **the system cannot distinguish "this
person was present" from "nobody has recorded anything yet".**

For a historical month that distinction is academic. For two cases it is not:

1. **Today's dashboard** shows everyone present before anyone has opened the
   grid, which is a confident-looking wrong answer.
2. **End-of-service evidence.** Gratuity and leave encashment are computed from
   this data. A derived P is an inference; a recorded P is a record.

**Question: do we need a "month finalised" marker**, set by HR, after which the
month's derived days are frozen into real rows? Or is derived-present
acceptable, with the dashboard simply labelling today's figures "unconfirmed"?

The cheap answer is the label. The durable answer is the marker. Either is
fine, but it must be chosen before the schema, because the marker is a table.

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

### 4.2 Service year is one helper, used everywhere

Annual grants (§5.1) and sick tiers (§5.3) both reset on the employment
anniversary. That boundary is computed by exactly one function,
`serviceYearFor(employee, date)`, and both consumers call it. Two
implementations of the same anniversary maths that disagree on leap years or on
a joining date of 29 February is a defect nobody would find until the year it
mattered. This is the no-cross-caller-duplication rule (AGENTS.md).

---

## 5. Business rules

Every rule below is validated in the workbook. Implement exactly; do not
invent, and do not "improve" one because it looks inconsistent with another.

### 5.1 Annual leave: anniversary lump model

- **30 days granted as a lump on each service anniversary** (joining date plus
  12·n months), materialised as `LeaveGrant` rows by a daily worker job, with an
  idempotent upsert on `(employeeId, serviceYear)`. Grants are auditable events,
  not a formula, so that "why does this person have 30 days" has an answer with
  a date on it.
- **Nothing accrues before the first anniversary.** New joiners have zero
  entitlement until then. The law's pro-rata minimum for months 7 to 12 was
  explicitly declined as company policy, so the reader carries a config flag
  `accrueProRataFirstYear` defaulting to `false`, which lets that reverse later
  without a schema change.
- **Carryover is a manual HR field** (`Employee.carryoverDays`), added on top.
  See **D2**.
- **Balance** = current grant + carryover − annual leave taken in the current
  service year.
- **Negative balances are allowed, displayed, and never clamped.** They
  represent leave taken in advance, which is legal by mutual agreement and is
  present in the live data (EMP021 sits at −23 before their anniversary). A
  `Math.max(0, …)` anywhere in this module is a bug. The dashboard surfaces
  negatives prominently rather than hiding them.
- Each employee exposes a **next grant date**.

### 5.2 Half days

- `AL-HD` and `SL-HD` carry `dayWeight = 0.5`.
- `AL-HD` debits the annual balance. `SL-HD` debits the **full-pay sick tier**.
- **Naming invariant, and it is a trap:** `-HD` means half **day**; `SL-H`
  means half **pay** (days 16 to 45 of the Art. 31 tiers). `SL-H` and `SL-HD`
  are different concepts that differ by one character. Both stay, both get a
  comment, and the UI never abbreviates them further.

### 5.3 Sick leave tiers (Art. 31 FDL 33/2021)

Per service year: first 15 days full pay (`SL-F`), next 30 half pay (`SL-H`),
next 45 unpaid (`SL-U`). Consumption is tracked per tier and the balances view
shows all three, because "days of sick leave left" is not a single number.

### 5.4 On-Duty and Comp-Off (Art. 28)

- `OD` marks working a weekly off or a public holiday, for example delivering a
  conference on a Saturday.
- Comp-off earning follows **D3 §3, once answered**. Comp-off balance is
  computed from data (earned minus taken), never stored as a counter, so it
  cannot drift out of agreement with the entries it summarises.
- `CO` marks taking an earned comp-off. Taking `CO` with a zero balance is a
  **warning by default**, with a config flag to make it a hard block.
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
- `PublicHoliday` is seeded with the confirmed 2026 UAE list: Jan 1;
  Mar 19 to 20 (Eid al-Fitr); May 26 to 29 (Arafat and Eid al-Adha); Jun 15
  (Islamic New Year); Aug 28 (Prophet's Birthday); Dec 2 to 3 (National Day).
  Admin CRUD for future years. **No auto-generation:** Islamic dates are
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

`scripts/import-hr-excel.ts`, run once, against the v5.1 workbook:

1. Employee Master into `Employee`, including joining, exit and carryover.
2. Leave Codes sheet into `LeaveCode`, with the `dayWeight` and `countsAs`
   mapping.
3. Daily Attendance into `AttendanceEntry` for explicit leave, OD, CO and WFH
   codes, **and any P or OFF that deviates from the computed default**. Rows
   matching the default pattern are skipped, because they are derivable (§4).
4. **The gate: recompute every balance through `leaveBalanceService` and diff
   against the workbook's Leave Summary sheet. The import is accepted only when
   annual taken, annual balance, all three sick tiers and comp-off match exactly
   for every employee.** Print the diff table either way.

Two live figures must reproduce, and they are chosen because each would be
hidden by a plausible bug: **EMP021 at −23 before their anniversary** fails if
anything clamps a negative balance, and **EMP001 at 45 annual days taken** fails
if half-day weighting or the service-year boundary is wrong.

The importer needs an **explicit bypass** for §5.5's write-time window
rejection, plus a pre-flight report of any row it would have refused, since the
workbook can hold rows the app will not accept.

## 14. Testing

Unit tests on `leaveBalanceService` and `accrualService` are the core; the rest
is plumbing. Port the workbook's validated scenarios as fixtures:

- OD pair earns 1 comp-off; a lone OD earns 0; OD after the exit date earns 0;
  **a three-day run earns whatever D1 resolves to**.
- One `AL` plus two `AL-HD` equals 2.0 days. One `SL-HD` is 0.5 in the full-pay
  tier.
- Exit on Sep 30: annual leave on Sep 28 and 29 counts, Oct 5 is rejected.
- Anniversary flip: entitlement goes 0 to 30 on the anniversary date exactly,
  with time frozen in the test. Cover the Sep 1 and Oct 16 2026 cohorts.
- Carryover 5 plus grant 30 minus 45 taken equals −10, and stays −10.
- Rejections: before joining, after exit, duplicate `(employee, date)`.
- Integration tests per route including RBAC denials in both directions.
- RLS tests per the Phase-2 template: cross-org read and write must fail.

**Mutation-verify the three guards that fail silently**: remove the negative
clamp guard, the employment-window rejection and the service-year boundary in
turn, and confirm the right test fails each time. A guard whose removal breaks
nothing is not a guard.

## 15. Build order and gates

| Step | Gate |
|---|---|
| 0. Close D1, D2, D3 against the workbook | **Blocking. No code before this.** |
| 1. Schema, migration, RLS policies, seeds (leave codes, 2026 holidays) | Migration replays from empty; `check-tenant-als.sh` green |
| 2. `serviceYearFor`, `leaveBalanceService`, `accrualService` plus unit tests | Every §14 fixture passes; three mutation checks verified |
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
