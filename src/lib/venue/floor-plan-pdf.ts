/**
 * The venue's 2D floor plan as a PDF (docs/VENUE_FLOOR_PLAN_EDITOR_PLAN.md,
 * section 3.7, phase 0a). Drawn from the same `VenueLayout` the plan view and
 * the walkable venue use, so the paper matches the screen and the 3D building.
 * SERVER ONLY (pdfkit).
 *
 * The page: the event's name, dates and place at the top; the plan, north up,
 * at a printed scale from a list of round ratios (1 : 400, not 1 : 437); a
 * scale bar, a north arrow, a legend of the room types present and, when
 * stands carry sponsors, a key from stand number to sponsor. Stands show their
 * number on the plan: at plan scale a 3 m stand is too small for a name.
 */
import PDFDocument from "pdfkit";
import { apiLogger } from "@/lib/logger";
import { sanitizePdfText } from "@/lib/pdf/pdf-text";
import { formatFooterTimestamp } from "@/lib/pdf/document-layout";
import type { LayoutItem, LayoutWall, Rect, VenueLayout, ZoneKind } from "./layout";
import type { FixtureKind } from "./plan";

export type PlanPaper = "A3" | "A4";
export const PLAN_PAPERS: readonly PlanPaper[] = ["A3", "A4"];

export interface FloorPlanPdfInput {
  layout: VenueLayout;
  eventName: string;
  /** "12 to 14 March 2027", already in the event's time zone. */
  dateLine: string | null;
  /** "Atlantis The Palm, Dubai, United Arab Emirates". */
  place: string | null;
  /** The sponsor on each stand: index n - 1 for stand n, the venue's own rule. */
  sponsorsByStand: (string | null)[];
  paper: PlanPaper;
  generatedAt: Date;
}

/** Points per millimetre. */
const PT_PER_MM = 72 / 25.4;
const MARGIN = 36;
const HEADER_H = 54;
const FOOTER_H = 20;
const LEGEND_ROW_H = 14;
/** Room below the plan for the ENTRANCE label and its arrow. */
const ENTRANCE_H = 26;

/** Scales a plan may be printed at: round numbers a reader can measure with. */
export const PLAN_SCALES = [50, 100, 125, 150, 200, 250, 300, 400, 500, 600, 750, 1000, 1250, 1500, 2000, 2500, 3000, 5000] as const;

/**
 * The printed scale: the smallest round ratio at which a plan this size fits
 * the space. Returns the ratio (1 : ratio) and points per metre at it.
 */
export function chooseScale(widthM: number, depthM: number, availW: number, availH: number): { ratio: number; ptPerM: number } {
  const fit = Math.min(availW / widthM, availH / depthM);
  const exact = (1000 * PT_PER_MM) / fit;
  const ratio = PLAN_SCALES.find((r) => r >= exact) ?? Math.ceil(exact / 1000) * 1000;
  return { ratio, ptPerM: (1000 * PT_PER_MM) / ratio };
}

/** Portrait for a plan deeper than it is wide, landscape otherwise. */
export function chooseOrientation(bounds: Rect): "portrait" | "landscape" {
  const [x0, z0, x1, z1] = bounds;
  return z1 - z0 > x1 - x0 ? "portrait" : "landscape";
}

/** A scale bar length in metres that reads cleanly: 5, 10, 20 or 50 m, about a fifth of the plan's width. */
export function scaleBarMetres(planWidthM: number): number {
  const target = planWidthM / 5;
  return [5, 10, 20, 50, 100].find((m) => m >= target) ?? 100;
}

const ZONE_FILL: Record<ZoneKind, string> = {
  foyer: "#fdf3dc",
  corridor: "#efedea",
  plenary: "#fbe4e7",
  hall: "#e2eff8",
  workshop: "#dff3f0",
  posters: "#ece5f8",
  exhibition: "#e1f3e7",
  lounge: "#fdebdc",
};

const ZONE_LABEL: Record<ZoneKind, string> = {
  foyer: "Foyer and registration",
  corridor: "Corridor",
  plenary: "Plenary hall",
  hall: "Parallel hall",
  workshop: "Workshop room",
  posters: "Poster gallery",
  exhibition: "Exhibition hall",
  lounge: "Networking lounge",
};

