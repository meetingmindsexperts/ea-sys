/**
 * The room lists the venue's browser tests walk (scripts/venue-layout-fixtures.ts
 * writes their layouts into vendor/ehc-venue/tests/fixtures/layouts/): every
 * template, and the shapes most likely to break a generated building.
 */
import { generateLayout } from "./layout";
import { planFromLayout, type VenuePlan } from "./plan";
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

/**
 * Drawn plans the venue's browser tests walk too (docs/VENUE_FLOOR_PLAN_EDITOR_PLAN.md,
 * 3.6): the shapes the template never makes. Doors in north and south walls,
 * two walkways meeting at a corner, a foyer entered from the west with its
 * way on in its east wall, one of each fixture, and the congress with its
 * entrance moved.
 */
export const PLAN_FIXTURES: Record<string, { rooms: VenueRoom[]; plan: VenuePlan }> = {
  "drawn-sideways": {
    rooms: TEMPLATES.summit.rooms,
    plan: {
      v: 1,
      rooms: [
        { id: "foyer", rect: [0, 0, 14, 30], door: { wall: "e", at: 15, width: 6 } },
        { id: "plenary", rect: [20, 0, 50, 30], door: { wall: "w", at: 15, width: 5 } },
        { id: "breakout-1", rect: [20, -26, 36, -6], door: { wall: "s", at: 28, width: 2.6 } },
        { id: "breakout-2", rect: [36, -26, 52, -6], door: { wall: "s", at: 44, width: 2.6 } },
        { id: "lounge", rect: [52, -20, 60, -6], door: { wall: "s", at: 56, width: 2.6 } },
      ],
      corridors: [
        { id: "walkway-1", name: "Concourse", rect: [14, 0, 20, 30] },
        { id: "walkway-2", name: "North Walk", rect: [14, -6, 60, 0] },
      ],
      entrance: { wall: "w", at: 15, width: 10 },
      // One of each fixture: the lift and toilets stand where the foyer's plants would be, which are dropped.
      fixtures: [
        { id: "lift", kind: "lift", name: "", rect: [10.5, 1, 13.5, 4], dir: "w" },
        { id: "stairs", kind: "stairs", name: "", rect: [1, 24, 4, 29], dir: "n" },
        { id: "toilets", kind: "toilets", name: "", rect: [8.5, 24.5, 13.5, 29.5], dir: "w" },
        { id: "pillar", kind: "pillar", name: "", rect: [30, -3.4, 30.8, -2.6], dir: "n" },
        { id: "catering", kind: "catering", name: "Coffee point", rect: [18.6, 22, 19.8, 27], dir: "w" },
        { id: "exit", kind: "exit", name: "", rect: [49.6, 14, 50, 16], dir: "w" },
      ],
    },
  },
  // Two floors (owner, Oct 26): BHS2026's plan with a hall upstairs, reached by a lift and by stairs drawn
  // in the same place on both floors.
  "drawn-two-floors": {
    rooms: [
      { id: "foyer", kind: "foyer", name: "Grand Foyer", capacity: 600 },
      { id: "plenary", kind: "plenary", name: "Plenary Hall", capacity: 500 },
      { id: "hall-1", kind: "hall", name: "Hall 1", capacity: 120 },
      { id: "hall-2", kind: "hall", name: "Hall 2", capacity: 80 },
      { id: "workshop", kind: "workshop", name: "Workshop", capacity: 40 },
    ],
    plan: {
      v: 1,
      rooms: [
        { id: "foyer", rect: [-12, 0, 12, 18.5], door: { wall: "n", at: 6.5, width: 10.4 } },
        { id: "hall-1", rect: [-12, -20.5, 1, 0], door: { wall: "e", at: -10.25, width: 2.6 } },
        { id: "plenary", rect: [-12, -48, 12, -20.5], door: { wall: "s", at: 6.5, width: 6 } },
        { id: "hall-2", floor: "level-1", rect: [-12, -20.5, 1, 0], door: { wall: "e", at: -10, width: 2.6 } },
        { id: "workshop", floor: "level-1", rect: [-1, -36, 12, -20.5], door: { wall: "s", at: 5.5, width: 2.6 } },
      ],
      corridors: [
        { id: "corridor", name: "Main Corridor", rect: [1, -20.5, 12, 0] },
        { id: "upper", floor: "level-1", name: "Upper Corridor", rect: [1, -20.5, 12, 0] },
      ],
      entrance: { wall: "s", at: 0, width: 18 },
      fixtures: [
        { id: "lift-g", kind: "lift", name: "Lift", rect: [9.4, -13.5, 12, -10.9], dir: "w" },
        { id: "lift-1", kind: "lift", name: "Lift", floor: "level-1", rect: [9.4, -13.5, 12, -10.9], dir: "w" },
        { id: "stairs-g", kind: "stairs", name: "", rect: [1.5, -9, 4.5, -3], dir: "n" },
        { id: "stairs-1", kind: "stairs", name: "", floor: "level-1", rect: [1.5, -9, 4.5, -3], dir: "n" },
      ],
    },
  },
  "drawn-congress-west-entrance": (() => {
    const rooms = TEMPLATES.congress.rooms;
    const plan = planFromLayout(generateLayout(rooms, { eventName: "" }));
    const foyer = plan.rooms.find((p) => p.id === "foyer")!;
    return { rooms, plan: { ...plan, entrance: { wall: "w", at: (foyer.rect[1] + foyer.rect[3]) / 2, width: 8 } } };
  })(),
};
