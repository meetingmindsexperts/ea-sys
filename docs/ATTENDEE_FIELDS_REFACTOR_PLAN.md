# Attendee-field consolidation — implementation plan (#2)

> Status: **PLAN — not yet implemented.** Created July 2, 2026.
> Part of the registration-routes duplication cleanup (see CLAUDE.md → Recent
> Features → "Registration route dedup"). #4 (`ensureRegistrantAccount`) and #3
> (`buildEventConfirmationFields`) shipped; this is #2, reframed from "low-value
> dedup" to **"defuse a real drift footgun."**

---

## 1. The footgun (why this is worth doing)

There is **no single definition of "the set of attendee profile fields."** The
`Attendee` model has ~24 writable profile columns, and they are re-listed —
each with its own ad-hoc null-normalization — across:

- **8** `attendee.create` sites
- **9** `attendee.update` sites
- **15** `syncToContact` sites (the org Contact mirror carries the same field set)

**Concrete proof this bites:** the July 2, 2026 "Attendee Role" rollout added one
column (`role`) and had to be hand-wired into the public forms, registration PUT,
speaker PUT, abstract-start prefill, CSV import, the Add-Registration form + dialog,
contacts POST/PUT, speaker-companion, and every `syncToContact` call. It was easy
to miss a path — and a missed path is **silent data loss** (the field just stays
null), not a crash. That is the footgun: *add-a-column → hunt-N-sites → miss-one →
silent loss.*

### What is NOT the problem (and why a naive "builder" fails)
Each caller **sources its values differently** — validated Zod vars (`register`),
`getField(fields, idx.x)` (CSV), nested EventsAir shapes (`contact.primaryAddress?.city`),
pre-normalized locals (`registration-service`). That per-caller *extraction* is
inherent and cannot be shared. A builder that just re-applies `|| null` would
**relocate the field list without removing the extraction** — which is why #2 was
first judged low-value. The value is **not** dedup of code; it is a **single field
contract with compile-time + schema-time completeness enforcement.**

---

## 2. Goal & non-goals

**Goal:** make "the attendee field set" defined in **exactly one place**, such that:
1. Adding a column to `Attendee` **fails a test** until the contract is updated
   (schema → contract guard).
2. A create path that doesn't account for a contract field **fails to compile**
   (contract → caller guard).
3. Update + contact-sync paths share the same field *vocabulary* so they can't
   silently diverge.

**Non-goals:**
- Do **not** try to share value *extraction* (unavoidably per-caller).
- Do **not** fold the create paths into `registration-service` (that's cleanup #1,
  and public-register / MCP-bulk are intentionally out of the service).
- Do **not** change any persisted behavior. Every conversion is byte-equivalent
  (explicit `null` ≡ omitted for a nullable create column).
- Do **not** touch `externalId` (EventsAir-import-only, not a shared profile field)
  or system columns (`id`, `createdAt`, `updatedAt`, relations).

---

## 3. Grounded site inventory

### `attendee.create` (8)
| Site | Fields set | Value source | Notes |
|---|---|---|---|
| `services/registration-service.ts` | ~25 (superset) | pre-normalized locals | canonical shape |
| `public/events/[slug]/register/route.ts` | ~21 | validated Zod vars | no photo/bio/tags/customFields |
| `import/registrations/route.ts` (CSV) | ~20 | `getField()` | no additionalEmail/customSpecialty/studentIdExpiry |
| `import/eventsair/route.ts` | ~11 | nested `contact.*` | **+ `externalId`** (import-only) |
| `agent/tools/registrations.ts` (MCP bulk) | ~? | tool input | verify during Phase A |
| `lib/speaker-companion.ts` | ~18 | `CompanionSpeakerInput` (already typed) | companion "attendee facet" |
| `registrations/[registrationId]/email/route.ts` | ? | ? | **INVESTIGATE** — why does an email route create an attendee? |
| `import-contacts/route.ts` | 6 (minimal) | `contact.*` | most sparse |