const INK = "#1f2937";
const MUTED = "#6b7280";
const WALL = "#2b2f36";
const GLASS = "#3b9ad9";
const STAND_FILL = "#7cc49a";
const FURNITURE = "#c9ccd1";
const SEATS = "#9fbfd8";
const ITEM_FILL: Partial<Record<LayoutItem["t"], string>> = { row: SEATS, stage: "#8d939b" };

type Doc = PDFKit.PDFDocument;

/** Text that fits `maxW` at the largest size from `size` down to `min`, else cut with an ellipsis at `min`. */
export function fitLabel(widthOf: (text: string, size: number) => number, text: string, maxW: number, size: number, min: number): { text: string; size: number } {
  for (let s = size; s >= min; s -= 0.5) {
    if (widthOf(text, s) <= maxW) return { text, size: s };
  }
  let cut = text;
  while (cut.length > 1 && widthOf(`${cut}…`, min) > maxW) cut = cut.slice(0, -1);
  return { text: `${cut}…`, size: min };
}

export async function renderFloorPlanPdf(input: FloorPlanPdfInput): Promise<Buffer> {
  const { layout } = input;
  const layoutDir = chooseOrientation(layout.bounds);
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({ size: input.paper, layout: layoutDir, margin: MARGIN, info: { Title: sanitizePdfText(`${input.eventName} floor plan`) } });
      const chunks: Buffer[] = [];
      doc.on("data", (c: Buffer) => chunks.push(c));
      doc.on("end", () => resolve(Buffer.concat(chunks)));
      doc.on("error", (err: Error) => {
        apiLogger.error({ err, msg: "venue-plan-pdf:stream-error" });
        reject(err);
      });
      drawPage(doc, input);
      doc.end();
    } catch (err) {
      reject(err);
    }
  });
}

function drawPage(doc: Doc, input: FloorPlanPdfInput) {
  const { layout } = input;
  const pageW = doc.page.width;
  const pageH = doc.page.height;
  const kinds = [...new Set(layout.zones.map((z) => z.kind))];
  const stands = layout.items.filter((it): it is Extract<LayoutItem, { t: "stand" }> => it.t === "stand");
  const keyed = stands.map((s) => ({ n: s.n, name: input.sponsorsByStand[s.n - 1] ?? null })).filter((s) => s.name);

  // The key under the plan: the scale bar, the legend (wrapping to as many rows as it needs, so a busy plan's
  // fixtures are never cut), then the stand key in columns.
  const fixtureKinds = [...new Set(layout.items.flatMap((it) => (it.t === "fixture" ? [it.kind] : [])))];
  const legend = legendEntries(kinds, fixtureKinds, stands.length > 0);
  const legendRows = layoutLegend(doc, legend, pageW - MARGIN * 2).rows;
  const keyCols = Math.max(1, Math.floor((pageW - MARGIN * 2) / 150));
  const keyRows = keyed.length ? Math.ceil(keyed.length / keyCols) + 1 : 0;
  const bottomH = LEGEND_ROW_H * (1 + legendRows + keyRows) + 8;

  drawHeader(doc, input, pageW);

  const [x0, z0, x1, z1] = layout.bounds;
  const widthM = x1 - x0;
  const depthM = z1 - z0;
  const areaTop = MARGIN + HEADER_H;
  const areaW = pageW - MARGIN * 2;
  const areaH = pageH - areaTop - bottomH - FOOTER_H - MARGIN - ENTRANCE_H;
  const { ratio, ptPerM } = chooseScale(widthM, depthM, areaW, areaH);
  const ox = MARGIN + (areaW - widthM * ptPerM) / 2;
  const oy = areaTop + (areaH - depthM * ptPerM) / 2;
  const P = (x: number, z: number): [number, number] => [ox + (x - x0) * ptPerM, oy + (z - z0) * ptPerM];

  drawZones(doc, layout, P, ptPerM);
  drawItems(doc, layout.items, P, ptPerM);
  drawDoorSwings(doc, layout, P, ptPerM);
  drawWalls(doc, layout, P, ptPerM);
  drawRoomLabels(doc, layout, P, ptPerM);
  drawFloorNames(doc, layout, P);
  // The label stays on the page and below the header, whichever wall the entrance is in.
  drawEntrance(doc, layout, P, { minX: MARGIN, maxX: pageW - MARGIN, minY: areaTop - 8 });
  drawNorthArrow(doc, MARGIN + areaW - 18, areaTop + 6);

  const legendTop = pageH - MARGIN - FOOTER_H - bottomH + 8;
  drawScaleBar(doc, MARGIN + 8, legendTop, widthM, ptPerM, ratio, input.paper);
  drawLegend(doc, legend, MARGIN, legendTop + LEGEND_ROW_H, areaW);
  if (keyed.length) drawStandKey(doc, keyed, MARGIN, legendTop + LEGEND_ROW_H * (1 + legendRows), keyCols, areaW);

  doc.font("Helvetica").fontSize(7).fillColor(MUTED);
  doc.text(
    sanitizePdfText(`Generated ${formatFooterTimestamp(input.generatedAt)} from the event's Venue tab. North is up. Seat rows are drawn up to 420 per room.`),
    MARGIN,
    pageH - MARGIN - 10,
    { width: areaW, lineBreak: false },
  );
}

