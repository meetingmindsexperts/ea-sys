# Scheduled Emails — How It Works

A practical guide to the scheduled-communications feature: what it is, how the
moving parts fit together, what can go wrong, and how to operate it. This is
the first scheduled-job system in this codebase, so it covers the design
choices in plain English.

---

## 1. What it does

Organizers can write a bulk email today and have it sent **at a later moment**
they pick (e.g. "remind unpaid registrants 3 days before the event", "send the
agenda Monday at 9 am"). The email lives in the database as a `ScheduledEmail`
row in `PENDING` state until a background worker picks it up at the right time
and dispatches it through the existing bulk-email pipeline.

It is layered **on top of** the existing immediate-send flow — the
`BulkEmailDialog` simply has a "Send now / Schedule for later" toggle. Recipient
selection, attachments, custom subject/message, and the rate limit are all
shared between the two paths.

---

## 2. The big picture

```
┌───────────────────────────┐
│ Organizer in Communications│
│ page picks audience &      │
│ writes email               │
└─────────────┬──────────────┘
              │
              ▼
   "Schedule for later" toggle
              │
              ▼
┌───────────────────────────┐         ┌──────────────────────┐
│ POST /api/.../schedule     │ ──────▶ │ ScheduledEmail row   │
│ • validates input          │         │ status = PENDING     │
│ • shares 20/hr rate bucket │         │ filters stored as is │
└───────────────────────────┘         └──────────┬───────────┘
                                                  │
                                                  │ time passes…
                                                  │
                                                  ▼
                                      ┌───────────────────────┐
                                      │ /api/cron/             │
                                      │ scheduled-emails       │
                                      │ Bearer $CRON_SECRET    │
                                      └──────────┬────────────┘
                                                  │
                                          every minute
                                                  │
                                                  ▼
                              ┌─────────────────────────────────┐
                              │ For each due PENDING row:       │
                              │ 1. Atomic claim → PROCESSING    │
                              │ 2. Resolve recipients fresh     │
                              │ 3. executeBulkEmail()           │
                              │ 4. Update → SENT or FAILED      │
                              └─────────────────────────────────┘
```

The cron worker is just an HTTP endpoint protected by a shared secret. Whatever
runs the cron — Linux `cron` on EC2, Vercel Cron, GitHub Actions, an external
uptime monitor — `POST`s (or `GET`s) to it on a schedule. **The Next.js process
itself never runs a background timer.**

---

## 3. Files involved

### Backend

| File | Role |
|---|---|
| [`src/lib/bulk-email.ts`](../src/lib/bulk-email.ts) | Shared `executeBulkEmail()` helper used by both immediate-send and the cron worker. Owns recipient resolution, template loading, per-recipient rendering, batched dispatch. Also exports `bulkEmailSchema` and the `BulkEmailError` class. |
| [`src/app/api/events/[eventId]/emails/bulk/route.ts`](../src/app/api/events/[eventId]/emails/bulk/route.ts) | POST — immediate send. Refactored to delegate to `executeBulkEmail()`. |
| [`src/app/api/events/[eventId]/emails/schedule/route.ts`](../src/app/api/events/[eventId]/emails/schedule/route.ts) | POST = create scheduled row, GET = list rows for the event. |
| [`src/app/api/events/[eventId]/emails/schedule/[id]/route.ts`](../src/app/api/events/[eventId]/emails/schedule/[id]/route.ts) | PATCH = edit (subject / message / sendAt), DELETE = cancel. Both use atomic conditional updates. |
| [`src/app/api/events/[eventId]/emails/schedule/[id]/retry/route.ts`](../src/app/api/events/[eventId]/emails/schedule/[id]/retry/route.ts) | POST = re-queue a `FAILED` row as `PENDING`. |
| [`src/app/api/cron/scheduled-emails/route.ts`](../src/app/api/cron/scheduled-emails/route.ts) | The cron worker. `Bearer $CRON_SECRET` auth. Sweeps stuck rows, claims due rows, processes them in parallel. |

### Frontend

| File | Role |
|---|---|
| [`src/components/bulk-email-dialog.tsx`](../src/components/bulk-email-dialog.tsx) | The audience-pick dialog with the `Send now / Schedule for later` toggle and datetime picker. |
| [`src/components/communications/scheduled-emails-list.tsx`](../src/components/communications/scheduled-emails-list.tsx) | The "Scheduled Emails" table on the Communications page (status badges, edit / cancel / retry actions). |
| [`src/components/communications/scheduled-email-edit-dialog.tsx`](../src/components/communications/scheduled-email-edit-dialog.tsx) | Lightweight dialog for editing subject / message / sendAt of a `PENDING` row. |
| [`src/app/(dashboard)/events/[eventId]/communications/page.tsx`](../src/app/(dashboard)/events/[eventId]/communications/page.tsx) | Renders `<ScheduledEmailsList>` below the audience cards. |
| [`src/hooks/use-api.ts`](../src/hooks/use-api.ts) | React Query hooks: `useScheduledEmails`, `useScheduleBulkEmail`, `useUpdateScheduledEmail`, `useCancelScheduledEmail`, `useRetryScheduledEmail`. |

### Database

| File | Role |
|---|---|
| [`prisma/schema.prisma`](../prisma/schema.prisma) | `ScheduledEmail` model + `ScheduledEmailStatus` enum. |
| [`prisma/migrations/20260410000000_add_scheduled_emails/`](../prisma/migrations/20260410000000_add_scheduled_emails/) | Migration that creates the table. |

---

## 4. Data model

```prisma
enum ScheduledEmailStatus {
  PENDING      // queued, waiting for scheduledFor
  PROCESSING   // claimed by a cron tick, currently sending
  SENT         // delivered (with successCount/failureCount stats)
  FAILED       // terminal failure during processing
  CANCELLED    // user cancelled while still PENDING
}

model ScheduledEmail {
  id             String   @id @default(cuid())
  eventId        String   // scoping
  organizationId String   // scoping
  createdById    String   // who scheduled it (used as the email's organizer/replyTo)

  recipientType  String   // "speakers" | "registrations" | "reviewers" | "abstracts"
  emailType      String   // "invitation" | "confirmation" | "reminder" | "custom" …
  customSubject  String?
  customMessage  String?  @db.Text
  attachments    Json?    // [{ name, content (base64), contentType }]
  filters        Json?    // { status?, ticketTypeId? }  ← stored as-is

  scheduledFor   DateTime
  status         ScheduledEmailStatus @default(PENDING)
  sentAt         DateTime?
  successCount   Int?
  failureCount   Int?
  totalCount     Int?
  lastError      String?  @db.Text
  retryCount     Int      @default(0)

  @@index([status, scheduledFor]) // cron picker
  @@index([eventId, status])      // list view
}
```

The two indexes matter:

- `(status, scheduledFor)` is what the cron uses to find due rows. Without it, every tick would table-scan.
- `(eventId, status)` is what the list endpoint uses when an organizer opens the page.

### Why filters, not snapshot recipient IDs

When the organizer picks "all unpaid registrants" we save **the filter**
(`{ status: "UNPAID" }`), not the list of registration IDs. When the cron fires
30 hours later, it re-runs the query — so anyone who paid in the meantime is
**automatically excluded**. This is by design and is the most important property
to remember about the feature.

The trade-off: the count shown in the dialog at scheduling time is not
guaranteed to match the count actually sent. The UI tells the user this in a
small note under the datetime picker.

---

## 5. The state machine

```
                     ┌─────────────┐
              ┌────▶ │  CANCELLED  │  (terminal)
              │      └─────────────┘
              │  user cancels
              │
   create  ┌──┴───┐  cron claims    ┌──────────┐
  ────────▶│PEND. │ ───────────────▶│PROCESSING│
           └──┬───┘                 └────┬─────┘
              ▲                          │
              │                          │  send finishes
              │                          │
              │                  ┌───────┴───────┐
              │                  ▼               ▼
              │            ┌──────────┐    ┌──────────┐
              │            │   SENT   │    │  FAILED  │
              │            └──────────┘    └────┬─────┘
              │             (terminal)          │
              │                                 │
              └─── user clicks Retry ───────────┘
```

| From          | To           | Trigger                            | Atomic? |
|---|---|---|---|
| `PENDING`     | `PROCESSING` | Cron worker claim                  | Yes (`updateMany where status=PENDING`) |
| `PENDING`     | `CANCELLED`  | DELETE `/schedule/[id]`            | Yes (`updateMany where status=PENDING`) |
| `PENDING`     | `PENDING`*   | PATCH `/schedule/[id]` (edit)      | Yes (`updateMany where status=PENDING`) |
| `PROCESSING`  | `SENT`       | Cron worker after `executeBulkEmail` returns |  — |
| `PROCESSING`  | `FAILED`     | Cron worker if `executeBulkEmail` throws | — |
| `PROCESSING`  | `FAILED`     | Stuck-row sweeper (after 10 min)   | Yes (`updateMany where status=PROCESSING and updatedAt < cutoff`) |
| `FAILED`      | `PENDING`    | POST `/schedule/[id]/retry`        | Yes (`updateMany where status=FAILED`) |

\* "Edit" is a state-preserving transition — the row stays `PENDING`.

**Why so many `updateMany` instead of `update`?**
Because the cron worker and the user can race each other. If we did
`findFirst` → check `status` → `update`, the cron could grab the row in
between. With `updateMany({ where: { id, status: <expected> } })` Postgres
takes a row lock as part of the UPDATE, so exactly one of the two operations
wins. If the user's update returns `count: 0`, the API returns `409 Conflict`
and the UI tells them the row already moved on.

---

## 6. The cron worker, in detail

[`src/app/api/cron/scheduled-emails/route.ts`](../src/app/api/cron/scheduled-emails/route.ts)

A single tick does six things, in order:

### Step 1 — Auth
Reject anything without `Authorization: Bearer $CRON_SECRET`. Logs a `warn`
on rejection so brute-force attempts show up in `/logs`.

### Step 2 — Sweep stuck rows
```ts
db.scheduledEmail.updateMany({
  where: { status: "PROCESSING", updatedAt: { lt: now - 10min } },
  data: { status: "FAILED", lastError: "Stuck in processing for >10 min …" }
});
```

If a previous tick crashed mid-send (server restart, OOM, segfault, deploy)
the row would otherwise be wedged in `PROCESSING` forever. The sweep flips it
back to `FAILED` so the user can manually retry from the UI. **Without this,
a single crash silently breaks scheduled sends for that row indefinitely.**

10 minutes is well above the longest realistic single-row send time. If you
ever raise the per-row recipient cap or use a slower email provider, raise
`STUCK_PROCESSING_MS` accordingly.

### Step 3 — Find due rows
```ts
db.scheduledEmail.findMany({
  where: { status: "PENDING", scheduledFor: { lte: new Date() } },
  orderBy: { scheduledFor: "asc" },
  take: MAX_PER_TICK,  // 10
});
```

Bounded by `MAX_PER_TICK` to keep a single tick under the route timeout
(~60 s on Vercel; effectively unbounded but still blocking on EC2). If you
tend to backlog, lower `MAX_PER_TICK` and tick more frequently rather than
raising it.

### Step 4 — Batch organizer lookup
The "organizer" name + email comes from the user who scheduled the row. Many
rows often share the same creator (one admin schedules five reminders), so
we deduplicate the IDs and do a single `findMany` instead of one query per
row.

### Step 5 — Process rows in parallel
```ts
Promise.allSettled(due.map((row) => processRow(row, organizerMap.get(row.createdById))))
```

Each row's send is itself **serial** internally (`executeBulkEmail` sends
recipients in batches of 25 via `Promise.allSettled`), so the parallelism
is bounded — at most `MAX_PER_TICK` (=10) rows × 25 recipients = 250
in-flight email API calls per tick.

