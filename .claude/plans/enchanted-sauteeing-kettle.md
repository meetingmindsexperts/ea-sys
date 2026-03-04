# EventsAir Import Dialog — Year Filter + Bulk Import

## Context
The EventsAir account has ~750 events. Currently the import dialog shows all events in a flat list, making it hard to find specific events. The user needs:
1. **Year filter** — dropdown to filter events by year (extracted from `startDate`)
2. **Bulk import** — select multiple events and import them all at once

## Changes

### File: `src/components/import/eventsair-import-dialog.tsx`

**Year filter:**
- Extract unique years from `events[].startDate` into a sorted list (descending, newest first)
- Add a `Select` dropdown above the events table: "All Years", 2026, 2025, 2024, ...
- Filter the displayed events by selected year
- Show count: "Showing X of Y events"
- Default to the most recent year (not "All") since 750 events is too many

**Multi-select:**
- Change `selectedEventId: string | null` → `selectedEventIds: Set<string>`
- Add checkboxes in each table row
- Add "Select All (filtered)" / "Deselect All" toggle in the header
- Show selected count in the Import button: "Import 3 Events"
- Update `EventsAirEvent` interface to include `alreadyImported` check (already done)

**Bulk import flow:**
- Loop through selected events sequentially (not parallel — avoids rate limits)
- Progress shows: "Importing event 2 of 5: Event Name..."
- Each event: create event → import contacts in batches → next event
- Final summary: X events imported, Y total contacts, Z errors
- "Go to Events" button instead of "Go to Event" (navigates to `/events`)

### File: `src/hooks/use-api.ts`
- No changes needed — existing `useEventsAirEvents()` and `useImportEventsAirEvent()` hooks work as-is

### File: `src/app/api/organization/eventsair/events/route.ts`
- No changes needed — already returns all events with `startDate` for client-side filtering

## Verification
```bash
npm run lint
npx tsc --noEmit
npm run build
```
