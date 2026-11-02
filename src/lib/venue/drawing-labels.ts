/**
 * Stands drafted from the venue's own drawing (docs/VENUE_FLOOR_PLAN_EDITOR_PLAN.md section 10, "later, after A to
 * D"): a hotel's floor plan exported as a vector PDF carries its labels as text, "3x3" or "6x3" on each stand and the
 * sponsor's name beside it. Those labels are kept with the drawing, in its pixels, so once the drawing is lined up
 * and its scale set they land where the stands are on our plan.
 *
 * Two steps, both pure:
 *   labelsFromText: the PDF page's text pieces joined into labels ("6" and "x3" are one label, "6x3").
 *   draftStands:    the labels turned into stands for one floor, offered to the team, never applied on their own.
 *
 * A scanned drawing has no text, so it gives no labels; the editor says so.
 *
 * Client-safe: pure, no Node imports, no pdfjs (the caller hands over the pieces and their matrices).
 */
import { r2, type Rect } from "./layout";
import { MAX_DRAWING_LABELS, MAX_LABEL_LENGTH, STAND_NUMBER, isStand, type DrawingLabel, type PlanFixture, type PlanUnderlay, type PlanWall, type VenuePlan } from "./plan";

export type { DrawingLabel };
import { freshStandId, nextStandNumber } from "./plan-edit";
import type { StandSponsorRef } from "./stands";

/**
 * One piece of the page's text: its string, its matrix in the drawn image's pixels (pdfjs's viewport transform times
 * the text's own, `[a, b, c, d, e, f]`, y down) and how far it runs along its line, in those pixels.
 */
export interface TextPiece {
  s: string;
  m: number[];
  w: number;
}

interface Run {
  t: string;
  /** Start and end along the reading direction, and the line's position across it. */
  start: number;
  end: number;
  across: number;
  h: number;
  /** Reads upwards (or downwards): turned a quarter. */
  v: boolean;
  /** The pixel centre, from the first and last pieces. */
  ox: number;
  oy: number;
  ex: number;
  ey: number;
  /** The text's up direction, in pixels: half of it moves the baseline to the middle of the letters. */
  ux: number;
  uy: number;
}

const round1 = (n: number) => Math.round(n * 10) / 10;

function runOf(p: TextPiece): Run | null {
  const t = p.s.replace(/\s+/g, " ").trim();
  const [a, b, c, d, e, f] = p.m;
  const h = Math.hypot(c, d);
  const len = Math.hypot(a, b);
  if (!t || !(h > 0) || !(len > 0) || ![a, b, c, d, e, f, p.w].every(Number.isFinite)) return null;
  const dx = a / len;
  const dy = b / len;
  const v = Math.abs(dy) > Math.abs(dx);
  const ex = e + dx * p.w;
  const ey = f + dy * p.w;
  return {
    t,
    v,
    h,
    start: v ? Math.min(f, ey) : Math.min(e, ex),
    end: v ? Math.max(f, ey) : Math.max(e, ex),
    across: v ? e : f,
    ox: e,
    oy: f,
    ex,
    ey,
    ux: c,
    uy: d,
  };
}

/** Joins `b` onto `a` when it carries on the same line: "6" + "x3", "0" + "2", "Program" + "Wall". */
function carriesOn(a: Run, b: Run): boolean {
  if (a.v !== b.v) return false;
  const h = Math.max(a.h, b.h);
  if (Math.min(a.h, b.h) / h < 0.7) return false;
  if (Math.abs(a.across - b.across) > 0.35 * h) return false;
  const gap = b.start - a.end;
  return gap > -0.3 * h && gap < 0.6 * h;
}

/**
 * The page's text pieces joined into labels, at most MAX_DRAWING_LABELS of them, in the drawing's pixels. A piece
 * that carries on the line of the one before it is joined to it, with a space when there is a word's gap between.
 */