For each row, `processRow`:

1. Atomically flips `PENDING` → `PROCESSING`. If another worker raced us
   (extremely unlikely with a single cron, but possible if you misconfigure
   two crons), we skip the row.
2. Calls `executeBulkEmail()` with the data persisted on the row.
3. On success: writes `SENT` + counts; fires off a non-blocking audit log
   and admin notification.
4. On exception: writes `FAILED` + the error message in `lastError`. The
   user will see "Failed" in the UI and can click Retry.

### Step 6 — Log + return
The tick logs `scheduled-emails:tick-complete` at info level with the
`processed`, `sent`, `failed`, `swept`, and `durationMs` fields. The HTTP
response mirrors that summary.

If the tick crashes anywhere, the outer `try/catch` logs
`scheduled-emails:tick-crashed` and returns a 500. The cron will retry on
its next minute.

---

## 7. The shared helper — `executeBulkEmail()`

[`src/lib/bulk-email.ts`](../src/lib/bulk-email.ts)

This is the only place where recipient resolution and email rendering live.
Both the immediate-send route and the cron worker call into it. If you want
to add a new recipient type or a new email template variable, this is the
single file to touch.

The contract:

```ts
function executeBulkEmail(input: BulkEmailInput): Promise<BulkEmailResult>
```

- **Throws `BulkEmailError`** on validation failures (missing event, no
  recipients, attachment too large, unsupported email type). The HTTP layers
  catch these and turn them into 4xx responses.
