/**
 * The room lists the venue's browser tests walk (scripts/venue-layout-fixtures.ts
 * writes their layouts into vendor/ehc-venue/tests/fixtures/layouts/): every
 * template, and the shapes most likely to break a generated building.
 */
import { TEMPLATES, type VenueRoom } from "./rooms";

const room = (kind: VenueRoom["kind"], capacity: number, i = 0): VenueRoom => ({ id: `${kind}-${i}`, name: `${kind[0].toUpperCase()}${kind.slice(1)} ${i + 1}`, kind, capacity });

export const LAYOUT_FIXTURES: Record<string, VenueRoom[]> = {
  congress: TEMPLATES.congress.rooms,
  summit: TEMPLATES.summit.rooms,
  expo: TEMPLATES.expo.rooms,
  meeting: TEMPLATES.meeting.rooms,
  // Every kind at its most: six halls, four workshops, the largest plenary and exhibition.
  "edge-largest": [
    room("foyer", 3000), room("plenary", 3000),
    ...[0, 1, 2, 3, 4, 5].map((i) => room("hall", 800, i)),
    ...[0, 1, 2, 3].map((i) => room("workshop", 200, i)),
    room("posters", 1000), room("exhibition", 3000), room("lounge", 1000),
  ].slice(0, 14),
  // No east rooms at all: the corridor runs along the building's east edge.
  "edge-one-side": [room("foyer", 1581), room("hall", 118, 0), room("hall", 800, 1), room("hall", 757, 2)],
  // The smallest venue the rules allow.
  "edge-foyer-only": [room("foyer", 20)],
};