export function labelsFromText(pieces: TextPiece[]): DrawingLabel[] {
  const runs = pieces.map(runOf).filter((r): r is Run => r !== null);
  // Line by line, then along it, so each piece meets the one before it on its line.
  runs.sort((p, q) => Number(p.v) - Number(q.v) || p.across - q.across || p.start - q.start);
  const joined: Run[] = [];
  for (const r of runs) {
    const prev = [...joined].reverse().find((j) => j.v === r.v && carriesOn(j, r));
    if (!prev) {
      joined.push({ ...r });
      continue;
    }
    const gap = r.start - prev.end;
    prev.t = `${prev.t}${gap > 0.25 * Math.max(prev.h, r.h) ? " " : ""}${r.t}`;
    prev.end = Math.max(prev.end, r.end);
    prev.ex = r.ex;
    prev.ey = r.ey;
  }
  const out: DrawingLabel[] = [];
  for (const r of joined) {
    if (r.t.length > MAX_LABEL_LENGTH || !/[A-Za-z0-9]/.test(r.t)) continue;
    const label: DrawingLabel = { t: r.t, x: round1((r.ox + r.ex) / 2 + r.ux / 2), y: round1((r.oy + r.ey) / 2 + r.uy / 2), h: round1(r.h) };
    if (r.v) label.v = true;
    out.push(label);
    if (out.length >= MAX_DRAWING_LABELS) break;
  }
  return out;
}

// ── The drawn boxes ──────────────────────────────────────────────────────────

/** The pdfjs operator codes the box reader follows (`pdfjs.OPS`), handed in so this file never imports pdfjs. */
export interface PdfOps {
  save: number;
  restore: number;
  transform: number;
  constructPath: number;
  rectangle: number;
  paintFormXObjectBegin: number;
  paintFormXObjectEnd: number;
}

type Matrix = number[];
const multiply = (m: Matrix, n: Matrix): Matrix => [
  m[0] * n[0] + m[2] * n[1],
  m[1] * n[0] + m[3] * n[1],
  m[0] * n[2] + m[2] * n[3],
  m[1] * n[2] + m[3] * n[3],
  m[0] * n[4] + m[2] * n[5] + m[4],
  m[1] * n[4] + m[3] * n[5] + m[5],
];
const apply = (m: Matrix, x: number, y: number): [number, number] => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];

/** The most rectangles kept from one page: a CAD export can draw tens of thousands of hatch lines. */
const MAX_BOXES = 20000;

/**
 * Every rectangle the page draws, in the drawn image's pixels (`viewport` is pdfjs's viewport transform): the
 * shapes a hotel's drawing uses for its stands. Follows the page's own transforms, including those of the forms it
 * draws; a rectangle turned by something other than a quarter is left out.
 */
export function pageBoxes(fns: number[], args: unknown[], ops: PdfOps, viewport: Matrix): Rect[] {
  let ctm = viewport;
  const stack: Matrix[] = [];
  const out: Rect[] = [];
  for (let i = 0; i < fns.length && out.length < MAX_BOXES; i++) {
    const fn = fns[i];
    const a = args[i] as unknown[] | null;
    if (fn === ops.save || fn === ops.paintFormXObjectBegin) {
      stack.push(ctm);
      const form = fn === ops.paintFormXObjectBegin && Array.isArray(a?.[0]) ? (a[0] as Matrix) : null;
      if (form?.length === 6) ctm = multiply(ctm, form);
    } else if (fn === ops.restore || fn === ops.paintFormXObjectEnd) {
      ctm = stack.pop() ?? viewport;
    } else if (fn === ops.transform && Array.isArray(a) && a.length === 6) {
      ctm = multiply(ctm, a as Matrix);
    } else if (fn === ops.constructPath && Array.isArray(a)) {
      const [pathOps, , minMax] = a as [number[], number[], number[]];
      // One rectangle on its own: the box of a stand, a table, a room.
      if (pathOps?.length !== 1 || pathOps[0] !== ops.rectangle || minMax?.length !== 4) continue;
      if (Math.abs(ctm[1]) > 1e-6 && Math.abs(ctm[0]) > 1e-6) continue;
      const [x0, y0] = apply(ctm, minMax[0], minMax[1]);
      const [x1, y1] = apply(ctm, minMax[2], minMax[3]);
      out.push([round1(Math.min(x0, x1)), round1(Math.min(y0, y1)), round1(Math.max(x0, x1)), round1(Math.max(y0, y1))]);
    }
  }
  return out;
}

/**
 * Each stand's size label and "Table" given the box drawn around it: the smallest rectangle the label sits in whose
 * shape is the size's (a 6x3 label in a box twice as wide as deep, either way round). A label in no such box keeps
 * none and is drafted around the label itself.
 */