- **Per-recipient send failures** are captured in `result.errors` (capped at
  the first 5 entries when stored on the row). The function does not throw
  for these.
- It does **not** write to `ScheduledEmail`, `AuditLog`, or
  `Notification`. Those concerns belong to the caller (route or cron worker).

---

## 8. Race conditions and how each is handled

| Race | Fix |
|---|---|
| Two cron ticks fire simultaneously and both pick the same `PENDING` row. | Atomic `updateMany({where: {id, status: PENDING}, data: {status: PROCESSING}})`. Whichever query commits first sees `count: 1`; the loser sees `count: 0` and skips. |
| User cancels at the same moment the cron claims. | DELETE uses `updateMany({where: {id, status: PENDING}, data: {status: CANCELLED}})`. If the cron got there first the user's call returns `409 Conflict`. The UI shows "Already sent or in progress". |
| User edits subject/message at the same moment the cron is sending. | PATCH uses the same atomic conditional update. If the cron got there first, the edit returns `409` and the email goes out unmodified. |
| Cron crashes mid-send, leaving the row in `PROCESSING` forever. | The next tick sweeps it back to `FAILED` after 10 minutes. The user sees "Failed" with the sweep message and clicks Retry. |
| User hits Retry on a row that the cron is currently re-processing. | Retry uses `updateMany({where: {id, status: FAILED}})`. If the row isn't `FAILED` (e.g. it's already `PENDING` or `PROCESSING` because another tick picked it up) the retry returns `409`. |

