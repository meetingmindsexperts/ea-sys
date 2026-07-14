# Contacts Central Sync

Mirrors EA-SYS contacts into an **external Supabase project's** `contacts_centralv1`
table (a person-level, email-keyed central CRM), on a rolling basis + a one-time
backfill/reconcile.

- **Source:** the EA-SYS `Contact` store (kept populated by `syncToContact` from
  registrants, speakers, submitters, and reviewers), enriched with per-event arrays.
- **Target:** project `vpdfzubrfcmekwhyxmsg` (`https://vpdfzubrfcmekwhyxmsg.supabase.co`),
  region **eu-north-1**, table `contacts_centralv1`, keyed on `email`.
- **Mechanism:** the `ea-sys-worker` tier runs an **incremental** job at :16 and
  :53 each hour (~37-min cadence; upserts contacts touched in the last 45 min)
  **plus a nightly full reconcile** (02:24 UTC) that re-pushes everything, so the
  mirror self-heals. Both run at offset minutes (never :00) to avoid piling onto
  the DB pool at a shared minute. The backfill
  script is the same full reconcile, on demand. All logic runs on the **EA-SYS
  side** (read-modify-write via PostgREST — GET existing → merge → upsert); **no
  functions/objects live in the target project** beyond the table + the `ea_synced`
  column.

> **Data residency:** the target is **EU**, so attendee **PII leaves the Mumbai
> boundary**. This is an explicit, signed-off data-sharing decision.

## Merge semantics (done on the EA-SYS side)
- **Arrays** (`tags`, `events_attended`, `registration_type`, `event_speciality`,
  `event_type`, `event_group`) → **UNION** with what's already there (add EA-SYS's
  values, dedup, **never remove** another source's entries).
- **Scalars** → **ENRICH-only**: fill a blank; **never overwrite** an existing value.
- **Never written by us** (fully preserved): `evenstair_customerid`, `created_at`,
  `fetched_at`, and every `mailchimp_*` column.

A plain PostgREST upsert can only *replace*, so EA-SYS reads the existing row
first, merges (union arrays, enrich scalars) in code, then upserts only its
columns. **Trade-off:** this read-modify-write is **not atomic** — if another
source writes the same columns in the small window between our GET and POST,
that write can be lost. Our own sync is single-writer (worker advisory lock), so
the only race is *cross-source*; acceptable for a periodic mirror, and it keeps
all control on the EA-SYS side (nothing to install in the target project).

## Field mapping
| `contacts_centralv1` | EA-SYS `Contact` |
|---|---|
| `email` (key) | `email` (lowercased) |
| `first_name` / `last_name` | `firstName` / `lastName` |
| `organization_name` | `organization` |
| `job_title` | `jobTitle` |
| `mobile` | `phone` |
| `city` / `country` | `city` / `country` |
| `speciality` | `specialty` (or `customSpecialty` when specialty = "Others") |
| `role` | `role` → human label (`formatAttendeeRole`) |
| `tags` (union) | `tags` |
| `events_attended` (union) | names of events in `eventIds` |
| `registration_type` (union) | the person's ticket-type names (from registrations) |
| `event_speciality` (union) | `Event.specialty` across their events |
| `event_type` (union) | `Event.eventType` across their events |
| `event_group` (union) | `Event.tag` across their events |
| `source` | `'ea-sys'` (enrich — set on insert, kept if already set) |
| `ea_synced` | `true` — provenance marker, set on every row we touch |
| `last_updated` | sync time |

## Setup

### 1. Target project — one column to add
No functions or triggers — all merge logic runs on the EA-SYS side. The only
change in the target project is a provenance column (set `true` on every row
EA-SYS touches, so you can tell our data apart from other sources):

```sql
alter table public.contacts_centralv1 add column if not exists ea_synced boolean;
```

The **service-role key** must be able to `select` + `insert`/`update` on the
table (a service_role key bypasses RLS, so this works out of the box).