function drawHeader(doc: Doc, input: FloorPlanPdfInput, pageW: number) {
  const w = pageW - MARGIN * 2;
  doc.font("Helvetica-Bold").fontSize(16).fillColor(INK).text(sanitizePdfText(input.eventName), MARGIN, MARGIN, { width: w - 140, lineBreak: false, ellipsis: true });
  const sub = [input.dateLine, input.place].filter(Boolean).join("  ·  ");
  if (sub) doc.font("Helvetica").fontSize(10).fillColor(MUTED).text(sanitizePdfText(sub), MARGIN, MARGIN + 21, { width: w - 140, lineBreak: false, ellipsis: true });
  doc.font("Helvetica-Bold").fontSize(11).fillColor(INK).text("Floor plan", MARGIN, MARGIN + 2, { width: w, align: "right" });
  doc.moveTo(MARGIN, MARGIN + HEADER_H - 12).lineTo(MARGIN + w, MARGIN + HEADER_H - 12).lineWidth(0.5).strokeColor("#d1d5db").stroke();
}

type Project = (x: number, z: number) => [number, number];

function rectOf(P: Project, r: Rect, ptPerM: number): [number, number, number, number] {
  const [ax, ay] = P(r[0], r[1]);
  return [ax, ay, (r[2] - r[0]) * ptPerM, (r[3] - r[1]) * ptPerM];
}

function drawZones(doc: Doc, layout: VenueLayout, P: Project, ptPerM: number) {
  for (const z of layout.zones) {
    const [x, y, w, h] = rectOf(P, z.rect, ptPerM);
    doc.rect(x, y, w, h).fill(ZONE_FILL[z.kind]);
  }
}

function drawItems(doc: Doc, items: LayoutItem[], P: Project, ptPerM: number) {
  for (const it of items) {
    if (it.t === "sign" || it.t === "screen") continue;
    const f = it.foot;
    if ("r" in f) {
      const [cx, cy] = P(f.cx, f.cz);
      const r = (it.t === "plant" ? 0.45 : f.r * 0.62) * ptPerM;
      doc.circle(cx, cy, r).fill(it.t === "plant" ? "#9cc89a" : FURNITURE);
      continue;
    }
    const [x, y] = P(f.x0, f.z0);
    const w = (f.x1 - f.x0) * ptPerM;
    const h = (f.z1 - f.z0) * ptPerM;
    if (it.t === "fixture") {
      drawFixture(doc, it, [x, y, w, h]);
      continue;
    }
    if (it.t === "stand") {
      doc.rect(x, y, w, h).fillAndStroke(STAND_FILL, "#3f8a5f");
      const size = Math.max(4, Math.min(9, Math.min(w, h) * 0.5));
      doc.font("Helvetica-Bold").fontSize(size).fillColor(INK).text(String(it.n), x, y + h / 2 - size / 2, { width: w, align: "center", lineBreak: false });
      continue;
    }
    doc.rect(x, y, w, h).fill(ITEM_FILL[it.t] ?? FURNITURE);
  }
}