---

## 9. Rate limiting and quotas

The schedule-create endpoint **shares the same rate-limit bucket** as the
immediate-send endpoint:

```
key = bulk-email:org:{organizationId}:event:{eventId}
limit = 20 sends per hour (rolling window)
```

This means an organizer cannot bypass the 20-per-hour cap by scheduling
1,000 emails for "5 minutes from now". Both immediate sends and scheduled
creates draw from the same counter.

Note that the cron worker itself is **not** rate-limited — once a row is
queued, the cron will eventually send it regardless of how many other rows
also fire that minute. Use `MAX_PER_TICK` to bound burst load on the email
provider, not the rate limiter.

---

## 10. RBAC

| Role | What they can do |
|---|---|
| `ADMIN`, `ORGANIZER`, `SUPER_ADMIN` | Schedule, list, edit, cancel, retry. |
| `REVIEWER`, `SUBMITTER`, `REGISTRANT` | Blocked by `denyReviewer()` on every write endpoint. They can also not view the Communications page (middleware-level redirect for restricted roles). |
| Cron worker | Authenticated by `CRON_SECRET` only — no user session involved. The audit logs created by the cron use `userId = row.createdById` (the organizer who scheduled it) plus `changes.source = "cron"`. |

---

## 11. Setup & deployment

### One-time setup

1. **Migrate the database:**
   ```bash
   npx prisma migrate deploy   # production
   npx prisma migrate dev      # development
   ```
2. **Generate the Prisma client** (only needed if you skipped migrate):
   ```bash
   npx prisma generate
   ```
3. **Set `CRON_SECRET`** in your environment to a long random string:
   ```bash
   openssl rand -base64 32
   ```
   Add it to `.env` (dev), the Vercel env-var dashboard (Vercel), or
   `/etc/environment` / docker-compose env file (EC2).

### Configuring the cron trigger

The cron worker is just an HTTP endpoint. Anything that can hit a URL on a
schedule will work.

#### EC2 / Docker (primary production)

Add a line to the **host** crontab (`crontab -e` as the appropriate user —
not inside the Docker container, since the container shouldn't outlive a
deploy):

```cron
* * * * * curl -s -X POST -H "Authorization: Bearer YOUR_SECRET_HERE" https://events.meetingmindsgroup.com/api/cron/scheduled-emails >> /var/log/ea-sys-cron.log 2>&1
```