### `attendee.update` (9)
`registrant/registrations`, `public/.../complete-registration`, `public/.../register`
(orphan-reuse), `public/.../survey`, `speakers/[id]/email`, `registrations/bulk-tags`,
`registrations/[id]` (PUT), `registrations/[id]/email`, `agent/tools/registrations`.
Semantics differ from create: **partial** (`field !== undefined ? … : leave`) — so
these use a *partial* input + a different assembler.

### `syncToContact` (15)
`registrant/registrations`, `complete-registration`, `register`, `submitter`,
`speakers/[id]`, `reviewers`, `import/eventsair`, `import/registrations`,
`registrations/[id]`, `services/speaker-service`, `services/registration-service`,
`lib/contact-sync` (the sink), `lib/event-stats`, `agent/tools/speakers`,
`agent/tools/registrations`. Already funnels through one function
(`syncToContact`) — so the field *set* is centralized at the sink, but each
*caller* still builds the payload by hand (same drift surface).

---

## 4. Design

New leaf module **`src/lib/attendee-fields.ts`** (no Prisma client import at module
load beyond types — safe for any server caller; NOT imported by client components).

### 4.1 The canonical contract
```ts
import type { Title, AttendeeRole, Prisma } from "@prisma/client";

/**
 * Every writable Attendee *profile* field, at its normalized target type.
 * REQUIRED (not optional) on purpose: a create caller must explicitly provide
 * a value or `null` for each — so adding a field here breaks every create path
 * at compile time until it's considered. Excludes system columns (id/timestamps),
 * relations, and the import-only `externalId`.
 */
export interface AttendeeProfileInput {
  title: Title | null;
  role: AttendeeRole | null;
  email: string;              // required-non-null (identity)
  firstName: string;          // required-non-null
  lastName: string;           // required-non-null
  additionalEmail: string | null;
  organization: string | null;
  jobTitle: string | null;
  phone: string | null;
  photo: string | null;
  city: string | null;
  state: string | null;
  zipCode: string | null;
  country: string | null;
  bio: string | null;
  specialty: string | null;
  customSpecialty: string | null;
  registrationType: string | null;
  tags: string[];             // [] when none
  dietaryReqs: string | null;
  associationName: string | null;
  memberId: string | null;
  studentId: string | null;
  studentIdExpiry: Date | null;
  customFields: Prisma.InputJsonValue;   // {} when none
}
```

### 4.2 The assemblers
```ts
/** CREATE: trivial passthrough — the caller already normalized to the target
 *  types, so this is mostly a compile-time completeness gate. Returns the data
 *  object (minus relations); caller adds attendeeId/externalId/etc. as needed. */
export function buildAttendeeCreateData(input: AttendeeProfileInput):
  Omit<Prisma.AttendeeUncheckedCreateInput, "id" | "createdAt" | "updatedAt" | "externalId" | "registrations">;

/** UPDATE: partial. Only the provided keys are written; `undefined` = leave
 *  unchanged (Prisma semantics the current PUT/complete-registration rely on).
 *  Preserves each field's existing "clear with null" vs "skip" behavior. */
export function buildAttendeeUpdateData(patch: Partial<AttendeeProfileInput>):
  Prisma.AttendeeUpdateInput;
```

### 4.3 The two guards that actually kill the footgun
1. **Compiler guard (contract → callers):** `AttendeeProfileInput` is all-required.
   Add a field → every `attendee.create` caller fails to compile until it passes
   the value or an explicit `null`. No more silent omission.
2. **Schema guard (schema → contract):** a unit test drives
   **`Prisma.AttendeeScalarFieldEnum`** (a runtime object of every scalar column
   name) and asserts each column is either present in `AttendeeProfileInput` or in
   an explicit `EXCLUDED` allowlist (`id`, `createdAt`, `updatedAt`, `externalId`).
   Add a column to `schema.prisma` → this test **fails** until the contract is
   updated. This is the linchpin — the schema can no longer drift ahead of the
   contract unnoticed.

