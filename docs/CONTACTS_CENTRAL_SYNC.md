# Contacts Central Sync

Mirrors EA-SYS contacts into an **external Supabase project's** `contacts_centralv1`
table (a person-level, email-keyed central CRM), on a rolling basis + a one-time
backfill/reconcile.

- **Source:** the EA-SYS `Contact` store (kept populated by `syncToContact` from
  registrants, speakers, submitters, and reviewers), enriched with per-event arrays.
- **Target:** project `vpdfzubrfcmekwhyxmsg` (`https://vpdfzubrfcmekwhyxmsg.supabase.co`),
  region **eu-north-1**, table `contacts_centralv1`, keyed on `email`.
- **Mechanism:** the `ea-sys-worker` tier runs a job every ~10 min that upserts
  contacts touched in the last 30 min; the backfill script does the full reconcile.
  Both call the target's `ea_upsert_contacts` RPC.

> **Data residency:** the target is **EU**, so attendee **PII leaves the Mumbai
> boundary**. This is an explicit, signed-off data-sharing decision.

## Merge semantics (enforced atomically by the target RPC)
- **Arrays** (`tags`, `events_attended`, `registration_type`, `event_speciality`,
  `event_type`, `event_group`) → **UNION** with what's already there (add EA-SYS's
  values, dedup, **never remove** another source's entries).
- **Scalars** → **ENRICH-only**: fill a blank; **never overwrite** an existing value.
- **Never written by us** (fully preserved): `evenstair_customerid`, `created_at`,
  `fetched_at`, and every `mailchimp_*` column.

A plain PostgREST upsert can't do union+enrich (it replaces), so the merge is a
Postgres function on the target; EA-SYS just calls it with a batch of rows.

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
| `last_updated` | sync time |

## Setup

### 1. Install the RPC in the TARGET project (one time)
Run in the target Supabase SQL editor:

```sql
create or replace function public.ea_array_union(a text[], b text[])
returns text[] language sql immutable as $$
  select array(select distinct x from unnest(coalesce(a,'{}') || coalesce(b,'{}')) x
               where x is not null and x <> '');
$$;

create or replace function public.ea_upsert_contacts(p_rows jsonb)
returns integer language plpgsql security definer set search_path = public as $$
declare r jsonb; n int := 0;
begin
  for r in select value from jsonb_array_elements(p_rows) loop
    insert into public.contacts_centralv1 as c
      (email, first_name, last_name, organization_name, job_title, mobile, city, country,
       speciality, role, source, last_updated,
       tags, events_attended, registration_type, event_speciality, event_type, event_group)
    values
      (lower(trim(r->>'email')), nullif(r->>'first_name',''), nullif(r->>'last_name',''),
       nullif(r->>'organization_name',''), nullif(r->>'job_title',''), nullif(r->>'mobile',''),
       nullif(r->>'city',''), nullif(r->>'country',''), nullif(r->>'speciality',''),
       nullif(r->>'role',''), 'ea-sys', (r->>'last_updated')::timestamptz,
       coalesce((select array_agg(v) from jsonb_array_elements_text(r->'tags') v),'{}'),
       coalesce((select array_agg(v) from jsonb_array_elements_text(r->'events_attended') v),'{}'),
       coalesce((select array_agg(v) from jsonb_array_elements_text(r->'registration_type') v),'{}'),
       coalesce((select array_agg(v) from jsonb_array_elements_text(r->'event_speciality') v),'{}'),
       coalesce((select array_agg(v) from jsonb_array_elements_text(r->'event_type') v),'{}'),
       coalesce((select array_agg(v) from jsonb_array_elements_text(r->'event_group') v),'{}'))
    on conflict (email) do update set
      first_name        = coalesce(c.first_name, excluded.first_name),
      last_name         = coalesce(c.last_name, excluded.last_name),
      organization_name = coalesce(c.organization_name, excluded.organization_name),
      job_title         = coalesce(c.job_title, excluded.job_title),
      mobile            = coalesce(c.mobile, excluded.mobile),
      city              = coalesce(c.city, excluded.city),
      country           = coalesce(c.country, excluded.country),
      speciality        = coalesce(c.speciality, excluded.speciality),
      role              = coalesce(c.role, excluded.role),
      source            = coalesce(c.source, excluded.source),
      last_updated      = excluded.last_updated,
      tags              = ea_array_union(c.tags, excluded.tags),
      events_attended   = ea_array_union(c.events_attended, excluded.events_attended),
      registration_type = ea_array_union(c.registration_type, excluded.registration_type),
      event_speciality  = ea_array_union(c.event_speciality, excluded.event_speciality),
      event_type        = ea_array_union(c.event_type, excluded.event_type),
      event_group       = ea_array_union(c.event_group, excluded.event_group);
    n := n + 1;
  end loop;
  return n;
end $$;
```

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

### 4. Ongoing
The worker job `contacts-central-sync` (every 10 min, lock id 1007) syncs contacts
whose `updatedAt` changed in the last 30 min. Watch it in `/logs` (search
`contacts-central:`): `contacts-central:tick` per run, `contacts-central:rpc-failed`
on a bad batch.

## Notes / limitations
- **Enrich-only scalars** mean once a field is set on the central row (by any
  source), EA-SYS won't overwrite it — only fill blanks. Flip to "EA-SYS wins on
  non-empty" by changing the `coalesce(c.col, excluded.col)` lines to
  `coalesce(nullif(excluded.col,''), c.col)`.
- **Reviewers** carry the least data (often just name + email).
- **Multi-org caveat:** EA-SYS is single-org today; if it ever goes multi-tenant,
  two orgs could share an email and collide on the email-keyed central table —
  revisit then.
- **Perf:** the tick reads all registrations' `(email, ticket-type)` pairs each run
  to build the type map — light (2 columns), but a candidate to scope by email later.
