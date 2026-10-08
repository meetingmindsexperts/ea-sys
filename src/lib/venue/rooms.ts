/**
 * An event's online venue rooms (docs/EVENT_BLUEPRINT_PLAN.md, D9 and D10):
 * the list organisers keep on the event's Venue tab, and the generator builds
 * the walkable venue from. Stored in `Event.settings.venue.rooms` (a
 * route-owned settings key: only the venue routes write it).
 *
 * D10 fixes the floor plan's shape (foyer at the entrance, a main corridor,
 * the plenary at the end, the other rooms either side), so a room has no
 * position: only a name, a kind and how many people it holds. The limits per
 * kind are what that plan can lay out and keep walkable.
 */
import { z } from "zod";

export const ROOM_KINDS = ["foyer", "plenary", "hall", "workshop", "posters", "exhibition", "lounge"] as const;
export type RoomKind = (typeof ROOM_KINDS)[number];

interface KindInfo {
  label: string;
  /** What the room is for, as the editor explains it. */
  help: string;
  min: number;
  max: number;
  /** Capacity bounds and the starting value for a new room of this kind. */
  capacity: { min: number; max: number; start: number };
}

export const ROOM_KIND_INFO: Record<RoomKind, KindInfo> = {
  foyer: { label: "Foyer", help: "The entrance: registration and information desks. Every venue has one.", min: 1, max: 1, capacity: { min: 20, max: 3000, start: 300 } },
  plenary: { label: "Plenary hall", help: "The main stage, at the end of the corridor.", min: 0, max: 1, capacity: { min: 20, max: 3000, start: 500 } },
  hall: { label: "Parallel hall", help: "A session room with a stage and rows of seats.", min: 0, max: 6, capacity: { min: 10, max: 800, start: 120 } },
  workshop: { label: "Workshop room", help: "Round tables for hands-on sessions.", min: 0, max: 4, capacity: { min: 10, max: 200, start: 40 } },
  posters: { label: "Poster gallery", help: "Poster boards for abstracts.", min: 0, max: 1, capacity: { min: 10, max: 1000, start: 100 } },
  exhibition: { label: "Exhibition hall", help: "Stands for the event's sponsors and partners.", min: 0, max: 1, capacity: { min: 20, max: 3000, start: 300 } },
  lounge: { label: "Networking lounge", help: "Sofas and a coffee bar.", min: 0, max: 1, capacity: { min: 10, max: 1000, start: 80 } },
};

export const MAX_ROOMS = 14;

export interface VenueRoom {
  id: string;
  name: string;
  kind: RoomKind;
  capacity: number;
}

export const ROOM_ID = /^[a-z0-9-]{1,40}$/;

const roomSchema = z.object({
  id: z.string().regex(ROOM_ID),
  name: z.string().trim().min(1, "Give every room a name").max(60),
  kind: z.enum(ROOM_KINDS),
  capacity: z.number({ message: "Enter how many people each room holds" }).int("Room sizes are whole numbers of people").min(1).max(3000),
});

/** The room list as saved: refuses what the floor plan cannot lay out, with a reason a person can act on. */
export const roomsSchema = z
  .array(roomSchema)
  .min(1, "Add at least the foyer")
  .max(MAX_ROOMS, `At most ${MAX_ROOMS} rooms`)
  .superRefine((rooms, ctx) => {
    const issue = (message: string) => ctx.addIssue({ code: "custom", message });
    for (const kind of ROOM_KINDS) {
      const info = ROOM_KIND_INFO[kind];
      const n = rooms.filter((r) => r.kind === kind).length;
      if (n < info.min) issue(`The venue needs ${info.min === 1 ? "a" : info.min} ${info.label.toLowerCase()}`);
      if (n > info.max) issue(info.max === 1 ? `Only one ${info.label.toLowerCase()}` : `At most ${info.max} ${info.label.toLowerCase()}s`);
    }
    for (const r of rooms) {
      const { min, max } = ROOM_KIND_INFO[r.kind].capacity;
      if (r.capacity < min || r.capacity > max) issue(`${r.name}: a ${ROOM_KIND_INFO[r.kind].label.toLowerCase()} holds ${min} to ${max} people`);
    }
    const names = new Set<string>();
    const ids = new Set<string>();
    for (const r of rooms) {
      const key = r.name.trim().toLowerCase();
      if (names.has(key)) issue(`Two rooms are called "${r.name.trim()}"; give each its own name`);
      names.add(key);
      if (ids.has(r.id)) issue("Two rooms share an id");
      ids.add(r.id);
    }
  });

