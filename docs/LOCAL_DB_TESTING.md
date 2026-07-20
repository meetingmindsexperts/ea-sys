# Local DB testing — driving money/state flows without touching prod

Local `npm run dev` points at the **production** Supabase DB (deferred until dev-DB
separation lands). That makes it unsafe to click through money-mutating flows
(cancel / refund / credit note) locally. This is the workaround: a **local
Postgres** (`ea_sys_test` — the same DB the Playwright e2e suite uses) plus
seeded scenarios and a verification harness, so those flows can be exercised
against real DB rows and the real service code, not synthetic unit inputs.

This closes the gap that let the "−$157.50 on a cancelled Pending registration"
regression ship: the unit tests passed hand-built `paidTotal` values; the bug
only appeared when a **real** Pending registration (no Payment rows) hit the
route's `paidTotal` fallback. `verify:cancel` reproduces exactly that.

## Prerequisites

- Local Postgres running (`pg_isready` → accepting connections).
- `.env.local` has `DATABASE_URL_TEST` pointing at the local DB, e.g.
  `postgresql://<you>@localhost:5432/ea_sys_test`. (Already set in this repo.)
- The DB exists: `createdb ea_sys_test` if not.

## Fast path — verify the cancel financials (no browser, no dev server)

```bash
npm run verify:cancel
```

Re-seeds two registrations (one PAID, one PENDING) into the local DB, then runs
the **real** `payment-service.cancelRegistration` + the **real** financials
compute helpers against them and asserts:

- Cancelling a **PENDING** reg → `retained = 0`, no credit-note prompt → the UI
  shows **Amount Due 0** (the fixed bug).
- Cancelling a **PAID** reg (Just cancel) → `retained = 157.50` "credit owed" +
  credit-note prompt (the correct behaviour).

Exit code is non-zero on any mismatch, so it's CI-able if we ever want it.

## Full path — drive the flow in a real browser (like e2e)

The browser drive needs the dev port free (a running `npm run dev` holds
`.next/dev/lock`, so a second server can't start — same constraint as
`npm run test:e2e`). **Stop your prod dev server first**, then:

```bash
npm run db:local:setup            # push schema + seed e2e base + cancel scenarios
DATABASE_URL="$DATABASE_URL_TEST" DIRECT_URL="$DATABASE_URL_TEST" \
  NEXTAUTH_URL=http://localhost:3200 NEXT_PUBLIC_APP_URL=http://localhost:3200 \
  npx next dev -p 3200
```

Log in as `admin@test.local` / `password123`, open the E2E Test Event →
Registrations, and open **Priya Pending** (owes money) or **Paul Paid**. The
seeded event has 5% VAT and an "Early Bird — USD 150" tier so the totals match
the reported screenshot.

## Files

- `prisma/seed-local-cancel-scenarios.ts` — idempotent scenario rows (fixed ids
  `local-reg-pending` / `local-reg-paid`). Runs on top of `prisma/seed-e2e.ts`.
- `prisma/verify-cancel-financials.ts` — the real-service/real-DB assertion
  harness. Mirrors the detail route's financials assembly faithfully.
- Scripts: `db:local:setup`, `db:local:seed-cancel`, `verify:cancel`.

## Adding a scenario

Extend `seed-local-cancel-scenarios.ts` with more fixed-id rows (keep it
idempotent — delete-then-create), and add assertions to
`verify-cancel-financials.ts`. Whenever you touch financials, add the
per-payment-state cell you're changing here, not just a unit test — that's the
layer that catches the "trusted a fallback value" class of bug.