### 2. Set env (EA-SYS `.env`)
```
CONTACTS_CENTRAL_ENABLED=true
CONTACTS_CENTRAL_URL=https://vpdfzubrfcmekwhyxmsg.supabase.co
CONTACTS_CENTRAL_SERVICE_KEY=<target service_role / secret key>   # never commit
CONTACTS_CENTRAL_TABLE=contacts_centralv1
```
On the box, add these to `.env` then **re-run `scripts/deploy.sh`** (compose only
re-reads `env_file` on container create).

### 3. Backfill / reconcile (one time)
```bash
npx tsx scripts/backfill-contacts-central.ts           # dry-run — counts + a sample
npx tsx scripts/backfill-contacts-central.ts --write   # push everything
```
Idempotent — safe to re-run any time to force a full reconcile.

### 4. Ongoing (automatic)
Two worker jobs, both no-op unless configured, both failure-isolated (a tick error
never crashes the scheduler):
- **`contacts-central-sync`** — incremental, `16,53 * * * *` (:16 and :53, ~37-min
  cadence, lock 1007), syncs contacts whose `updatedAt` changed in the last 45 min.
- **`contacts-central-reconcile`** — full push of every contact, `24 2 * * *`
  (daily 02:24 UTC, lock 1008) — the self-healing safety net.

All schedules use **offset minutes (never :00)** to avoid clustering with the
every-minute / every-3-5-10-minute jobs on the DB pool.

Watch both in `/logs` (search `contacts-central:`): `contacts-central:tick` +
`contacts-central:reconcile` (info, with `candidates`/`sent`/`failed`), and
`contacts-central:read-failed` / `upsert-failed` / `upsert-error` (error) on a bad
chunk — errors also hit the SES admin-alert email.

## Notes / limitations

- ⚠️ **KNOWN DEFECT — the mirror never learns about a rename / merge / delete
  (contacts review H3, OPEN).** `buildCentralRows()` reads contacts that
  *currently exist*, and the only HTTP verb in this module is `POST`. So when an
  email stops being current — the email PATCH route renames it, a merge deletes
  the loser row, or a contact is deleted — it simply **stops appearing in the
  payload, and nothing tells the target**. The old row keeps its full profile,
  keeps `ea_synced = true`, and keeps feeding `mailchimp_*` as a live-looking,
  EA-maintained person. **Fixing a typo'd email therefore leaves the typo alive
  in the mirror forever, and creates a second row for the same human.** The
  nightly reconcile does NOT heal this — it is also upsert-only.
  **Do not "fix" this by diffing and deleting**: this table is shared with other
  sources (`evenstair_customerid`, `mailchimp_*`) and a prune would delete people
  EA-SYS never knew about. The agreed fix is *retraction*, not deletion —
  tombstone the old email and `PATCH ea_synced = false`. Full implementation plan
  in [ROADMAP.md](ROADMAP.md) §"H3 — mirror retraction".
  **Owner decisions (July 14, 2026):** never hard-delete a mirror row; a row
  carrying `mailchimp_*` / `evenstair_customerid` belongs to another source and,
  once retracted, is no longer EA-SYS's concern. **`ea_synced = false` is the
  contract: "EA-SYS no longer vouches for this address."** Downstream consumers
  must filter on it.

- **Enrich-only scalars** mean once a field is set on the central row (by any
  source), EA-SYS won't overwrite it — only fill blanks. To make "EA-SYS wins on
  non-empty" instead, flip the scalar lines in `mergeWithExisting`
  (`src/lib/contacts-central-sync.ts`) from `nz(e.col) ?? ours.col` to
  `ours.col ?? nz(e.col)`.
- **Not atomic** — read-modify-write can lose a *concurrent cross-source* write
  to the same column in the GET→POST window (see "Merge semantics"). If that ever
  matters, move the merge into a target-side `on conflict` function (git history
  has the SQL) and have the sync call it instead.
- **Reviewers** carry the least data (often just name + email).
- **Multi-org caveat:** EA-SYS is single-org today; if it ever goes multi-tenant,
  two orgs could share an email and collide on the email-keyed central table —
  revisit then.
- **Perf:** the tick reads all registrations' `(email, ticket-type)` pairs each run
  to build the type map — light (2 columns), but a candidate to scope by email later.
