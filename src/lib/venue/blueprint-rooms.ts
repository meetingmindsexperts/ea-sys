/**
 * The Blueprint's spaces as a venue room list (docs/EVENT_BLUEPRINT_PLAN.md,
 * phase 6 step 5). The Venue tab offers it like a template: a draft the
 * organiser checks and saves, never written on its own.
 *
 * Each space gets the room kind its name says ("Registration", "Poster
 * area"), else its layout ("Exhibition stands", "Classroom"), else its
 * purpose; a space the venue cannot show ("Online only") is left out. The list
 * is then fitted to the venue's rules (one foyer, at most six halls, the sizes
 * each kind can lay out) and every change is noted, so nothing is dropped or
 * altered without the organiser being told.
 */
import { MAX_ROOMS, ROOM_KINDS, ROOM_KIND_INFO, roomIdFor, type RoomKind, type VenueRoom } from "./rooms";

export interface BlueprintSpace {
  name: string;
  purpose: string;
  layout: string;
  cap: string;
}

/** The Blueprint's spaces and expected attendance, read defensively from its stored data. */
export function readBlueprintSpaces(data: unknown): { spaces: BlueprintSpace[]; attendance: string } {
  const d = data && typeof data === "object" ? (data as Record<string, unknown>) : {};
  const str = (v: unknown, n: number) => (typeof v === "string" || typeof v === "number" ? String(v).trim().slice(0, n) : "");
  const spaces = (Array.isArray(d.spaces) ? d.spaces : [])
    .slice(0, 40)
    .map((s) => (s && typeof s === "object" ? (s as Record<string, unknown>) : {}))
    .map((s) => ({ name: str(s.name, 60), purpose: str(s.purpose, 200), layout: str(s.layout, 40), cap: str(s.cap, 20) }))
    .filter((s) => s.name);
  const basics = d.basics && typeof d.basics === "object" ? (d.basics as Record<string, unknown>) : {};
  return { spaces, attendance: str(basics.attendance, 80) };
}

// The words that decide a kind, most specific first: a "Registration lounge" is the foyer.
const KIND_WORDS: [RoomKind, RegExp][] = [
  ["foyer", /\b(foyer|lobby|entrance|registration|arrivals?|check-?in)\b/],
  ["posters", /\b(e-?posters?|posters?|abstracts?)\b/],
  ["exhibition", /\b(exhibition|exhibitors?|expo|stands?|booths?|sponsors?|trade (show|floor))\b/],
  ["workshop", /\b(workshops?|hands-?on|skills|labs?|simulation|masterclass(es)?)\b/],
  ["plenary", /\b(plenary|main (stage|hall|room|auditorium|session)|ballroom|keynote|auditorium|general session)\b/],
  ["lounge", /\b(lounge|networking|coffee|cafe|bar|catering|lunch|dinner|dining|refreshments?|meet(ing)? point)\b/],
  ["hall", /\b(halls?|breakouts?|session rooms?|seminars?|theatres?|tracks?|parallel|meeting rooms?)\b/],
];
// The Blueprint's layouts (vendor/event-blueprint bench.js LAYOUTS) as kinds.
const LAYOUT_KIND: Record<string, RoomKind> = {
  "Exhibition stands": "exhibition",
  Classroom: "workshop",
  "U-shape": "workshop",
  Boardroom: "workshop",
  "Banquet rounds": "lounge",
  "Standing reception": "lounge",
  Theatre: "hall",
  Cabaret: "hall",
  "Standing crowd": "hall",
};

// Accents stripped first: `\b` does not count "é" as a letter, so "Café" would never match.
const plain = (text: string) => text.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
const wordKind = (text: string): RoomKind | null => KIND_WORDS.find(([, re]) => re.test(plain(text)))?.[0] ?? null;

/** The kind a space becomes, or null for one the venue cannot show. */
export function kindOfSpace(s: BlueprintSpace): RoomKind | null {
  if (s.layout === "Online only") return null;
  return wordKind(s.name) ?? LAYOUT_KIND[s.layout] ?? wordKind(s.purpose) ?? "hall";
}

const firstNumber = (s: string) => {
  const m = /\d[\d,. ]*/.exec(s);
  const n = m ? parseInt(m[0].replace(/[,. ]/g, ""), 10) : NaN;
  return Number.isFinite(n) && n > 0 ? n : null;
};

export interface BlueprintRooms {
  rooms: VenueRoom[];
  /** What was changed to fit the venue's rules, in words for the organiser. */
  notes: string[];
}

