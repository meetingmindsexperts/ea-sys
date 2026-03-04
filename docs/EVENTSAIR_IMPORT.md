# EventsAir Import Integration

## Overview

EA-SYS supports importing events and their associated data from EventsAir through two methods:

1. **EventsAir GraphQL API** — Connect to EventsAir's API to browse and import events with contacts, registrations, and sessions
2. **CSV Imports** — Manual bulk import per entity type (registrations, speakers, sessions, abstracts)

Both methods support creating **new events** from imported data and importing data **into existing events**.

---

## EventsAir API Integration

### Setup

1. Navigate to **Settings** in the EA-SYS dashboard
2. Find the **EventsAir Integration** card
3. Enter your EventsAir API credentials:
   - **Client ID** — from EventsAir Developer Portal
   - **Client Secret** — OAuth 2.0 client secret
4. Click **Test Connection** to verify credentials
5. Click **Save**

Credentials are encrypted at rest using AES-256-GCM derived from the application secret.

### Importing Events

1. Go to the **Events** page
2. Click **Import from EventsAir**
3. Browse the list of EventsAir events (sandbox and archived events are filtered out)
4. Events already imported are marked with an "Imported" badge
5. Select an event and click **Import**
6. The import wizard runs in steps:
   - **Step 1**: Creates the event with metadata (name, dates, venue, timezone)
   - **Step 2**: Imports contacts as attendees and registrations (batched, 500 per request)
   - **Step 3**: Summary of imported data

### Data Mapping (EventsAir → EA-SYS)

| EventsAir Field | EA-SYS Field | Notes |
|-----------------|--------------|-------|
| `name` | `Event.name` | Required |
| `startDate` | `Event.startDate` | Required |
| `endDate` | `Event.endDate` | Required |
| `timezone` | `Event.timezone` | Defaults to UTC |
| `venue.name` | `Event.venue` | Optional |
| `venue.city` | `Event.city` | Optional |
| `venue.country` | `Event.country` | Optional |
| Contact `firstName` | `Attendee.firstName` | Required |
| Contact `lastName` | `Attendee.lastName` | Required |
| Contact `primaryEmail` | `Attendee.email` | Required, unique |
| Contact `organizationName` | `Attendee.organization` | Optional |
| Contact `jobTitle` | `Attendee.jobTitle` | Optional |
| Contact `primaryAddress.city` | `Attendee.city` | Optional |
| Contact `primaryAddress.country` | `Attendee.country` | Optional |
| Contact `primaryAddress.phone` | `Attendee.phone` | Optional |

### Deduplication

- Events: Tracked via `externalSource` + `externalId` fields. Re-importing the same event is detected.
- Attendees: Upserted by email (global unique). Existing attendees are updated, not duplicated.
- Registrations: Duplicate (event + attendee) combinations are skipped.

### Technical Details

- **API Endpoint**: `https://api.eventsair.com/graphql`
- **Authentication**: OAuth 2.0 client credentials flow
- **Rate Limits**: 750 requests/5 minutes, batches of 500 contacts per request
- **Pagination**: Offset-based with max 2,000 per query

---

## CSV Imports

### Registrations CSV

**API Endpoint**: `POST /api/events/[eventId]/import/registrations`

Upload a CSV file to bulk-import registrations (attendees + registration records).

**Required columns**: `email`, `firstName`, `lastName`

**Optional columns**: `organization`, `jobTitle`, `phone`, `city`, `country`, `specialty`, `registrationType`, `tags` (comma-separated), `dietaryReqs`, `notes`, `title` (MR/MS/MRS/DR/PROF/OTHER)

**Behavior**:
- Attendees are upserted by email (existing attendees updated)
- Duplicate event registrations are skipped
- If `registrationType` is provided, a matching TicketType is found or created
- Registration status defaults to `CONFIRMED`
- Max 5,000 rows per file

**Example CSV**:
```csv
email,firstName,lastName,organization,registrationType,city,country
john@example.com,John,Doe,ACME Corp,Standard,Dubai,AE
jane@example.com,Jane,Smith,Global Inc,VIP,London,GB
```

### Speakers CSV

**API Endpoint**: `POST /api/events/[eventId]/import/speakers`

Upload a CSV file to bulk-import speakers.

**Required columns**: `email`, `firstName`, `lastName`

**Optional columns**: `organization`, `jobTitle`, `phone`, `bio`, `city`, `country`, `specialty`, `registrationType`, `tags` (comma-separated), `website`, `status` (INVITED/CONFIRMED/DECLINED/CANCELLED), `title`