export function withBoxes(labels: DrawingLabel[], boxes: Rect[]): DrawingLabel[] {
  return labels.map((l) => {
    const size = sizeOf(l.t);
    if (!size) return l;
    const want = Math.max(size[0], size[1]) / Math.min(size[0], size[1]);
    let best: Rect | null = null;
    for (const b of boxes) {
      const w = b[2] - b[0];
      const h = b[3] - b[1];
      if (w < l.h || h < l.h || !inside(l.x, l.y, b)) continue;
      const shape = Math.max(w, h) / Math.min(w, h);
      if (Math.abs(shape - want) / want > 0.3) continue;
      if (!best || w * h < (best[2] - best[0]) * (best[3] - best[1])) best = b;
    }
    return best ? { ...l, b: best.map(Math.round) as Rect } : l;
  });
}

// ── Drafting ─────────────────────────────────────────────────────────────────

/** "3x3", "6 x 3", "4×3 m", "2.5x2": width by depth in metres, within what a stand can be. */
const SIZE = /^(\d{1,2}(?:[.,]\d{1,2})?)\s*[x×X*]\s*(\d{1,2}(?:[.,]\d{1,2})?)\s*m?$/;
const TABLE = /^(sponsor\s+)?table$/i;
/** A stand number as drawings print them: "07", "12", "A3", "T1". */
const NUMBER = /^[A-Za-z]{0,2}-?\d{1,3}[A-Za-z]?$/;
/** Words on a venue drawing that are never a company. */
const VENUE_WORDS =
  /^(stage|screen|registration|program(me)? wall|av( console)?|entrance|exit|foyer|ballroom|gallery|pre-?function|lobby|lift|lifts|stairs|toilets?|wc|catering|coffee|buffet|bar|kitchen|storage|store|service|back of house|boh|pillar|column|door|up|down|north|south|east|west|scale|level|floor|second floor|first floor|ground floor|meeting room|room|hall|lounge|sponsor|exhibitor|available|reserved|sold)$/i;
const SPONSOR_SUFFIX = /\b(pharmaceuticals?|pharma|inc|ltd|llc|fze|fzco|fz-?llc|plc|gmbh|co|corp|corporation|company|group|healthcare|health care|middle east|mea|gulf|uae|international|intl|limited)\b/g;
const PRESET_TABLE: [number, number] = [2, 1];

/** The width and depth a size label or "Table" stands for, as written (not yet turned); null for any other label. */
function sizeOf(t: string): [number, number] | null {
  const trimmed = t.trim();
  if (TABLE.test(trimmed)) return PRESET_TABLE;
  const m = SIZE.exec(trimmed);
  if (!m) return null;
  const a = Number(m[1].replace(",", "."));
  const b = Number(m[2].replace(",", "."));
  return a >= 0.5 && b >= 0.5 && a <= 30 && b <= 30 ? [a, b] : null;
}

type Kind = "stand" | "table";

interface Candidate {
  kind: Kind;
  /** Centre on the plan, metres. */
  cx: number;
  cz: number;
  w: number;
  d: number;
  /** For a stand drawn as a box: how many times its labelled size the box measures at the drawing's scale. */
  boxed?: number;
}

interface Point {
  t: string;
  cx: number;
  cz: number;
  h: number;
}

/** A name as compared with the event's sponsors: lower case, letters and digits only, company words left out. */
export function sponsorKey(name: string): string {
  const plain = name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ");
  const stripped = plain.replace(SPONSOR_SUFFIX, " ").replace(/[^a-z0-9]/g, "");
  return stripped || plain.replace(/[^a-z0-9]/g, "");
}

/**
 * The event's sponsor a name on the drawing means: the same name once company words are left out ("Takeda" for
 * "Takeda Pharmaceuticals"), else the one sponsor whose name starts with it or that it starts with (four letters
 * at least). Null when none does, or when two sponsors could be meant.
 */
export function matchSponsor<T extends StandSponsorRef>(name: string, sponsors: T[]): T | null {
  const key = sponsorKey(name);
  if (key.length < 2) return null;
  const exact = sponsors.filter((sp) => sponsorKey(sp.name) === key);
  if (exact.length) return exact.length === 1 ? exact[0] : null;
  if (key.length < 4) return null;
  const near = sponsors.filter((sp) => {
    const k = sponsorKey(sp.name);
    return k.length >= 4 && (k.startsWith(key) || key.startsWith(k));
  });
  return near.length === 1 ? near[0] : null;
}

