/**
 * Live colleagues in the online venue (docs/EVENT_BLUEPRINT_PLAN.md §5.4,
 * phase 5C). Owner ruling, Oct 8, 2026: inside EA-SYS first, the WebSocket
 * container before a large attendee event.
 *
 * Where everyone is, held in this process's memory: one entry per open venue
 * tab, dropped 15 seconds after its last update. Nothing is written to the
 * database. During a deploy the blue and green containers each hold their own
 * view for the minute both run, so people may briefly not see each other; for
 * a staff preview that is accepted (plan §5.4).
 *
 * A tab is keyed by the signed-in user AND a random tab id, so one person can
 * only ever move their own avatars. Every value is reshaped to the venue's own
 * ranges (social.js `onPeers` clamps the same way on the receiving side).
 */

export const PRESENCE_TTL_MS = 15_000;
export const MAX_TABS_PER_PERSON = 4;
export const MAX_PEERS_PER_EVENT = 200;

/** The gestures the venue can play (chars.js `GEST_DUR`). */
const GESTURES = new Set(["wave", "shake", "point", "think", "nod", "laugh", "heart", "clap", "raise"]);
export const TAB_ID = /^[a-z0-9]{8,32}$/;

export interface Presence {
  v: 1;
  x: number;
  z: number;
  y: number;
  yaw: number;
  mv: number;
  zn: string;
  col: string;
  g: string;
  gt: number;
  sn: number;
  say: string;
}

interface Entry {
  tab: string;
  userId: string;
  name: string;
  presence: Presence;
  updatedAt: number;
}

interface EventRoom {
  peers: Map<string, Entry>;
  version: number;
}

/** Survives Next's dev reloads; one per process in production. */
const rooms: Map<string, EventRoom> = ((globalThis as { __venuePresence?: Map<string, EventRoom> }).__venuePresence ??= new Map());

const num = (v: unknown, lo: number, hi: number, d: number) => (typeof v === "number" && Number.isFinite(v) ? Math.max(lo, Math.min(hi, v)) : d);
const int = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? Math.max(0, Math.min(1e9, Math.floor(v))) : 0);
const round2 = (v: number) => Math.round(v * 100) / 100;

/** A presence update as the venue may show it (social.js `publish()` and `onPeers()`). */
export function shapePresence(raw: unknown): Presence {
  const p = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const s = (v: unknown, max: number) => (typeof v === "string" ? v.slice(0, max) : "");
  const zn = s(p.zn, 20);
  const col = s(p.col, 7);
  const g = s(p.g, 10);
  return {
    v: 1,
    x: round2(num(p.x, -56, 70, 0)),
    z: round2(num(p.z, -44, 30, 26)),
    y: round2(num(p.y, 0, 3, 0)),
    yaw: round2(num(p.yaw, -10, 10, 0)),
    mv: round2(num(p.mv, 0, 10, 0)),
    zn: /^[\w-]*$/.test(zn) ? zn : "",
    col: /^#[0-9a-f]{6}$/i.test(col) ? col : "",
    g: GESTURES.has(g) ? g : "",
    gt: int(p.gt),
    sn: int(p.sn),
    say: s(p.say, 280),
  };
}

function room(eventId: string): EventRoom {
  let r = rooms.get(eventId);
  if (!r) rooms.set(eventId, (r = { peers: new Map(), version: 0 }));
  return r;
}

function sweep(r: EventRoom, now: number) {
  for (const [k, e] of r.peers) {
    if (now - e.updatedAt <= PRESENCE_TTL_MS) continue;
    r.peers.delete(k);
    r.version++;
  }
}

export type PutResult = { ok: true } | { ok: false; code: "TAB_TAKEN" | "TOO_MANY_TABS" | "VENUE_FULL" };

/** Record where this tab is now. */
export function putPresence(eventId: string, tab: string, userId: string, name: string, raw: unknown, now = Date.now()): PutResult {
  const r = room(eventId);
  sweep(r, now);
  const cur = r.peers.get(tab);
  if (cur && cur.userId !== userId) return { ok: false, code: "TAB_TAKEN" };
  if (!cur) {
    let mine = 0;
    for (const e of r.peers.values()) if (e.userId === userId) mine++;
    if (mine >= MAX_TABS_PER_PERSON) return { ok: false, code: "TOO_MANY_TABS" };
    if (r.peers.size >= MAX_PEERS_PER_EVENT) return { ok: false, code: "VENUE_FULL" };
  }
  r.peers.set(tab, { tab, userId, name, presence: shapePresence(raw), updatedAt: now });
  r.version++;
  return { ok: true };
}

/** This tab left (closed, or walked out of the venue); only its own user can remove it. */
export function leavePresence(eventId: string, tab: string, userId: string) {
  const r = rooms.get(eventId);
  const cur = r?.peers.get(tab);
  if (!r || !cur || cur.userId !== userId) return;
  r.peers.delete(tab);
  r.version++;
}

/** A change counter, so a stream sends only when something moved. */
export function presenceVersion(eventId: string, now = Date.now()): number {
  const r = rooms.get(eventId);
  if (!r) return 0;
  sweep(r, now);
  return r.version;
}

export interface PeerView {
  peer: string;
  by: string;
  name: string;
  isMe: boolean;
  sameTab: boolean;
  kind: "viewer";
  guest: false;
  presence: Presence;
  updatedAt: number;
}

/** Everyone in this event's venue, as one viewer's tab sees them (social.js `onPeers` shape). */
export function peersFor(eventId: string, viewerTab: string, viewerUserId: string, now = Date.now()): PeerView[] {
  const r = rooms.get(eventId);
  if (!r) return [];
  sweep(r, now);
  return [...r.peers.values()].map((e) => ({
    peer: e.tab,
    by: e.userId,
    name: e.name,
    isMe: e.userId === viewerUserId,
    sameTab: e.tab === viewerTab,
    kind: "viewer",
    guest: false,
    presence: e.presence,
    updatedAt: e.updatedAt,
  }));
}

/** Test seam: forget everyone. */
export function resetPresenceForTests() {
  rooms.clear();
}