You don't want the secret in plain text on disk if you can avoid it. A
slightly safer pattern:

```cron
* * * * * /usr/local/bin/scheduled-emails-cron.sh >> /var/log/ea-sys-cron.log 2>&1
```

Where `/usr/local/bin/scheduled-emails-cron.sh` is `chmod 700 root:root`:

```sh
#!/bin/sh
. /etc/ea-sys.env   # exports CRON_SECRET=…
curl -s -X POST -H "Authorization: Bearer $CRON_SECRET" \
  https://events.meetingmindsgroup.com/api/cron/scheduled-emails
```

#### Vercel (optional secondary)

Add to `vercel.json`:

```json
{
  "crons": [
    { "path": "/api/cron/scheduled-emails", "schedule": "* * * * *" }
  ]
}
```

Vercel automatically calls cron endpoints with a `Vercel-Cron` header and
their own auth, but our endpoint expects `Authorization: Bearer …`. Either:

- Configure the cron to use the secret, **or**
- Add a parallel auth check that accepts Vercel's signature.

Since EC2 is the primary host and photo uploads don't work on Vercel anyway,
we recommend running the cron only on EC2.

#### Local development

Don't bother with cron — just `curl` the endpoint manually whenever you want
to drain due rows:

```bash
curl -X POST -H "Authorization: Bearer $CRON_SECRET" \
  http://localhost:3000/api/cron/scheduled-emails
```

You can wire it into a `package.json` script if you'd rather:

```json
{ "scripts": { "drain-cron": "curl -s -X POST -H \"Authorization: Bearer $CRON_SECRET\" http://localhost:3000/api/cron/scheduled-emails | jq" } }
```

---

## 12. Operating it day-to-day

### Where to look when things are weird

| Symptom | Where to look |
|---|---|
| "I scheduled an email but nothing happened." | `/logs` filtered to `module=api`, search `scheduled-emails:tick`. Each tick logs at info level. If you don't see ticks, the cron isn't hitting the endpoint. |
| "The cron is running but my row is still PENDING after the time passed." | Check the row's `scheduledFor` against the server's clock. The condition is `scheduledFor <= NOW()`. Server timezone matters — `scheduledFor` is stored as UTC. |
| "Row says FAILED, what happened?" | The row's `lastError` column has the error string. If it's "Stuck in processing for >10 min" the previous attempt crashed; just hit Retry. Otherwise the error is whatever `executeBulkEmail` threw. |
| "Sent 0 of 47 emails." | The Brevo / SendGrid call returned an error for every recipient. Check `/logs` for `Failed to send email to recipient` entries. Most common cause: sender domain not verified or API key revoked. |
| "User says the cancel button didn't work." | If the toast said success but the email still went out, the cron beat the cancel by a few seconds. Check the row's `auditLog` for the order of `SCHEDULED_EMAIL_CANCELLED` vs `SCHEDULED_EMAIL_SENT` events. |
| "The Scheduled Emails table never updates." | The page polls every 15 s while there are PENDING/PROCESSING rows, idle otherwise. Once everything is in a terminal state, polling stops to save bandwidth. Force a refresh to re-check. |

### Useful Prisma Studio queries

```bash
npx prisma studio
```

Filter `ScheduledEmail` by:
- `status = PROCESSING` — anything stuck right now (should be empty between ticks)
- `status = FAILED AND retryCount > 0` — emails that have already been retried at least once
- `status = PENDING AND scheduledFor < NOW()` — overdue rows the cron hasn't picked up yet

### Manually unsticking a row

```sql
-- Force a stuck PROCESSING row back to FAILED so the user can retry from the UI
UPDATE "ScheduledEmail"
SET status = 'FAILED', "lastError" = 'Manually unstuck'
WHERE id = '<id>' AND status = 'PROCESSING';

-- Reset a FAILED row to PENDING with a fresh send time (skips the UI Retry click)
UPDATE "ScheduledEmail"
SET status = 'PENDING', "scheduledFor" = NOW() + INTERVAL '1 minute', "lastError" = NULL
WHERE id = '<id>' AND status = 'FAILED';
```

### Pausing all scheduled sends

Easiest way: pause the cron job. The rows will pile up in `PENDING` and start
draining the moment you re-enable it.

```bash
# EC2: comment out the crontab line
crontab -e

# Vercel: remove the entry from vercel.json and redeploy
```