/** Words one above the other, as a drawing stacks a long name ("Novo" over "Nordisk"), read as one name. */
function stackNames(words: Point[]): Point[] {
  const sorted = [...words].sort((a, b) => a.cz - b.cz || a.cx - b.cx);
  const used = new Set<number>();
  const out: Point[] = [];
  for (let i = 0; i < sorted.length; i++) {
    if (used.has(i)) continue;
    let cur = { ...sorted[i] };
    const parts = [cur];
    for (let j = i + 1; j < sorted.length; j++) {
      if (used.has(j)) continue;
      const nx = sorted[j];
      const h = Math.max(cur.h, nx.h);
      const below = nx.cz - cur.cz;
      if (below <= 0.3 * h || below > 1.6 * h || Math.abs(nx.cx - cur.cx) > 1.5 * h || Math.min(cur.h, nx.h) / h < 0.7) continue;
      used.add(j);
      parts.push(nx);
      cur = nx;
    }
    const t = parts.map((p) => p.t).join(" ");
    out.push({ t, cx: parts.reduce((s, p) => s + p.cx, 0) / parts.length, cz: parts.reduce((s, p) => s + p.cz, 0) / parts.length, h: parts[0].h });
  }
  return out;
}

/** Pairs each point with at most one candidate and back, nearest pairs first, each within the candidate's reach. */
function pairUp(cands: Candidate[], points: Point[], reach: (c: Candidate) => number): Map<number, Point> {
  const pairs: { i: number; j: number; dist: number }[] = [];
  cands.forEach((c, i) =>
    points.forEach((p, j) => {
      const dist = Math.hypot(p.cx - c.cx, p.cz - c.cz);
      if (dist <= reach(c)) pairs.push({ i, j, dist });
    }),
  );
  pairs.sort((a, b) => a.dist - b.dist);
  const taken = new Set<number>();
  const out = new Map<number, Point>();
  for (const p of pairs) {
    if (out.has(p.i) || taken.has(p.j)) continue;
    out.set(p.i, points[p.j]);
    taken.add(p.j);
  }
  return out;
}

const overlapArea = (a: Rect, b: Rect) => Math.max(0, Math.min(a[2], b[2]) - Math.max(a[0], b[0])) * Math.max(0, Math.min(a[3], b[3]) - Math.max(a[1], b[1]));
const EPS = 0.01;
const inside = (x: number, z: number, r: Rect) => x >= r[0] && x <= r[2] && z >= r[1] && z <= r[3];

/** `r` moved, not resized, to lie wholly inside `host`; null when it is bigger than the host. */
function clampInto(r: Rect, host: Rect): Rect | null {
  const w = r[2] - r[0];
  const d = r[3] - r[1];
  if (w > host[2] - host[0] + EPS || d > host[3] - host[1] + EPS) return null;
  const x0 = Math.min(Math.max(r[0], host[0]), host[2] - w);
  const z0 = Math.min(Math.max(r[1], host[1]), host[3] - d);
  return [r2(x0), r2(z0), r2(x0 + w), r2(z0 + d)];
}

/**
 * `r` pushed out of `other` along the shorter way, when the two only just overlap (labels sit a little off a
 * stand's middle, so two stands drawn side by side can overlap by a few centimetres). Null when they overlap
 * by more than a third of the stand: that is two labels on one stand, or a stand drawn over another.
 */
function pushOut(r: Rect, other: Rect): Rect | null {
  const ox = Math.min(r[2], other[2]) - Math.max(r[0], other[0]);
  const oz = Math.min(r[3], other[3]) - Math.max(r[1], other[1]);
  const w = r[2] - r[0];
  const d = r[3] - r[1];
  const alongX = ox / w <= oz / d;
  if ((alongX ? ox / w : oz / d) > 1 / 3) return null;
  if (alongX) {
    const dx = (r[0] + r[2]) / 2 < (other[0] + other[2]) / 2 ? -ox : ox;
    return [r2(r[0] + dx), r[1], r2(r[2] + dx), r[3]];
  }
  const dz = (r[1] + r[3]) / 2 < (other[1] + other[3]) / 2 ? -oz : oz;
  return [r[0], r2(r[1] + dz), r[2], r2(r[3] + dz)];
}

/** Open away from the wall the stand's back is against (within a metre); south when it stands free. */
function facing(r: Rect, host: Rect): PlanWall {
  const gaps: [PlanWall, number][] = [
    ["s", r[1] - host[1]],
    ["n", host[3] - r[3]],
    ["e", r[0] - host[0]],
    ["w", host[2] - r[2]],
  ];
  const [best] = gaps.sort((a, b) => a[1] - b[1]);
  return best[1] <= 1 ? best[0] : "s";
}

/**
 * The stand a size label stands for, on the plan. With its drawn box: in the middle of the box, turned the way the
 * box is long. Without: around the label, turned when the label reads upwards.
 */
