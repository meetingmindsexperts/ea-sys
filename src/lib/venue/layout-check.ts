/**
 * Is a generated venue walkable? (docs/EVENT_BLUEPRINT_PLAN.md, D10.) A layout
 * is refused, with its reasons, unless a person who walks in at the entrance
 * can reach every room, every doorway, every stand and every hotspot.
 *
 * The plan is drawn onto a 0.5 m grid: a cell is open when it lies inside a
 * room and clear of every wall (except at its doorways) and of all furniture
 * people cannot walk through, each grown by a person's half-width. A
 * breadth-first walk from the foyer then marks what can be reached. It is the
 * same idea as the venue's own route-finding (vendor/ehc-venue abilities.js
 * `NavGrid`), at a finer step, so it stays a strict, independent check.
 */
import type { Footprint, VenueLayout } from "./layout";

const CELL = 0.5;
/** A person's half-width plus a little room. */
const BODY = 0.35;
const WALL_HALF = 0.15;

export interface LayoutCheck {
  ok: boolean;
  issues: string[];
  /** Share of each room's floor a person can stand on, for the plan view. */
  openShare: Record<string, number>;
}

export function checkLayout(layout: VenueLayout): LayoutCheck {
  const [bx0, bz0, bx1, bz1] = layout.bounds;
  const cols = Math.ceil((bx1 - bx0) / CELL);
  const rows = Math.ceil((bz1 - bz0) / CELL);
  const open = new Uint8Array(cols * rows);
  const centre = (i: number, j: number): [number, number] => [bx0 + (i + 0.5) * CELL, bz0 + (j + 0.5) * CELL];
  const cellOf = (x: number, z: number): [number, number] => [Math.floor((x - bx0) / CELL), Math.floor((z - bz0) / CELL)];
  const issues: string[] = [];

  const zoneAt = (x: number, z: number) => layout.zones.find((zn) => x > zn.rect[0] && x < zn.rect[2] && z > zn.rect[1] && z < zn.rect[3]);
  const inFoot = (f: Footprint, x: number, z: number, grow: number) =>
    "r" in f ? Math.hypot(x - f.cx, z - f.cz) < f.r + grow : x > f.x0 - grow && x < f.x1 + grow && z > f.z0 - grow && z < f.z1 + grow;
  const solids = layout.items.filter((it) => it.solid);
  const blockedByWall = (x: number, z: number) =>
    layout.walls.some((w) => {
      const [along, across] = w.axis === "x" ? [x, z] : [z, x];
      if (Math.abs(across - w.k) >= WALL_HALF + BODY) return false;
      if (along < w.a0 - BODY || along > w.a1 + BODY) return false;
      return !w.opens.some((o) => !o.glass && along > o.a + BODY && along < o.b - BODY);
    });

  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) {
      const [x, z] = centre(i, j);
      if (!zoneAt(x, z)) continue;
      if (blockedByWall(x, z)) continue;
      if (solids.some((it) => inFoot(it.foot, x, z, BODY))) continue;
      open[j * cols + i] = 1;
    }
  }

  // Rooms must not overlap, and must sit inside the building.
  for (const a of layout.zones) {
    const [x0, z0, x1, z1] = a.rect;
    if (!(x1 > x0 && z1 > z0)) issues.push(`${a.name} has no floor`);
    if (x0 < bx0 - 0.01 || z0 < bz0 - 0.01 || x1 > bx1 + 0.01 || z1 > bz1 + 0.01) issues.push(`${a.name} lies outside the building`);
    for (const b of layout.zones) {
      if (a.id >= b.id) continue;
      const overlap = Math.min(x1, b.rect[2]) - Math.max(x0, b.rect[0]) > 0.01 && Math.min(z1, b.rect[3]) - Math.max(z0, b.rect[1]) > 0.01;
      if (overlap) issues.push(`${a.name} and ${b.name} overlap`);
    }
  }
  for (const d of layout.doors) if (d.width < 1.6) issues.push(`The doorway into ${d.between[1]} is narrower than 1.6 m`);

  // Walk from the entrance.
  const foyer = layout.zones.find((z) => z.kind === "foyer");
  const reached = new Uint8Array(cols * rows);
  if (!foyer) issues.push("There is no foyer to walk in from");
  else {
    const [si, sj] = cellOf(foyer.spawn[0], foyer.spawn[1]);
    if (!open[sj * cols + si]) issues.push("The entrance is blocked");
    else {
      const queue = [sj * cols + si];
      reached[queue[0]] = 1;
      for (let q = 0; q < queue.length; q++) {
        const c = queue[q];
        const i = c % cols;
        const j = (c - i) / cols;
        for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const ni = i + di;
          const nj = j + dj;
          if (ni < 0 || nj < 0 || ni >= cols || nj >= rows) continue;
          const n = nj * cols + ni;
          if (!open[n] || reached[n]) continue;
          reached[n] = 1;
          queue.push(n);
        }
      }
    }
  }
  /** Is any reached cell within `r` of (x, z)? */
  const reachable = (x: number, z: number, r: number) => {
    const [ci, cj] = cellOf(x, z);
    const k = Math.ceil(r / CELL);
    for (let j = Math.max(0, cj - k); j <= Math.min(rows - 1, cj + k); j++) {
      for (let i = Math.max(0, ci - k); i <= Math.min(cols - 1, ci + k); i++) {
        if (!reached[j * cols + i]) continue;
        const [x2, z2] = centre(i, j);
        if (Math.hypot(x2 - x, z2 - z) <= r) return true;
      }
    }
    return false;
  };

  const openShare: Record<string, number> = {};
  for (const zn of layout.zones) {
    let cells = 0;
    let free = 0;
    let got = 0;
    for (let j = 0; j < rows; j++) {
      for (let i = 0; i < cols; i++) {
        const [x, z] = centre(i, j);
        if (!(x > zn.rect[0] && x < zn.rect[2] && z > zn.rect[1] && z < zn.rect[3])) continue;
        cells++;
        if (open[j * cols + i]) free++;
        if (reached[j * cols + i]) got++;
      }
    }
    openShare[zn.id] = cells ? Math.round((free / cells) * 100) / 100 : 0;
    if (!got) issues.push(`${zn.name} cannot be reached from the entrance`);
    else if (!reachable(zn.spawn[0], zn.spawn[1], 1)) issues.push(`The way into ${zn.name} is blocked`);
  }
  for (const d of layout.doors) if (!reachable(d.x, d.z, 1)) issues.push(`The doorway into ${d.between[1]} cannot be reached`);
  for (const h of layout.hotspots) if (!reachable(h.x, h.z, h.r)) issues.push(`${h.title} cannot be reached`);
  // Furniture must stay inside its room (signs and screens hang on walls, so only solid pieces count).
  for (const it of solids) {
    const zn = layout.zones.find((z) => z.id === it.zone);
    if (!zn) continue;
    const f = it.foot;
    const [x0, z0, x1, z1] = "r" in f ? [f.cx - f.r, f.cz - f.r, f.cx + f.r, f.cz + f.r] : [f.x0, f.z0, f.x1, f.z1];
    if (x0 < zn.rect[0] - 0.05 || z0 < zn.rect[1] - 0.05 || x1 > zn.rect[2] + 0.05 || z1 > zn.rect[3] + 0.05) issues.push(`Something in ${zn.name} sticks out of the room`);
  }
  return { ok: issues.length === 0, issues: [...new Set(issues)], openShare };
}