There's no in-app pause toggle today. If you want one, the cleanest place to
add it is a setting on `Organization` checked at the top of `handleCron()`.

---

## 13. Testing checklist

End-to-end smoke test after deploy:

1. **Schedule a row.** Open `/events/{eventId}/communications`, click any
   audience card → "Schedule for later" → pick a time 6 minutes out → fill
   in a custom subject + message → click **Schedule Email**. Toast says
   "Scheduled for …". Row appears in the Scheduled Emails table as `PENDING`.
2. **Edit the row.** Click the pencil → change the subject → save. Row
   refreshes with the new subject; status stays `PENDING`.
3. **Cancel a different row.** Click the trash → confirm. Row shows
   `CANCELLED`.
4. **Wait for the cron.** After 6 minutes, the next cron tick should pick it
   up. Status flashes `PROCESSING` (you may catch it on the 15s polling) →
   `SENT`. Hover the badge to see `N/M delivered`.
5. **Inspect the email.** Recipient inboxes should have the email with the
   right subject/body.
6. **401 test.** `curl -X POST http://localhost:3000/api/cron/scheduled-emails`
   (no header) → 401.
7. **Race test.** Schedule a row 30s out, then run the cron `curl` twice
   back-to-back as the time hits. Second call should report `processed: 0`
   for that row (atomic claim).
8. **Force-fail + retry.** Edit the row in Prisma Studio to set
   `recipientType = "speakers"` AND `filters = {"status":"BOGUS"}`, wait for
   the cron, watch the row flip to `FAILED` (no recipients matched). Click
   the Retry icon — status flips back to `PENDING` and gets re-picked-up.
9. **RBAC test.** Log in as a REVIEWER and try `POST /api/events/{id}/emails/schedule`
   → 403.

---

## 14. Known limits & caveats

- **Recipient count drift.** The count shown in the dialog is "right now".
  When the cron sends, the actual count may differ. This is a feature, not
  a bug — see §4.
- **Editing recipients is not supported.** The Edit dialog only updates
  subject/message/sendAt. To change the audience, cancel and create a new
  scheduled email. This is a deliberate UX simplification.
- **Attachments are stored inline as base64 in the row.** Five 2 MB
  attachments live in the database for the entire lead time. If you need
  weeks-long lead times with large attachments, move attachment storage to
  S3 / Supabase and reference by URL.
- **No timezone picker.** The datetime-local input uses the user's browser
  timezone. We send an ISO string to the server, so the actual send moment
  is correct, but the user only sees their own clock. If you have organizers
  in multiple timezones managing the same event, add a timezone selector.
- **`abstract-*` email types are blocked at the bulk-helper level.**
  `executeBulkEmail` rejects them with a 400 because the abstract templates
  need per-recipient context (`abstractTitle`, `newStatus`, …) that the bulk
  path can't enrich. Send those from the abstract detail page.
- **No retry-with-backoff.** When the cron fails a row, it stays `FAILED`
  until a human clicks Retry. If you want automatic retries, add a
  `nextRetryAt` field and a "rows that should be retried" branch to the
  cron picker.
- **Single-region only.** The atomic claim assumes one Postgres database. If
  you ever shard or multi-region, the claim still works (Postgres row lock)
  but a cron running in two regions would each pick from different replicas.
  Run the cron in exactly one place.

---

## 15. Extending it

### Add a new email type

1. Add the value to the `BulkEmailType` union in `src/lib/bulk-email.ts`.
2. Add it to the Zod enum in `bulkEmailSchema`.
3. Add the slug mapping in `slugMap` inside `executeBulkEmail()`.
4. Make sure a default template exists for that slug in `src/lib/email.ts`.
5. Add it to the `EmailTypeOption` array in `bulk-email-dialog.tsx` so
   organizers can pick it.
6. Add it to `EMAIL_TYPE_LABEL` in `scheduled-emails-list.tsx` for display.

### Add a new recipient type

1. Add the value to the `BulkEmailRecipientType` union in `bulk-email.ts`.
2. Add it to the Zod enum in `bulkEmailSchema`.
3. Add a new branch in `executeBulkEmail()` that resolves recipients from the
   right Prisma model (use `select` to keep it lean).
4. Add a card on `communications/page.tsx` and update `BulkEmailDialog`
   props.