/** A wall's solid stretches: everything but its openings. Glass stays solid here and is drawn on top. */
function wallSegments(w: LayoutWall): [number, number][] {
  const segs: [number, number][] = [];
  let cur = w.a0;
  for (const o of [...w.opens].sort((p, q) => p.a - q.a)) {
    if (o.glass) continue;
    if (o.a > cur) segs.push([cur, o.a]);
    cur = Math.max(cur, o.b);
  }
  if (cur < w.a1) segs.push([cur, w.a1]);
  return segs;
}

const inZone = (layout: VenueLayout, x: number, z: number) => layout.zones.some((zn) => x > zn.rect[0] && x < zn.rect[2] && z > zn.rect[1] && z < zn.rect[3]);

/** Outside on one side: the building's edge, drawn heavier as on an architect's plan. */
function outsideWall(layout: VenueLayout, w: LayoutWall): boolean {
  const m = (w.a0 + w.a1) / 2;
  if (w.axis === "x") return !inZone(layout, m, w.k - 0.3) || !inZone(layout, m, w.k + 0.3);
  return !inZone(layout, w.k - 0.3, m) || !inZone(layout, w.k + 0.3, m);
}

function drawWalls(doc: Doc, layout: VenueLayout, P: Project, ptPerM: number) {
  doc.lineCap("butt");
  for (const w of layout.walls) {
    const t = outsideWall(layout, w) ? 0.5 : 0.3;
    const thick = Math.max(0.8, t * ptPerM);
    for (const [a, b] of wallSegments(w)) {
      // Grown by half the thickness only at the wall's own ends, to close the corners; never into a doorway.
      const s = a <= w.a0 + 0.01 ? a - t / 2 : a;
      const e = b >= w.a1 - 0.01 ? b + t / 2 : b;
      const [p, q] = w.axis === "x" ? [P(s, w.k), P(e, w.k)] : [P(w.k, s), P(w.k, e)];
      doc.moveTo(p[0], p[1]).lineTo(q[0], q[1]).lineWidth(thick).strokeColor(WALL).stroke();
    }
    for (const o of w.opens.filter((x) => x.glass)) {
      const [p, q] = w.axis === "x" ? [P(o.a, w.k), P(o.b, w.k)] : [P(w.k, o.a), P(w.k, o.b)];
      doc.moveTo(p[0], p[1]).lineTo(q[0], q[1]).lineWidth(thick).strokeColor("#ffffff").stroke();
      doc.moveTo(p[0], p[1]).lineTo(q[0], q[1]).lineWidth(thick * 0.6).dash(2, { space: 1.5 }).strokeColor(GLASS).stroke().undash();
    }
  }
}

/**
 * Each door's leaf and swing into the room it leads to, as on the plan view:
 * one leaf up to 3 m, a pair up to 6 m, wider openings left open.
 */
function drawDoorSwings(doc: Doc, layout: VenueLayout, P: Project, ptPerM: number) {
  for (const d of layout.doors) {
    const room = layout.zones.find((z) => z.id === d.between[1]);
    if (!room || d.width > 6) continue;
    const leaves = d.width > 3 ? 2 : 1;
    const r = (d.width / leaves) * ptPerM;
    for (let k = 0; k < leaves; k++) {
      const end = k === 0 ? -1 : 1;
      const alongX = d.axis === "x";
      const into = alongX ? Math.sign((room.rect[1] + room.rect[3]) / 2 - d.z) : Math.sign((room.rect[0] + room.rect[2]) / 2 - d.x);
      const [hx, hy] = alongX ? P(d.x + (end * d.width) / 2, d.z) : P(d.x, d.z + (end * d.width) / 2);
      // The leaf stands open into the room; the arc runs from it back to where it closes.
      const leaf: [number, number] = alongX ? [hx, hy + into * r] : [hx + into * r, hy];
      const shut: [number, number] = alongX ? [hx - end * r, hy] : [hx, hy - end * r];
      doc.moveTo(hx, hy).lineTo(leaf[0], leaf[1]).lineWidth(0.6).strokeColor(WALL).stroke();
      const c = 0.5523 * r;
      const ctrl1: [number, number] = alongX ? [leaf[0] - end * c, leaf[1]] : [leaf[0], leaf[1] - end * c];
      const ctrl2: [number, number] = alongX ? [shut[0], shut[1] + into * c] : [shut[0] + into * c, shut[1]];
      doc.moveTo(leaf[0], leaf[1]).bezierCurveTo(ctrl1[0], ctrl1[1], ctrl2[0], ctrl2[1], shut[0], shut[1]).lineWidth(0.35).strokeColor("#9ca3af").stroke();
    }
  }
}