function candidateOf(l: DrawingLabel, [a, b]: [number, number], kind: Kind, u: PlanUnderlay): Candidate {
  const long = Math.max(a, b);
  const short = Math.min(a, b);
  if (l.b) {
    const wide = l.b[2] - l.b[0] >= l.b[3] - l.b[1];
    const box = { w: (l.b[2] - l.b[0]) * u.mpp, d: (l.b[3] - l.b[1]) * u.mpp };
    return {
      kind,
      cx: u.at[0] + ((l.b[0] + l.b[2]) / 2) * u.mpp,
      cz: u.at[1] + ((l.b[1] + l.b[3]) / 2) * u.mpp,
      // Long the way the box is long.
      w: wide ? long : short,
      d: wide ? short : long,
      boxed: Math.max(box.w, box.d) / long,
    };
  }
  return { kind, cx: u.at[0] + l.x * u.mpp, cz: u.at[1] + l.y * u.mpp, w: l.v ? b : a, d: l.v ? a : b };
}

/** A sponsor table's number when the drawing prints none: T1, T2 and on, after the highest one taken. */
function nextTableNumber(taken: Set<string>): string {
  const ns = [...taken].flatMap((t) => (/^T\d+$/i.test(t) ? [Number(t.slice(1))] : []));
  return `T${(ns.length ? Math.max(...ns) : 0) + 1}`;
}

/** The next free number for a stand or table the drawing printed none for. */
const nextNumber = (kind: Kind, plan: VenuePlan, taken: Set<string>) => (kind === "table" ? nextTableNumber(taken) : nextStandNumber({ ...plan, otherNumbers: [...taken] }));

export interface StandDraft {
  /** The floor's view with the drafted stands added (and its own stands removed first, when asked). */
  plan: VenuePlan;
  /** Ids of the stands added, in the order drafted. */
  added: string[];
  stands: number;
  tables: number;
  /** How many of them were given to a sponsor by the name beside them. */
  withSponsor: number;
  /** Names beside a stand that match none of the event's sponsors (or more than one), to add on the Sponsors page. */
  unmatched: string[];
  /** Left out: not inside a room or walkway, or too big for it. */
  outside: number;
  /** Left out: on top of a stand or fixture already there, or of another drafted one. */
  overlapping: number;
  /** Left out: the plan holds the most stands and fixtures it can. */
  overLimit: number;
  /** The floor's own stands removed first. */
  removed: number;
  /**
   * How many times their labelled size the drawing's stand boxes measure at its current scale (the middle one), when
   * that is more than 8% off: the drawing's scale is likely wrong, or its stands are not drawn to scale.
   */
  boxScale: number | null;
}

/**
 * Stands for the floor `view` from the labels on its drawing `u`: one per size label ("3x3" is 3 by 3 m; one that
 * reads upwards is turned) and one sponsor table per "Table", centred on the label; given the number printed beside
 * it when it is free, else the next one; given the sponsor whose name is beside it when exactly one matches; open
 * away from the wall behind it. A stand is moved into the room or walkway its label is in, and pushed off a
 * neighbour it only just overlaps. `otherFixtures` is how many stands and fixtures the other floor holds, since the
 * plan's limit counts both floors.
 *
 * Positions are only as good as the drawing's scale and place, so the team sets those first; and they check the
 * draft, since a drawing's label is not always in the middle of its stand.
 */