export function roomsFromBlueprint(spaces: BlueprintSpace[], attendance: string): BlueprintRooms {
  const notes: string[] = [];
  type Draft = { name: string; kind: RoomKind; capacity: number; from: string };
  let list: Draft[] = [];
  for (const s of spaces) {
    const kind = kindOfSpace(s);
    if (!kind) {
      notes.push(`${s.name} is online only, so it has no room in the venue.`);
      continue;
    }
    list.push({ name: s.name, kind, capacity: firstNumber(s.cap) ?? 0, from: s.name });
  }

  // One of each single kind: the largest keeps it; an extra plenary becomes a hall, any other extra is left out.
  for (const kind of ROOM_KINDS) {
    const info = ROOM_KIND_INFO[kind];
    const same = list.filter((r) => r.kind === kind).sort((a, b) => b.capacity - a.capacity);
    for (const extra of same.slice(info.max)) {
      if (kind === "plenary") {
        extra.kind = "hall";
        notes.push(`${extra.name} is a parallel hall: the venue has one plenary hall (${same[0].name}).`);
      } else if (kind !== "hall" && kind !== "workshop") {
        list = list.filter((r) => r !== extra);
        notes.push(`${extra.name} is left out: the venue has one ${info.label.toLowerCase()} (${same[0].name}).`);
      }
    }
  }
  for (const kind of ["hall", "workshop"] as const) {
    const info = ROOM_KIND_INFO[kind];
    const same = list.filter((r) => r.kind === kind).sort((a, b) => b.capacity - a.capacity);
    for (const extra of same.slice(info.max)) {
      list = list.filter((r) => r !== extra);
      notes.push(`${extra.name} is left out: the venue has at most ${info.max} ${info.label.toLowerCase()}s.`);
    }
  }

  // The main stage: the largest hall when no space was called a plenary.
  if (!list.some((r) => r.kind === "plenary")) {
    const biggest = list.filter((r) => r.kind === "hall").sort((a, b) => b.capacity - a.capacity)[0];
    if (biggest) {
      biggest.kind = "plenary";
      notes.push(`${biggest.name} is the plenary hall, the main stage at the end of the corridor, as the largest session room.`);
    }
  }

  // The entrance every venue has.
  if (!list.some((r) => r.kind === "foyer")) {
    const people = firstNumber(attendance) ?? Math.max(0, ...list.map((r) => r.capacity));
    list.unshift({ name: "Foyer", kind: "foyer", capacity: people || ROOM_KIND_INFO.foyer.capacity.start, from: "" });
    notes.push("A foyer is added: every venue has an entrance with registration and information desks.");
  }

  // At most MAX_ROOMS: the smallest workshops, then halls, go first.
  while (list.length > MAX_ROOMS) {
    const cut = (["workshop", "hall"] as const).map((k) => list.filter((r) => r.kind === k).sort((a, b) => a.capacity - b.capacity)[0]).find(Boolean)!;
    list = list.filter((r) => r !== cut);
    notes.push(`${cut.name} is left out: the venue has at most ${MAX_ROOMS} rooms.`);
  }

  // Sizes each kind can lay out; a space with no number gets the kind's usual size.
  for (const r of list) {
    const { min, max, start } = ROOM_KIND_INFO[r.kind].capacity;
    if (!r.capacity) {
      r.capacity = start;
      if (r.from) notes.push(`${r.name} has no capacity in the Blueprint, so it starts at ${start}.`);
    } else if (r.capacity < min || r.capacity > max) {
      const to = Math.min(max, Math.max(min, r.capacity));
      notes.push(`${r.name} holds ${to} people here, not ${r.capacity}: a ${ROOM_KIND_INFO[r.kind].label.toLowerCase()} holds ${min} to ${max}.`);
      r.capacity = to;
    }
  }

  // Unique names and ids, in the order the venue lays rooms out.
  const order = (k: RoomKind) => ROOM_KINDS.indexOf(k);
  list.sort((a, b) => order(a.kind) - order(b.kind));
  const names = new Set<string>();
  const ids: string[] = [];
  const rooms = list.map((r) => {
    let name = r.name;
    for (let n = 2; names.has(name.toLowerCase()); n++) name = `${r.name.slice(0, 56)} ${n}`;
    names.add(name.toLowerCase());
    const id = roomIdFor(name, ids);
    ids.push(id);
    return { id, name, kind: r.kind, capacity: r.capacity };
  });
  return { rooms, notes };
}