const ARROW = "#0369a1";
const FIXTURE_FILL: Record<FixtureKind, string> = { stairs: "#ffffff", lift: "#e5e7eb", toilets: "#e0f2fe", exit: "#16a34a", pillar: "#374151", catering: "#fde68a" };
const FIXTURE_TEXT: Partial<Record<FixtureKind, string>> = { toilets: "WC", exit: "EXIT" };
const FIXTURE_LEGEND: Record<FixtureKind, string> = { stairs: "Stairs (arrow up)", lift: "Lift", toilets: "Toilets (WC)", exit: "Emergency exit", pillar: "Pillar", catering: "Catering point" };

/** A venue of several floors is printed side by side, each floor's name above it. */
function drawFloorNames(doc: Doc, layout: VenueLayout, P: Project) {
  for (const l of layout.levels ?? []) {
    const [x, y] = P(l.bounds[0], l.bounds[1]);
    doc.font("Helvetica-Bold").fontSize(11).fillColor(WALL).text(sanitizePdfText(l.name), x, y - 16, { lineBreak: false });
  }
}

/** A fixture's plan symbol: stairs with treads and an arrow up, a lift crossed, the rest filled and named. */
function drawFixture(doc: Doc, it: Extract<LayoutItem, { t: "fixture" }>, [x, y, w, h]: Box) {
  doc.rect(x, y, w, h).fillAndStroke(FIXTURE_FILL[it.kind], it.kind === "pillar" ? FIXTURE_FILL.pillar : WALL);
  const dx = Math.round(Math.sin(it.yaw));
  const dz = Math.round(Math.cos(it.yaw));
  if (it.kind === "lift") {
    doc.moveTo(x, y).lineTo(x + w, y + h).moveTo(x + w, y).lineTo(x, y + h).lineWidth(0.4).strokeColor(WALL).stroke();
    return;
  }
  if (it.kind === "stairs") {
    const alongY = dz !== 0;
    const len = alongY ? h : w;
    const step = Math.max(1.5, len / Math.max(1, Math.round(len / 3)));
    for (let a = step; a < len - 0.5; a += step) {
      if (alongY) doc.moveTo(x, y + a).lineTo(x + w, y + a);
      else doc.moveTo(x + a, y).lineTo(x + a, y + h);
    }
    doc.lineWidth(0.3).strokeColor(WALL).stroke();
    const cx = x + w / 2;
    const cy = y + h / 2;
    const half = len / 2 - 1;
    const sgn = dz || dx;
    const tip: [number, number] = alongY ? [cx, cy + sgn * half] : [cx + sgn * half, cy];
    const tail: [number, number] = alongY ? [cx, cy - sgn * half] : [cx - sgn * half, cy];
    // An arrow up the flight, the way a plan marks which way stairs climb.
    const head = Math.min(w, h) * 0.22;
    const wing = (s: number): [number, number] => (alongY ? [tip[0] + s * head, tip[1] - sgn * head] : [tip[0] - sgn * head, tip[1] + s * head]);
    doc.moveTo(tail[0], tail[1]).lineTo(tip[0], tip[1]).lineWidth(0.9).strokeColor(ARROW).stroke();
    doc.moveTo(...wing(-1)).lineTo(tip[0], tip[1]).lineTo(...wing(1)).lineWidth(0.9).strokeColor(ARROW).stroke();
    return;
  }
  const text = FIXTURE_TEXT[it.kind] ?? (it.kind === "catering" ? it.name : "");
  if (!text) return;
  // Along the longer side, turned for a tall box, so a narrow counter still reads.
  const tall = h > w * 1.4;
  const along = tall ? h : w;
  const size = Math.max(3, Math.min(7, Math.min(w, h) * 0.55));
  doc.font("Helvetica-Bold").fontSize(size).fillColor(it.kind === "exit" ? "#ffffff" : INK);
  if (!tall) {
    doc.text(sanitizePdfText(text), x, y + h / 2 - size / 2, { width: w, align: "center", lineBreak: false, ellipsis: true });
    return;
  }
  const cx = x + w / 2;
  const cy = y + h / 2;
  doc.save().rotate(-90, { origin: [cx, cy] });
  doc.text(sanitizePdfText(text), cx - along / 2, cy - size / 2, { width: along, align: "center", lineBreak: false, ellipsis: true });
  doc.restore();
}