> Together: schema ⇄ contract ⇄ callers, both directions compiler/test-enforced.

---

## 5. Phasing (each phase independently shippable + gated + reviewed)

**Phase A — create paths + both guards (the core value).**
- Add `attendee-fields.ts` (contract + `buildAttendeeCreateData`).
- Add the `Prisma.AttendeeScalarFieldEnum` exhaustiveness test + unit tests.
- Convert the create callers, each byte-equivalent, one at a time:
  1. `registration-service` (superset — validates the contract covers everything).
  2. `register` (hot path — review checkpoint).
  3. CSV import, eventsair (+ keep `externalId` outside the builder).
  4. MCP bulk, import-contacts, speaker-companion (already-typed inputs — adapt).
  5. Investigate + convert (or document-as-exempt) `registrations/[id]/email`.
- **Gate after each caller** (tsc/eslint/vitest/build); this is where the footgun
  is defused — ship Phase A even if B/C slip.

**Phase B — update paths.**
- Add `buildAttendeeUpdateData(patch)`; convert the 9 update sites. Preserve the
  `!== undefined` partial semantics exactly (unit-test the "skip vs clear" matrix).

**Phase C — contact-sync alignment (largest surface, optional).**
- Re-type `syncToContact`'s input to reuse the `AttendeeProfileInput` subset so a
  new field flows to the Contact mirror too. Highest footgun payoff (Role had to
  touch all 15), but touches the most sites — do last, own PR.

---

## 6. Behavior-preservation strategy
For every converted caller: field-by-field diff the emitted `data` object against
the original. Rules that keep it byte-equivalent:
- **Create:** explicit `null` ≡ previously-omitted (nullable columns default null).
  Document any field a caller previously omitted that now becomes explicit null.
- **Update:** `undefined` must still mean "leave unchanged"; the assembler only
  emits keys present in `patch`. No field that was previously conditional may
  become unconditional.
- Enum/Date/Json coercion stays at the call site (before building the input);
  the builder never parses.

---

## 7. Testing
- **Exhaustiveness** (`Prisma.AttendeeScalarFieldEnum` vs contract + allowlist) — the
  schema-drift guard.
- **`buildAttendeeCreateData`**: full map, null normalization, `tags: []` /
  `customFields: {}` passthrough, Date passthrough.
- **`buildAttendeeUpdateData`**: skip-vs-clear matrix (undefined skips, null clears,
  value sets).
- Existing per-route unit tests + e2e (`manual-registration`, public register)
  remain the integration guard — they must stay green with zero edits (proof of
  behavior preservation).

---

## 8. Risk & prod-safety
- **Additive** (new leaf module); no schema, no migration.
- **Phased**, bounded blast radius per PR; hot paths (`register`, `service`) get the
  byte-equivalence discipline + independent review checkpoint used for #3/#4.
- **Rollback:** revert the per-caller commit; the builder is inert if unused.
- **Live-prod caveat:** these are registration write paths on a live system — each
  caller conversion is its own reviewed, gated commit; do not batch.

---

## 9. Decisions to confirm before coding
1. **All-required contract** (my recommendation — it's the compiler guard) vs a
   softer all-optional contract (less enforcement, easier adoption). Required is
   the whole point; confirm we accept the verbosity (e.g. eventsair passing ~13
   explicit `null`s).
2. **Scope now:** Phase A only (defuses the footgun) and defer B/C? — recommended,
   ship the guard fast.
3. **`registrations/[id]/email` create site** — needs investigation; it may be a
   distinct concern (not a registration create) and get exempted (added to the
   test allowlist with a reason) rather than converted.
4. **customFields typing** — `Prisma.InputJsonValue` vs a narrower record; confirm
   the create callers that set it (service, MCP) are happy with the shared type.