export const TEMPLATES = {
  congress: {
    label: "Congress",
    help: "A medical or scientific congress: plenary, parallel halls, workshops, posters and an exhibition.",
    rooms: [
      { id: "foyer", name: "Grand Foyer", kind: "foyer", capacity: 600 },
      { id: "plenary", name: "Plenary Hall", kind: "plenary", capacity: 600 },
      { id: "hall-a", name: "Hall A", kind: "hall", capacity: 150 },
      { id: "hall-b", name: "Hall B", kind: "hall", capacity: 150 },
      { id: "hall-c", name: "Hall C", kind: "hall", capacity: 150 },
      { id: "workshop", name: "Workshop Room", kind: "workshop", capacity: 40 },
      { id: "posters", name: "Poster Gallery", kind: "posters", capacity: 100 },
      { id: "exhibition", name: "Exhibition Hall", kind: "exhibition", capacity: 300 },
      { id: "lounge", name: "Networking Lounge", kind: "lounge", capacity: 80 },
    ],
  },
  summit: {
    label: "Summit",
    help: "A main stage, two breakout rooms and a lounge.",
    rooms: [
      { id: "foyer", name: "Foyer", kind: "foyer", capacity: 300 },
      { id: "plenary", name: "Main Stage", kind: "plenary", capacity: 300 },
      { id: "breakout-1", name: "Breakout 1", kind: "hall", capacity: 80 },
      { id: "breakout-2", name: "Breakout 2", kind: "hall", capacity: 80 },
      { id: "lounge", name: "Lounge", kind: "lounge", capacity: 80 },
    ],
  },
  expo: {
    label: "Exhibition",
    help: "A large exhibition hall with a seminar room.",
    rooms: [
      { id: "foyer", name: "Entrance Hall", kind: "foyer", capacity: 500 },
      { id: "exhibition", name: "Exhibition Hall", kind: "exhibition", capacity: 1000 },
      { id: "seminar", name: "Seminar Theatre", kind: "hall", capacity: 150 },
      { id: "lounge", name: "Business Lounge", kind: "lounge", capacity: 100 },
    ],
  },
  meeting: {
    label: "Meeting",
    help: "One meeting room and a coffee area.",
    rooms: [
      { id: "foyer", name: "Reception", kind: "foyer", capacity: 100 },
      { id: "plenary", name: "Meeting Room", kind: "plenary", capacity: 100 },
      { id: "lounge", name: "Coffee Area", kind: "lounge", capacity: 40 },
    ],
  },
} satisfies Record<string, { label: string; help: string; rooms: VenueRoom[] }>;

export type TemplateKey = keyof typeof TEMPLATES;
export const TEMPLATE_KEYS = Object.keys(TEMPLATES) as TemplateKey[];

export interface StoredVenueRooms {
  rooms: VenueRoom[];
  /** Milliseconds; the version a save must name, so two editors cannot overwrite each other. */
  updatedAt: number;
  updatedBy: string;
}

/** The saved room list in `Event.settings.venue.rooms`, or null when none is saved (or it no longer passes). */
export function readVenueRooms(settings: unknown): StoredVenueRooms | null {
  const venue = settings && typeof settings === "object" ? (settings as Record<string, unknown>).venue : null;
  const stored = venue && typeof venue === "object" ? (venue as Record<string, unknown>).rooms : null;
  if (!stored || typeof stored !== "object") return null;
  const s = stored as Record<string, unknown>;
  const rooms = roomsSchema.safeParse(s.list);
  if (!rooms.success) return null;
  return { rooms: rooms.data, updatedAt: typeof s.updatedAt === "number" ? s.updatedAt : 0, updatedBy: typeof s.updatedBy === "string" ? s.updatedBy : "" };
}

/** A room id from its name, unique within the list. */
export function roomIdFor(name: string, taken: Iterable<string>): string {
  const base = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 32) || "room";
  const used = new Set(taken);
  if (!used.has(base)) return base;
  for (let i = 2; ; i++) if (!used.has(`${base}-${i}`)) return `${base}-${i}`;
}