type Box = [number, number, number, number];
const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));
const overlap = (a: Box, b: Box) => Math.max(0, Math.min(a[2], b[2]) - Math.max(a[0], b[0])) * Math.max(0, Math.min(a[3], b[3]) - Math.max(a[1], b[1]));

/**
 * Where a room's label goes: the centre unless that covers stands or furniture,
 * else whichever of the top, bottom, left or right of the room covers least.
 * Stands count four times over: a hidden stand number cannot be read at all.
 */
export function placeLabel(room: Box, label: { w: number; h: number }, obstacles: { box: Box; weight: number }[]): { x: number; y: number } {
  const [rx, ry, rw, rh] = room;
  const inset = 4;
  const cx = rx + rw / 2 - label.w / 2;
  const cy = ry + rh / 2 - label.h / 2;
  const spots = [
    { x: cx, y: cy },
    { x: cx, y: ry + inset },
    { x: cx, y: ry + rh - label.h - inset },
    { x: rx + inset, y: cy },
    { x: rx + rw - label.w - inset, y: cy },
  ];
  let best = spots[0];
  let bestCost = Infinity;
  for (const s of spots) {
    const box: Box = [s.x, s.y, s.x + label.w, s.y + label.h];
    const cost = obstacles.reduce((n, o) => n + overlap(box, o.box) * o.weight, 0);
    if (cost < bestCost - 0.5) {
      best = s;
      bestCost = cost;
    }
  }
  return best;
}

function drawRoomLabels(doc: Doc, layout: VenueLayout, P: Project, ptPerM: number) {
  const widthOf = (font: string) => (text: string, size: number) => doc.font(font).fontSize(size).widthOfString(text);
  const obstacles = layout.items
    .filter((it) => it.t === "stand" || (it.solid && it.t !== "row"))
    .map((it) => {
      const f = it.foot;
      const r: Rect = "r" in f ? [f.cx - f.r, f.cz - f.r, f.cx + f.r, f.cz + f.r] : [f.x0, f.z0, f.x1, f.z1];
      const [x, y] = P(r[0], r[1]);
      return { box: [x, y, x + (r[2] - r[0]) * ptPerM, y + (r[3] - r[1]) * ptPerM] as Box, weight: it.t === "stand" ? 4 : 1 };
    });
  for (const z of layout.zones) {
    const [x, y, w, h] = rectOf(P, z.rect, ptPerM);
    const name = sanitizePdfText(z.name);
    if (z.kind === "corridor") {
      const label = fitLabel(widthOf("Helvetica-Oblique"), name, h - 8, 7, 4);
      doc.save().translate(x + w / 2, y + h / 2).rotate(-90);
      doc.font("Helvetica-Oblique").fontSize(label.size).fillColor(MUTED).text(label.text, -h / 2, -label.size / 2, { width: h, align: "center", lineBreak: false });
      doc.restore();
      continue;
    }
    const title = fitLabel(widthOf("Helvetica-Bold"), name, w - 6, 10, 5);
    const sub = z.capacity > 0 ? fitLabel(widthOf("Helvetica"), `${z.capacity.toLocaleString("en-GB")} people`, w - 6, 7.5, 4) : null;
    const blockH = title.size + (sub ? sub.size + 2 : 0);
    const bandW = Math.min(w - 2, Math.max(doc.font("Helvetica-Bold").fontSize(title.size).widthOfString(title.text), sub ? doc.font("Helvetica").fontSize(sub.size).widthOfString(sub.text) : 0) + 6);
    const at = placeLabel([x, y, w, h], { w: bandW, h: blockH + 4 }, obstacles);
    // A white band behind the words keeps them readable over seat rows.
    doc.rect(at.x, at.y, bandW, blockH + 4).fillOpacity(0.85).fill("#ffffff").fillOpacity(1);
    doc.font("Helvetica-Bold").fontSize(title.size).fillColor(INK).text(title.text, at.x, at.y + 2, { width: bandW, align: "center", lineBreak: false });
    if (sub) doc.font("Helvetica").fontSize(sub.size).fillColor(MUTED).text(sub.text, at.x, at.y + 2 + title.size + 2, { width: bandW, align: "center", lineBreak: false });
  }
}

