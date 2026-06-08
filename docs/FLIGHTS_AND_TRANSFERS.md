# Flights & Transfers System — Implementation Plan

## Context

EA-SYS currently manages hotel accommodation for event attendees/speakers but has no flight or ground transportation tracking. Event organizers need to know when attendees/speakers arrive and depart, manage airport pickups, and coordinate venue shuttles. This plan adds a **Travel & Logistics** module following the proven Accommodation pattern (Hotel → RoomType → Accommodation).

---

## 1. Prisma Schema

Add after the Accommodation section (~line 716 in `prisma/schema.prisma`).

### New Enums

```prisma
enum FlightType { ARRIVAL  DEPARTURE }

enum FlightBookingStatus { PENDING  CONFIRMED  CANCELLED  BOARDED  COMPLETED }

enum TransferType { AIRPORT_PICKUP  AIRPORT_DROPOFF  HOTEL_VENUE  VENUE_HOTEL  CUSTOM }

enum TransferStatus { SCHEDULED  CONFIRMED  IN_TRANSIT  COMPLETED  CANCELLED }

enum TransferAssignmentStatus { PENDING  CONFIRMED  CANCELLED  NO_SHOW  COMPLETED }
```

### New Models

**Airline** (parallels Hotel — master entity, event-scoped)
| Field | Type | Notes |
|-------|------|-------|
| id | String @id @default(cuid()) | |
| eventId | String | FK to Event, onDelete: Cascade |
| name | String | e.g. "Emirates" |
| code | String? | IATA code e.g. "EK" |
| contactEmail | String? | |
| contactPhone | String? | |
| logo | String? | |
| isActive | Boolean @default(true) | |
| @@index([eventId]) | | |

**Flight** (parallels RoomType — detail entity with seat counter)
| Field | Type | Notes |
|-------|------|-------|
| id | String @id | |
| airlineId | String | FK to Airline, onDelete: Cascade |
| flightNumber | String | e.g. "EK423" |
| type | FlightType | ARRIVAL or DEPARTURE |
| origin | String | Airport/city |
| destination | String | Airport/city |
| departureTime | DateTime | |
| arrivalTime | DateTime | |
| terminal | String? | |
| gate | String? | |
| totalSeats | Int @default(999) | Tracked seats (not actual plane capacity) |
| bookedSeats | Int @default(0) | Atomic counter like bookedRooms |
| notes | String? @db.Text | |
| isActive | Boolean @default(true) | |
| @@index([airlineId]) | | |
| @@index([departureTime]) | | |

**FlightBooking** (parallels Accommodation — booking entity)
| Field | Type | Notes |
|-------|------|-------|
| id | String @id | |
| eventId | String | FK to Event |
| registrationId | String? | FK to Registration (no @unique — person can have arrival + departure) |
| speakerId | String? | FK to Speaker (no @unique) |
| flightId | String | FK to Flight |
| seatNumber | String? | |
| ticketNumber | String? | |
| bookingReference | String? | |
| status | FlightBookingStatus @default(PENDING) | |
| price | Decimal? @db.Decimal(10,2) | Optional — some organizers comp flights |
| currency | String @default("USD") | |
| specialRequests | String? @db.Text | |
| notes | String? @db.Text | |
| @@index([eventId]) | | |
| @@index([flightId]) | | |
| @@index([status]) | | |

> **Key difference from Accommodation:** No `@unique` on registrationId/speakerId because a person needs both an arrival AND departure flight. Enforce "max 1 arrival + 1 departure per person" in API logic.

**TransferVehicle** (parallels Hotel — vehicle/provider master entity)
| Field | Type | Notes |
|-------|------|-------|
| id | String @id | |
| eventId | String | FK to Event |
| name | String | e.g. "Van A", "Bus #1" |
| vehicleType | String? | sedan, van, minibus, bus, suv |
| licensePlate | String? | |
| driverName | String? | |
| driverPhone | String? | |
| capacity | Int @default(4) | |
| providerName | String? | External company |
| providerPhone | String? | |
| isActive | Boolean @default(true) | |
| notes | String? @db.Text | |
| @@index([eventId]) | | |