5. Update `RECIPIENT_LABEL` in `scheduled-emails-list.tsx`.

### Add a new transition (e.g. an automatic-retry path)

If you want the cron to auto-retry `FAILED` rows once after, say, 10 minutes:

1. Add a `nextRetryAt: DateTime?` column.
2. In `processRow` on the failure path, set `nextRetryAt = now + 10min` and
   keep `status = FAILED`.
3. Change the cron picker query to:
   ```ts
   where: { OR: [
     { status: "PENDING", scheduledFor: { lte: now } },
     { status: "FAILED",  nextRetryAt: { lte: now }, retryCount: { lt: 3 } },
   ]}
   ```
4. The atomic claim flips `FAILED` → `PROCESSING` the same way (the
   `where: { id, status: "FAILED" }` clause).

### Replace the cron with a queue

If your scale grows (thousands of rows per day) the cron-poll model becomes
inefficient. The cleanest replacement:

- Drop the `scheduledFor`-polling cron.
- On `POST /schedule`, instead of just inserting a row, also enqueue a
  delayed job in BullMQ / SQS / etc. with `delay = scheduledFor - now`.
- The job handler does the same `processRow` work.
- Keep the `ScheduledEmail` row as the source of truth and the UI list.
- Keep the stuck-row sweeper as a 5-minute fallback for jobs that get lost.

---

## 16. Why these design choices

This section is meant for the next person who reads this and asks "why didn't
they just do X?" — most of these were considered and rejected.

| Choice | Alternative considered | Why we picked this |
|---|---|---|
| HTTP cron endpoint | `node-cron` inside the Next.js process | Doesn't survive serverless cold starts; doesn't work on Vercel; can double-fire if you ever scale the container; ties scheduling to one specific Node process. The HTTP endpoint is portable and decoupled. |
| Dynamic recipient resolution | Snapshot recipient IDs at schedule time | "Remind unpaid registrants in 3 days" should naturally exclude anyone who paid in the meantime. Snapshot semantics surprise users badly. |
| Atomic conditional updates | Optimistic locking with a `version` column | Same effect, fewer columns, no migration churn, and Prisma's `updateMany` returns the count we need to detect a lost race. |
| 10-minute stuck sweeper | A separate "watchdog" cron | One less moving part; the same cron tick handles everything. |
| `Promise.allSettled` row processing | Strict serial loop | A single slow row was blocking the next 9. Bounded parallelism (max 10 rows) is fine because each row is itself batch-serial inside `executeBulkEmail`. |
| Audit logs fire-and-forget | Awaited audit logs | Audit-log writes were adding 30–80 ms to every endpoint and 300–800 ms to every cron tick. The audit table is best-effort observability, not transactional state. |
| Polling list (15 s) only when active | WebSocket / SSE updates | Adds infrastructure for one screen. Polling is fine, and goes idle automatically. |
| Schedule shares the 20/hr rate bucket | Separate quotas | Without sharing, an organizer could schedule 1,000 emails to fire at the same minute and bypass the immediate-send quota. |
| `abstract-*` types rejected at the helper | Build new per-row enrichment | `abstract-*` templates need `abstractTitle` / `newStatus` / `reviewNotes` that only make sense per-abstract; the bulk path has no concept of "the abstract context for this recipient". Use the abstract detail route for those. |

---

## 17. Quick reference — endpoint table

| Method | Path | Purpose | Auth |
|---|---|---|---|
| `POST` | `/api/events/[eventId]/emails/bulk` | Send immediately | Session + `denyReviewer` |
| `POST` | `/api/events/[eventId]/emails/schedule` | Create a scheduled email | Session + `denyReviewer` |
| `GET`  | `/api/events/[eventId]/emails/schedule` | List scheduled emails for an event | Session |
| `PATCH` | `/api/events/[eventId]/emails/schedule/[id]` | Edit subject/message/sendAt of a `PENDING` row | Session + `denyReviewer` |
| `DELETE` | `/api/events/[eventId]/emails/schedule/[id]` | Cancel a `PENDING` row | Session + `denyReviewer` |
| `POST` | `/api/events/[eventId]/emails/schedule/[id]/retry` | Re-queue a `FAILED` row | Session + `denyReviewer` |
| `GET` / `POST` | `/api/cron/scheduled-emails` | Process due rows | `Bearer $CRON_SECRET` |