/** "ENTRANCE" outside the glass doors, whichever wall they are in, with an arrow pointing in. */
function drawEntrance(doc: Doc, layout: VenueLayout, P: Project, page: { minX: number; maxX: number; minY: number }) {
  for (const w of layout.walls) {
    for (const o of w.opens.filter((x) => x.glass)) {
      const mid = (o.a + o.b) / 2;
      const [px, py] = w.axis === "x" ? P(mid, w.k) : P(w.k, mid);
      doc.font("Helvetica-Bold").fontSize(8).fillColor(GLASS);
      if (w.axis === "x") {
        // Outside is the side with no room: below for a south entrance, above for a north one.
        const below = inZone(layout, mid, w.k - 0.3);
        const ty = below ? py + 5 : Math.max(page.minY, py - 26);
        const tx = clamp(px - 40, page.minX, page.maxX - 80);
        doc.text("ENTRANCE", tx, ty, { width: 80, align: "center", lineBreak: false });
        const tip = below ? py + 17 : py - 13;
        const base = below ? tip + 4 : tip - 4;
        doc.moveTo(px, tip).lineTo(px - 3, base).lineTo(px + 3, base).closePath().fill(GLASS);
        continue;
      }
      // A west or east entrance: the word beside the wall on the outside, the arrow at its end pointing in.
      const west = inZone(layout, w.k + 0.3, mid);
      const label = doc.widthOfString("ENTRANCE");
      const tx = clamp(west ? px - label - 16 : px + 16, page.minX, page.maxX - label);
      doc.text("ENTRANCE", tx, py - 4, { lineBreak: false });
      const tip = west ? px - 6 : px + 6;
      const base = west ? tip - 4 : tip + 4;
      doc.moveTo(tip, py).lineTo(base, py - 3).lineTo(base, py + 3).closePath().fill(GLASS);
    }
  }
}

function drawNorthArrow(doc: Doc, cx: number, top: number) {
  doc.moveTo(cx, top).lineTo(cx - 5, top + 14).lineTo(cx, top + 10).lineTo(cx + 5, top + 14).closePath().fill(INK);
  doc.font("Helvetica-Bold").fontSize(8).fillColor(INK).text("N", cx - 10, top + 16, { width: 20, align: "center", lineBreak: false });
}

function drawScaleBar(doc: Doc, x: number, y: number, planWidthM: number, ptPerM: number, ratio: number, paper: PlanPaper) {
  const metres = scaleBarMetres(planWidthM);
  const len = metres * ptPerM;
  const half = len / 2;
  doc.rect(x, y + 2, half, 4).fill(INK);
  doc.rect(x + half, y + 2, half, 4).lineWidth(0.6).fillAndStroke("#ffffff", INK);
  // The figures sit on the bar's own line, so nothing spills into the legend row below.
  doc.font("Helvetica").fontSize(7).fillColor(INK);
  doc.text("0", x - 7, y + 1, { lineBreak: false });
  doc.text(`${metres} m   ·   Scale 1 : ${ratio.toLocaleString("en-GB")} when printed on ${paper}`, x + len + 5, y + 1, { lineBreak: false });
}