**Behavior**:
- Duplicate speakers (same email for same event) are skipped
- Speaker status defaults to `INVITED`
- Max 5,000 rows per file

**Example CSV**:
```csv
email,firstName,lastName,organization,bio,specialty,status
speaker@example.com,Alice,Johnson,MIT,Expert in AI,Artificial Intelligence,CONFIRMED
```

### Sessions CSV

**API Endpoint**: `POST /api/events/[eventId]/import/sessions`

Upload a CSV file to bulk-import schedule sessions.

**Required columns**: `name`, `startTime`, `endTime`

**Optional columns**: `description`, `location`, `capacity`, `track`, `speakerEmails` (semicolon-separated), `status` (DRAFT/SCHEDULED/LIVE/COMPLETED/CANCELLED)

**Behavior**:
- Tracks are auto-created if a track name doesn't exist for the event
- Speakers are linked by email lookup (must exist as speakers for this event)
- Multiple speakers separated by semicolons: `alice@ex.com;bob@ex.com`
- Session status defaults to `SCHEDULED`
- Max 5,000 rows per file

**Example CSV**:
```csv
name,startTime,endTime,track,location,speakerEmails
Keynote: Future of AI,2026-03-15T09:00:00Z,2026-03-15T10:00:00Z,Main Stage,Hall A,alice@example.com
Panel Discussion,2026-03-15T10:30:00Z,2026-03-15T12:00:00Z,Workshops,Room B,alice@example.com;bob@example.com
```

### Abstracts CSV

**API Endpoint**: `POST /api/events/[eventId]/import/abstracts`

Upload a CSV file to bulk-import abstracts/papers.

**Required columns**: `title`, `content`, `speakerEmail`

**Optional columns**: `specialty`, `track`, `status` (DRAFT/SUBMITTED/UNDER_REVIEW/ACCEPTED/REJECTED/REVISION_REQUESTED)

**Behavior**:
- Speaker must exist for this event (looked up by email). Rows with unknown speakers are skipped.
- Tracks are auto-created if name doesn't exist
- `managementToken` is auto-generated for each abstract
- Abstract status defaults to `SUBMITTED`
- Max 5,000 rows per file

**Example CSV**:
```csv
title,content,speakerEmail,specialty,track,status
Machine Learning in Healthcare,This paper explores...,alice@example.com,AI/ML,Research Track,SUBMITTED
```

---

## CSV Format Notes

- **Encoding**: UTF-8
- **Delimiter**: Comma (`,`)
- **Quoting**: Fields containing commas or newlines must be quoted with double quotes
- **Header row**: Required (first row is treated as column headers)
- **Column matching**: Case-insensitive, spaces ignored (e.g., "First Name" matches "firstName")
- **Tags**: Comma-separated within the field (e.g., `"VIP,Speaker,Sponsor"`)
- **Dates**: ISO 8601 format (e.g., `2026-03-15T09:00:00Z`)
- **Country**: ISO 3166-1 alpha-2 code preferred (e.g., `AE`, `GB`, `US`)
- **Title**: One of `MR`, `MS`, `MRS`, `DR`, `PROF`, `OTHER`

---

## Limits & Rate Limiting

| Constraint | Value |
|-----------|-------|
| Max rows per CSV | 5,000 |
| Import rate limit | 10 per hour per organization |
| EventsAir contacts per batch | 500 |
| EventsAir max per query | 2,000 |
| Vercel function timeout | 30 seconds |

---

## Troubleshooting

### EventsAir connection fails
- Verify Client ID and Client Secret are correct
- Ensure your EventsAir API access has been activated
- Check that `NEXTAUTH_SECRET` environment variable is set (used for credential encryption)

### CSV import shows many errors
- Verify the CSV has the required columns (check spelling, case doesn't matter)
- Ensure email addresses are valid
- Check date formats are ISO 8601

### Duplicate records
- Attendees are deduplicated by email globally
- Speakers are deduplicated by email per event
- Registrations are deduplicated by (event + attendee) combination
- EventsAir events are tracked by external ID to prevent duplicate imports

### Large imports timing out (Vercel)
- EventsAir imports are batched (500 per request) to stay within Vercel's 30s timeout
- CSV imports are limited to 5,000 rows. Split larger files.
- On AWS EC2 (primary deployment), there are no timeout constraints