**TransferSchedule** (parallels RoomType — scheduled run with seat counter)
| Field | Type | Notes |
|-------|------|-------|
| id | String @id | |
| vehicleId | String | FK to TransferVehicle |
| transferType | TransferType | AIRPORT_PICKUP, etc. |
| pickupLocation | String | |
| dropoffLocation | String | |
| scheduledTime | DateTime | Pickup/departure time |
| estimatedArrival | DateTime? | |
| totalSeats | Int @default(4) | From vehicle capacity |
| bookedSeats | Int @default(0) | Atomic counter |
| status | TransferStatus @default(SCHEDULED) | |
| notes | String? @db.Text | |
| isActive | Boolean @default(true) | |
| @@index([vehicleId]) | | |
| @@index([scheduledTime]) | | |
| @@index([transferType]) | | |

**TransferAssignment** (parallels Accommodation — booking entity)
| Field | Type | Notes |
|-------|------|-------|
| id | String @id | |
| eventId | String | FK to Event |
| registrationId | String? | FK to Registration (no @unique — multiple transfers per person) |
| speakerId | String? | FK to Speaker (no @unique) |
| scheduleId | String | FK to TransferSchedule |
| status | TransferAssignmentStatus @default(PENDING) | |
| pickupNotes | String? @db.Text | |
| price | Decimal? @db.Decimal(10,2) | |
| currency | String @default("USD") | |
| @@index([eventId]) | | |
| @@index([scheduleId]) | | |
| @@index([status]) | | |

### Relation additions to existing models

- **Event**: add `airlines Airline[]`, `flightBookings FlightBooking[]`, `transferVehicles TransferVehicle[]`, `transferAssignments TransferAssignment[]`
- **Registration**: add `flightBookings FlightBooking[]`, `transferAssignments TransferAssignment[]`
- **Speaker**: add `flightBookings FlightBooking[]`, `transferAssignments TransferAssignment[]`

---

## 2. API Routes (12 route files)

All follow the existing pattern: `auth()` + `denyReviewer()` + event ownership check + Zod validation + audit log.

### Flights (6 files)

| Route | Methods | Key Logic |
|-------|---------|-----------|
| `/api/events/[eventId]/airlines/route.ts` | GET, POST | List airlines with flight counts; create airline |
| `/api/events/[eventId]/airlines/[airlineId]/route.ts` | GET, PUT, DELETE | Detail/update/delete; DELETE blocked if flights have bookings |
| `/api/events/[eventId]/airlines/[airlineId]/flights/route.ts` | GET, POST | List/create flights for airline |
| `/api/events/[eventId]/airlines/[airlineId]/flights/[flightId]/route.ts` | GET, PUT, DELETE | Detail/update/delete; DELETE blocked if bookings exist |
| `/api/events/[eventId]/flight-bookings/route.ts` | GET, POST | **Most complex** — follows `accommodations/route.ts` pattern. POST: validate registrationId OR speakerId, check person doesn't already have booking for same FlightType, atomic `$transaction` with bookedSeats re-check + increment |
| `/api/events/[eventId]/flight-bookings/[bookingId]/route.ts` | GET, PUT, DELETE | Flight change (decrement old/increment new seats), cancellation (decrement), delete |

### Transfers (6 files)

| Route | Methods | Key Logic |
|-------|---------|-----------|
| `/api/events/[eventId]/transfer-vehicles/route.ts` | GET, POST | List vehicles with schedule counts; create vehicle |
| `/api/events/[eventId]/transfer-vehicles/[vehicleId]/route.ts` | GET, PUT, DELETE | Detail/update/delete; DELETE blocked if schedules have assignments |
| `/api/events/[eventId]/transfer-vehicles/[vehicleId]/schedules/route.ts` | GET, POST | List/create schedules; default totalSeats from vehicle.capacity |
| `/api/events/[eventId]/transfer-vehicles/[vehicleId]/schedules/[scheduleId]/route.ts` | GET, PUT, DELETE | Detail/update/delete; DELETE blocked if assignments exist |
| `/api/events/[eventId]/transfer-assignments/route.ts` | GET, POST | Atomic `$transaction` with bookedSeats re-check + increment. No per-person uniqueness (multiple transfers OK) |
| `/api/events/[eventId]/transfer-assignments/[assignmentId]/route.ts` | GET, PUT, DELETE | Schedule change, cancellation, delete — same counter patterns |

---

## 3. React Query Hooks

Add to `src/hooks/use-api.ts`:

**Query keys:**
- `airlines: (eventId) => ["events", eventId, "airlines"]`
- `flightBookings: (eventId) => ["events", eventId, "flight-bookings"]`
- `transferVehicles: (eventId) => ["events", eventId, "transfer-vehicles"]`
- `transferAssignments: (eventId) => ["events", eventId, "transfer-assignments"]`