export function draftStands(
  view: VenuePlan,
  u: PlanUnderlay,
  sponsors: StandSponsorRef[],
  { replace = false, otherFixtures = 0, maxFixtures }: { replace?: boolean; otherFixtures?: number; maxFixtures: number },
): StandDraft {
  const labels = u.labels ?? [];
  const toPlan = (l: DrawingLabel) => ({ cx: u.at[0] + l.x * u.mpp, cz: u.at[1] + l.y * u.mpp, h: l.h * u.mpp });
  const cands: Candidate[] = [];
  const numbers: Point[] = [];
  const words: Point[] = [];
  for (const l of labels) {
    const t = l.t.trim();
    const at = toPlan(l);
    const size = sizeOf(t);
    if (size) {
      cands.push(candidateOf(l, size, TABLE.test(t) ? "table" : "stand", u));
      continue;
    }
    // "x3" on its own is half a size whose other half was not joined to it, never a number.
    if (NUMBER.test(t) && STAND_NUMBER.test(t) && !/^x\d/i.test(t)) {
      numbers.push({ t, ...at });
      continue;
    }
    // Two letters at least, anywhere: "J&J" is a company.
    if ((t.match(/[A-Za-z]/g)?.length ?? 0) >= 2 && !VENUE_WORDS.test(t)) words.push({ t, ...at });
  }

  const names = stackNames(words);
  const reach = (c: Candidate) => Math.max(c.w, c.d) * 0.75 + 1;
  const numberOf = pairUp(cands, numbers, reach);
  const nameOf = pairUp(cands, names, (c) => Math.max(c.w, c.d) * 0.9 + 1.5);
  // A big stand carries its size at one end and its name at the other: its middle is between the two.
  cands.forEach((c, i) => {
    const p = nameOf.get(i);
    if (p && c.boxed === undefined && Math.abs(p.cx - c.cx) <= c.w / 2 && Math.abs(p.cz - c.cz) <= c.d / 2) {
      c.cx = (c.cx + p.cx) / 2;
      c.cz = (c.cz + p.cz) / 2;
    }
  });

  const own = view.fixtures.filter(isStand);
  let plan: VenuePlan = replace ? { ...view, fixtures: view.fixtures.filter((f) => !isStand(f)) } : { ...view, fixtures: [...view.fixtures] };
  const areas = [...plan.rooms, ...plan.corridors].map((a) => a.rect);
  const report = { stands: 0, tables: 0, withSponsor: 0, outside: 0, overlapping: 0, overLimit: 0 };
  const unmatched = new Set<string>();
  const added: PlanFixture[] = [];
  const taken = new Set([...plan.fixtures.flatMap((f) => (f.number ? [f.number] : [])), ...(plan.otherNumbers ?? [])]);

  // Row by row from the north, west to east, so the numbers the draft gives out read in order.
  const order = cands.map((c, i) => i).sort((a, b) => Math.round(cands[a].cz) - Math.round(cands[b].cz) || cands[a].cx - cands[b].cx);
  const placed: { i: number; rect: Rect; host: Rect }[] = [];
  for (const i of order) {
    const c = cands[i];
    const host = areas.find((r) => inside(c.cx, c.cz, r));
    let rect: Rect | null = host ? clampInto([r2(c.cx - c.w / 2), r2(c.cz - c.d / 2), r2(c.cx + c.w / 2), r2(c.cz + c.d / 2)], host) : null;
    if (!host || !rect) {
      report.outside += 1;
      continue;
    }
    const others = () => [...plan.fixtures.map((f) => f.rect), ...placed.map((p) => p.rect)].filter((r) => overlapArea(r, rect as Rect) > EPS);
    for (let tries = 0; tries < 2 && rect && others().length; tries++) {
      const pushed: Rect | null = pushOut(rect, others()[0]);
      rect = pushed && clampInto(pushed, host);
    }
    if (!rect || others().length) {
      report.overlapping += 1;
      continue;
    }
    placed.push({ i, rect, host });
  }

  for (const { i, rect, host } of placed) {
    if (plan.fixtures.length + added.length + otherFixtures >= maxFixtures) {
      report.overLimit += 1;
      continue;
    }
    const c = cands[i];
    const drawn = numberOf.get(i)?.t;
    const name = nameOf.get(i)?.t;
    const sponsor = name ? matchSponsor(name, sponsors) : null;
    if (name && !sponsor) unmatched.add(name);
    const current: VenuePlan = { ...plan, fixtures: [...plan.fixtures, ...added] };
    const number = drawn && !taken.has(drawn) ? drawn : nextNumber(c.kind, current, taken);
    taken.add(number);
    added.push({ id: freshStandId(current, c.kind), kind: c.kind, name: "", rect, dir: facing(rect, host), number, sponsorId: sponsor?.id ?? null });
    report[c.kind === "table" ? "tables" : "stands"] += 1;
    if (sponsor) report.withSponsor += 1;
  }

  plan = { ...plan, fixtures: [...plan.fixtures, ...added], ...(added.length && { standsPlaced: true }) };
  const ratios = cands.flatMap((c) => (c.boxed === undefined ? [] : [c.boxed])).sort((a, b) => a - b);
  const mid = ratios.length ? ratios[Math.floor(ratios.length / 2)] : null;
  const boxScale = mid !== null && Math.abs(mid - 1) > 0.08 ? Math.round(mid * 100) / 100 : null;
  return { plan, added: added.map((f) => f.id), ...report, unmatched: [...unmatched], removed: replace ? own.length : 0, boxScale };
}