type LegendEntry = { fill: string; label: string; stroke?: string };

/** What the key lists: only what is on this plan (a building without an exhibition has no stand in its key). */
function legendEntries(kinds: ZoneKind[], fixtures: FixtureKind[], stands: boolean): LegendEntry[] {
  const entries: LegendEntry[] = kinds.map((k) => ({ fill: ZONE_FILL[k], label: ZONE_LABEL[k] }));
  if (stands) entries.push({ fill: STAND_FILL, label: "Exhibition stand (numbered)", stroke: "#3f8a5f" });
  for (const k of fixtures) entries.push({ fill: FIXTURE_FILL[k], label: FIXTURE_LEGEND[k], stroke: WALL });
  return entries;
}

/** Where each key entry goes, row by row within `width`. */
function layoutLegend(doc: Doc, entries: LegendEntry[], width: number): { rows: number; at: { x: number; row: number }[] } {
  doc.font("Helvetica").fontSize(7);
  const at: { x: number; row: number }[] = [];
  let x = 0;
  let row = 0;
  for (const e of entries) {
    const w = doc.widthOfString(e.label) + 18;
    if (x > 0 && x + w > width) {
      row += 1;
      x = 0;
    }
    at.push({ x, row });
    x += w + 6;
  }
  return { rows: entries.length ? row + 1 : 0, at };
}

function drawLegend(doc: Doc, entries: LegendEntry[], x: number, y: number, width: number) {
  const { at } = layoutLegend(doc, entries, width);
  doc.font("Helvetica").fontSize(7);
  entries.forEach((e, i) => {
    const cx = x + at[i].x;
    const cy = y + at[i].row * LEGEND_ROW_H;
    doc.rect(cx, cy + 2, 9, 7);
    doc.lineWidth(0.5).fillAndStroke(e.fill, e.stroke ?? "#b8bcc2");
    doc.fillColor(INK).text(e.label, cx + 12, cy + 2, { lineBreak: false });
  });
}

function drawStandKey(doc: Doc, keyed: { n: number; name: string | null }[], x: number, y: number, cols: number, width: number) {
  const colW = width / cols;
  doc.font("Helvetica-Bold").fontSize(7.5).fillColor(INK).text("Stands", x, y + 2, { lineBreak: false });
  const widthOf = (text: string, size: number) => doc.font("Helvetica").fontSize(size).widthOfString(text);
  keyed.forEach((s, i) => {
    const col = i % cols;
    const row = Math.floor(i / cols);
    const label = fitLabel(widthOf, sanitizePdfText(`${s.n}  ${s.name}`), colW - 8, 7, 5);
    doc.font("Helvetica").fontSize(label.size).fillColor(INK).text(label.text, x + col * colW, y + LEGEND_ROW_H * (row + 1) + 2, { lineBreak: false });
  });
}

/**
 * The event's dates for the page header, in the event's own time zone:
 * "14 March 2027", "12 to 14 March 2027", "30 March to 2 April 2027" or
 * "30 December 2026 to 2 January 2027".
 */
export function planDateLine(start: Date, end: Date, timeZone: string): string {
  const parts = (d: Date) => {
    const p = new Intl.DateTimeFormat("en-GB", { timeZone, day: "numeric", month: "long", year: "numeric" }).formatToParts(d);
    const get = (t: string) => p.find((x) => x.type === t)?.value ?? "";
    return { day: get("day"), month: get("month"), year: get("year") };
  };
  const a = parts(start);
  const b = parts(end);
  if (a.year !== b.year) return `${a.day} ${a.month} ${a.year} to ${b.day} ${b.month} ${b.year}`;
  if (a.month !== b.month) return `${a.day} ${a.month} to ${b.day} ${b.month} ${b.year}`;
  if (a.day !== b.day) return `${a.day} to ${b.day} ${b.month} ${b.year}`;
  return `${a.day} ${a.month} ${a.year}`;
}