**Hooks:** `useAirlines`, `useFlightBookings`, `useTransferVehicles`, `useTransferAssignments` — all using existing `useEventListQuery` pattern.

---

## 4. UI — Single Page with Tabs

**Page:** `src/app/(dashboard)/events/[eventId]/travel/page.tsx`

### Layout
```
Header: "Travel & Logistics" (Plane icon)

Stats Cards (4):
  [Airlines/Flights] [Flight Bookings] [Vehicles/Schedules] [Transfer Assignments]

Top-Level Tabs: "Flights" | "Transfers"

Flights Tab:
  Sub-tabs: "Airlines & Flights" | "Bookings"
  - Airlines & Flights: airline cards → flight cards grid (like hotels → rooms)
  - Bookings: booking list with status action buttons + "Assign Flight" button

Transfers Tab:
  Sub-tabs: "Vehicles & Schedules" | "Assignments"
  - Vehicles & Schedules: vehicle cards → schedule cards grid
  - Assignments: assignment list with status buttons + "Assign Transfer" button
```

### Components (in `src/components/travel/`)

| Component | Purpose | Reference |
|-----------|---------|-----------|
| `assign-flight-dialog.tsx` | Person picker + flight selector + details | `assign-accommodation-dialog.tsx` |
| `assign-transfer-dialog.tsx` | Person picker + schedule selector + notes | `assign-accommodation-dialog.tsx` |

Form dialogs for airlines, flights, vehicles, schedules are inline on the page (like hotel/room dialogs on the accommodation page).

---

## 5. Sidebar

In `src/components/layout/sidebar.tsx` line 77, add after Accommodation:

```typescript
{ name: "Travel", href: "/travel", icon: Plane },
```

Import `Plane` from `lucide-react`.

---

## 6. Implementation Sequence

| Phase | What | Files | Complexity |
|-------|------|-------|------------|
| 1 | Schema + migration | `prisma/schema.prisma` | M |
| 2 | Flights API (6 route files) | `src/app/api/events/[eventId]/airlines/...`, `flight-bookings/...` | L |
| 3 | Transfers API (6 route files) | `src/app/api/events/[eventId]/transfer-vehicles/...`, `transfer-assignments/...` | L |
| 4 | React Query hooks | `src/hooks/use-api.ts` | S |
| 5 | UI components | `src/components/travel/assign-flight-dialog.tsx`, `assign-transfer-dialog.tsx` | M |
| 6 | Page + sidebar | `src/app/(dashboard)/events/[eventId]/travel/page.tsx`, `sidebar.tsx` | L |
| 7 | Lint + type check | `npm run lint && npx tsc --noEmit` | S |

---

## 7. Key Design Decisions

1. **No @unique on person FKs for FlightBooking** — a person needs both arrival and departure flights. Enforce "max 1 per FlightType per person" in API logic
2. **No @unique on person FKs for TransferAssignment** — a person can have multiple transfers (daily shuttles, airport pickup + dropoff)
3. **Price is optional** — many organizers comp travel; `Decimal?` allows tracking when needed
4. **totalSeats defaults to 999 for flights** — organizers track "our group on this flight", not actual plane capacity
5. **Single /travel page** — keeps sidebar clean; flights and transfers are related logistics
6. **Cascading deletes from Registration/Speaker** — matches Accommodation pattern; bookedSeats counters may go stale (same known limitation as bookedRooms)

---

## 8. Verification

1. `npx prisma migrate dev --name add-flights-transfers` — schema applies cleanly
2. `npm run lint && npx tsc --noEmit` — no errors
3. Create an airline → add a flight → assign a flight booking to a registration → verify bookedSeats increments
4. Cancel the booking → verify bookedSeats decrements
5. Create a vehicle → add a schedule → assign multiple transfers to same person → verify all work
6. Delete a registration that has flight bookings and transfer assignments → verify cascade cleanup
7. Test `denyReviewer` guard — REVIEWER role should get 403 on all write endpoints

---

## Critical Reference Files

- `prisma/schema.prisma` — add models after line 716
- `src/app/api/events/[eventId]/accommodations/route.ts` — reference pattern for booking APIs
- `src/components/accommodation/assign-accommodation-dialog.tsx` — reference pattern for assignment dialogs
- `src/hooks/use-api.ts` — add query keys + hooks
- `src/components/layout/sidebar.tsx` — add Travel nav item at line 77
- `src/app/(dashboard)/events/[eventId]/accommodation/page.tsx` — reference pattern for page structure
