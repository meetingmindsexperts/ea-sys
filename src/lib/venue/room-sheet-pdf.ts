/**
 * One room's setup sheet as a PDF (docs/VENUE_FLOOR_PLAN_EDITOR_PLAN.md, section 11, step 3): what a hotel's
 * banqueting team draws for a function room (the Al Wasl Ballroom plan, Oct 30, 2026), made from the same layout
 * the walkable venue is built from. The room to scale with its walls and doors, the stage and screen with their
 * sizes, every table, row and chair, the AV console and other fixtures, the room's width and depth, the gap from
 * the stage to the first seats, and the headcount with its setup ("PAX 112, classroom").
 *
 * A4, turned to suit the room. Server only (pdfkit).
 */
import PDFDocument from "pdfkit";
import { apiLogger } from "@/lib/logger";
import { sanitizePdfText } from "@/lib/pdf/pdf-text";
import { formatFooterTimestamp } from "@/lib/pdf/document-layout";
import type { LayoutItem, LayoutZone, Rect, VenueLayout } from "./layout";
import { SETUP_INFO } from "./rooms";
import { chooseScale, fitLabel } from "./floor-plan-pdf";

export interface RoomSheetInput {
  layout: VenueLayout;
  zoneId: string;
  eventName: string;
  /** "12 to 14 March 2027", already in the event's time zone. */
  dateLine: string | null;
  place: string | null;
  generatedAt: Date;
}

type Doc = PDFKit.PDFDocument;
type Project = (x: number, z: number) => [number, number];

const MARGIN = 36;
const HEADER_H = 78;
const FOOTER_H = 22;
/** Room around the room for its dimension lines, in metres. */
const AROUND = 2.2;
const INK = "#1f2937";
const MUTED = "#6b7280";
const WALL = "#2b2f36";
const FLOOR = "#f6f7f9";
const STAGE = "#e3d3b8";
const TABLE = "#ffffff";
const CHAIR = "#4b5563";
const ACCENT = "#00799f";

/** Seats an item holds, as the plan counts them. */
export function seatsOf(it: LayoutItem): number {
  if (it.t === "row") return it.n;
  if (it.t === "round") return it.chairs;
  if (it.t === "longTable") return it.n * (it.both ? 2 : 1);
  return 0;
}

const m = (n: number) => `${n.toFixed(2)} m`;

/** The room's own items, and what of the sheet's numbers come from them. */
export function roomSheetFacts(layout: VenueLayout, zoneId: string) {
  const zone = layout.zones.find((z) => z.id === zoneId && z.kind !== "corridor");
  if (!zone) return null;
  const items = layout.items.filter((it) => it.zone === zoneId);
  const seats = items.reduce((n, it) => n + seatsOf(it), 0);
  return { zone, items, seats, gap: stageGap(items, zone.rect) };
}

const boxOf = (it: LayoutItem): Rect => {
  const f = it.foot;
  return "r" in f ? [f.cx - f.r, f.cz - f.r, f.cx + f.r, f.cz + f.r] : [f.x0, f.z0, f.x1, f.z1];
};

/**
 * The clear gap from the stage's front to the nearest seats, measured across the stage's long side, with where to
 * draw it: the number a hotel puts on its plan (2.55 m on the Al Wasl Ballroom's). Null with no stage or seats.
 */
export function stageGap(items: LayoutItem[], room: Rect): { metres: number; from: [number, number]; to: [number, number] } | null {
  const stage = items.find((it) => it.t === "stage");
  const seating = items.filter((it) => seatsOf(it) > 0);
  if (!stage || !seating.length) return null;
  const [sx0, sz0, sx1, sz1] = boxOf(stage);
  const back = stageBack(boxOf(stage), room);
  // Measured towards the door, to the seats in front of the stage only (review of f10bdb84: a stage deeper than
  // it is wide was read as facing sideways, and the gap was measured to a block of tables beside it).
  const towardsZ = back === "n" || back === "s";
  const [lo, hi] = towardsZ ? [sx0, sx1] : [sz0, sz1];
  const mid = (lo + hi) / 2;
  let best: { metres: number; from: [number, number]; to: [number, number] } | null = null;
  for (const it of seating) {
    const [x0, z0, x1, z1] = boxOf(it);
    const [a, b] = towardsZ ? [x0, x1] : [z0, z1];
    if (Math.min(b, hi) - Math.max(a, lo) <= 0) continue;
    // Each wall the stage can stand against: the gap from its front to this item, and where to draw it.
    const towards: Record<typeof back, [number, [number, number], [number, number]]> = {
      n: [z0 - sz1, [mid, sz1], [mid, z0]],
      s: [sz0 - z1, [mid, sz0], [mid, z1]],
      w: [x0 - sx1, [sx1, mid], [x0, mid]],
      e: [sx0 - x1, [sx0, mid], [x1, mid]],
    };
    const [g, from, to] = towards[back];
    if (g >= 0 && (!best || g < best.metres)) best = { metres: Math.round(g * 100) / 100, from, to };
  }
  return best;
}

/** The wall the stage stands against (its back), the one it is nearest: a room faces away from it. */
export function stageBack([x0, z0, x1, z1]: Rect, [rx0, rz0, rx1, rz1]: Rect): "n" | "s" | "e" | "w" {
  const d = { n: z0 - rz0, s: rz1 - z1, w: x0 - rx0, e: rx1 - x1 } as const;
  return (Object.keys(d) as (keyof typeof d)[]).reduce((a, b) => (d[b] < d[a] ? b : a));
}

export async function renderRoomSheetPdf(input: RoomSheetInput): Promise<Buffer> {
  const facts = roomSheetFacts(input.layout, input.zoneId);
  if (!facts) throw new Error(`No room ${input.zoneId} in the layout`);
  const [x0, z0, x1, z1] = facts.zone.rect;
  const layoutDir = z1 - z0 > x1 - x0 ? "portrait" : "landscape";
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({ size: "A4", layout: layoutDir, margin: MARGIN, info: { Title: sanitizePdfText(`${facts.zone.name} setup, ${input.eventName}`) } });
      const chunks: Buffer[] = [];
      doc.on("data", (c: Buffer) => chunks.push(c));
      doc.on("end", () => resolve(Buffer.concat(chunks)));
      doc.on("error", (err: Error) => {
        apiLogger.error({ err, msg: "venue-room-sheet:stream-error" });
        reject(err);
      });
      drawSheet(doc, input, facts);
      doc.end();
    } catch (err) {
      reject(err);
    }
  });
}

function drawSheet(doc: Doc, input: RoomSheetInput, facts: NonNullable<ReturnType<typeof roomSheetFacts>>) {
  const { zone, items, seats, gap } = facts;
  const pageW = doc.page.width;
  const pageH = doc.page.height;
  drawHeader(doc, input, zone, pageW);

  const [x0, z0, x1, z1] = zone.rect;
  const availW = pageW - 2 * MARGIN;
  const availH = pageH - 2 * MARGIN - HEADER_H - FOOTER_H;
  const { ratio, ptPerM } = chooseScale(x1 - x0 + 2 * AROUND, z1 - z0 + 2 * AROUND, availW, availH);
  const ox = MARGIN + (availW - (x1 - x0) * ptPerM) / 2;
  const oy = MARGIN + HEADER_H + (availH - (z1 - z0) * ptPerM) / 2;
  const P: Project = (x, z) => [ox + (x - x0) * ptPerM, oy + (z - z0) * ptPerM];
  const [rx, ry] = P(x0, z0);
  const rw = (x1 - x0) * ptPerM;
  const rh = (z1 - z0) * ptPerM;

  doc.rect(rx, ry, rw, rh).fill(FLOOR);
  for (const it of items) drawItem(doc, it, P, ptPerM, facts);
  doc.rect(rx, ry, rw, rh).lineWidth(2.2).strokeColor(WALL).stroke();
  drawMovableWalls(doc, input.layout, zone, P);
  drawDoors(doc, input.layout, zone, P);
  // Each measurement goes on a wall without a door, so the "Door" label never sits under it.
  const walls = doorWalls(input.layout, zone);
  if (walls.has("north") && !walls.has("south")) drawDimension(doc, [rx, ry + rh + 14], [rx + rw, ry + rh + 14], m(x1 - x0), "below");
  else drawDimension(doc, [rx, ry - 14], [rx + rw, ry - 14], m(x1 - x0), "above");
  if (walls.has("west") && !walls.has("east")) drawDimension(doc, [rx + rw + 14, ry], [rx + rw + 14, ry + rh], m(z1 - z0), "right");
  else drawDimension(doc, [rx - 14, ry], [rx - 14, ry + rh], m(z1 - z0), "left");
  if (gap) {
    const [a, b] = [P(...gap.from), P(...gap.to)];
    // Beside a vertical gap line, above a horizontal one, so it clears the stage's own label.
    drawDimension(doc, a, b, m(gap.metres), Math.abs(b[0] - a[0]) > Math.abs(b[1] - a[1]) ? "above" : "right", ACCENT);
  }

  const footY = pageH - MARGIN - 10;
  const setup = zone.setup ? SETUP_INFO[zone.setup].label : null;
  // A very large room is drawn with up to 420 seats (layout.ts); say so rather than pass the drawing off as all of them.
  const drawn = seats < zone.capacity ? `${seats.toLocaleString("en-GB")} of ${zone.capacity.toLocaleString("en-GB")} seats drawn` : `${seats.toLocaleString("en-GB")} seats drawn`;
  const bits = [`Scale 1:${ratio} on A4`, `${drawn}${setup ? ` (${setup.toLowerCase()})` : ""}`, "North is up", `Made ${formatFooterTimestamp(input.generatedAt)}`];
  doc.font("Helvetica").fontSize(7.5).fillColor(MUTED).text(sanitizePdfText(bits.join("  ·  ")), MARGIN, footY, { width: pageW - 2 * MARGIN, align: "center", lineBreak: false });
}

function drawHeader(doc: Doc, input: RoomSheetInput, zone: LayoutZone, pageW: number) {
  const width = pageW - 2 * MARGIN;
  const widthOf = (font: string) => (text: string, size: number) => doc.font(font).fontSize(size).widthOfString(text);
  doc.font("Helvetica").fontSize(9).fillColor(MUTED).text(sanitizePdfText([input.eventName, input.dateLine, input.place].filter(Boolean).join("  ·  ")), MARGIN, MARGIN, { width, lineBreak: false, ellipsis: true });
  const title = fitLabel(widthOf("Helvetica-Bold"), sanitizePdfText(zone.name), width * 0.6, 22, 12);
  doc.font("Helvetica-Bold").fontSize(title.size).fillColor(INK).text(title.text, MARGIN, MARGIN + 16, { lineBreak: false });
  const setup = zone.setup ? `, ${SETUP_INFO[zone.setup].label.toLowerCase()}` : "";
  const pax = `PAX ${zone.capacity.toLocaleString("en-GB")}${setup}`;
  doc.font("Helvetica-Bold").fontSize(16).fillColor(ACCENT).text(sanitizePdfText(pax), MARGIN, MARGIN + 18, { width, align: "right", lineBreak: false });
  doc.moveTo(MARGIN, MARGIN + HEADER_H - 22).lineTo(MARGIN + width, MARGIN + HEADER_H - 22).lineWidth(0.5).strokeColor("#d1d5db").stroke();
}

function drawItem(doc: Doc, it: LayoutItem, P: Project, ptPerM: number, facts?: { zone: LayoutZone }) {
  const [bx0, bz0, bx1, bz1] = boxOf(it);
  const [x, y] = P(bx0, bz0);
  const w = (bx1 - bx0) * ptPerM;
  const h = (bz1 - bz0) * ptPerM;
  if (it.t === "stage") {
    doc.rect(x, y, w, h).fill(STAGE);
    doc.rect(x, y, w, h).lineWidth(0.8).strokeColor("#a08660").stroke();
    // Width along the wall it stands against by depth into the room, from the room's axes, not its shape.
    const back = facts ? stageBack([bx0, bz0, bx1, bz1], facts.zone.rect) : "n";
    const ns = back === "n" || back === "s";
    const across = ns ? bx1 - bx0 : bz1 - bz0;
    const deep = ns ? bz1 - bz0 : bx1 - bx0;
    centredLabel(doc, `Stage ${across.toFixed(2)} x ${deep.toFixed(2)} m`, x, y, w, h, 9);
    return;
  }
  if (it.t === "screen") {
    const tall = h > w;
    doc.rect(x, y, Math.max(w, 2.5), Math.max(h, 2.5)).fill("#0f172a");
    const label = sanitizePdfText(`Screen ${it.w} x ${it.hgt} m`);
    doc.font("Helvetica-Bold").fontSize(7.5).fillColor(INK);
    const tw = doc.widthOfString(label);
    if (!tall) doc.text(label, x + w / 2 - tw / 2, y + Math.max(h, 2.5) + 2, { lineBreak: false });
    else {
      // Past the screen's end, along the wall and just inside it, reading upwards: clear of the stage's label.
      const [zx0, , zx1] = boxOf(it);
      const room = facts && facts.zone.rect;
      const eastWall = room ? (zx0 + zx1) / 2 > (room[0] + room[2]) / 2 : false;
      const lx = eastWall ? x - 3 - 8 : x + Math.max(w, 2.5) + 3;
      // Before the screen instead when the wall runs out after it.
      const roomEnd = room ? P(room[0], room[3])[1] : Infinity;
      const ly = y + h + 4 + tw <= roomEnd - 3 ? y + h + 4 + tw : y - 4;
      doc.save().translate(lx, ly).rotate(-90).text(label, 0, 0, { lineBreak: false }).restore();
    }
    return;
  }
  if (it.t === "lectern") return void doc.rect(x, y, w, h).fill("#6b4f3a");
  if (it.t === "row") {
    const [ax, az] = it.p0;
    const [ex, ez] = it.p1;
    for (let i = 0; i < it.n; i++) {
      const t = it.n > 1 ? i / (it.n - 1) : 0;
      chair(doc, P(ax + (ex - ax) * t, az + (ez - az) * t), ptPerM);
    }
    return;
  }
  if (it.t === "longTable") return void longTable(doc, it, P, ptPerM);
  if (it.t === "round") return void round(doc, it, P, ptPerM);
  if (it.t === "fixture") {
    doc.rect(x, y, w, h).fill("#dbe4ee");
    doc.rect(x, y, w, h).lineWidth(0.6).strokeColor("#64748b").stroke();
    centredLabel(doc, it.name, x, y, w, h, 7.5);
    return;
  }
  if (it.t === "stand") {
    doc.rect(x, y, w, h).fill("#cfe8d8");
    doc.rect(x, y, w, h).lineWidth(0.6).strokeColor("#3f7d5a").stroke();
    centredLabel(doc, it.number ? `Stand ${it.number}` : it.label, x, y, w, h, 7.5);
    return;
  }
  if (it.t === "sign" || it.t === "plant") return;
  doc.rect(x, y, w, h).fill("#e5e7eb");
}

function chair(doc: Doc, [cx, cy]: [number, number], ptPerM: number) {
  const s = 0.42 * ptPerM;
  doc.roundedRect(cx - s / 2, cy - s / 2, s, s, Math.min(1.5, s / 4)).fill(CHAIR);
}

function longTable(doc: Doc, it: Extract<LayoutItem, { t: "longTable" }>, P: Project, ptPerM: number) {
  const [ax, az] = it.p0;
  const [ex, ez] = it.p1;
  const fx = Math.sin(it.yaw);
  const fz = Math.cos(it.yaw);
  const hd = it.d / 2;
  const tx0 = Math.min(ax, ex) - Math.abs(fx) * hd;
  const tz0 = Math.min(az, ez) - Math.abs(fz) * hd;
  const tx1 = Math.max(ax, ex) + Math.abs(fx) * hd;
  const tz1 = Math.max(az, ez) + Math.abs(fz) * hd;
  const [x, y] = P(tx0, tz0);
  doc.rect(x, y, (tx1 - tx0) * ptPerM, (tz1 - tz0) * ptPerM).fill(TABLE);
  doc.rect(x, y, (tx1 - tx0) * ptPerM, (tz1 - tz0) * ptPerM).lineWidth(0.6).strokeColor("#4b5563").stroke();
  const back = hd + 0.4;
  for (let i = 0; i < it.n; i++) {
    const t = (i + 0.5) / it.n;
    const px = ax + (ex - ax) * t;
    const pz = az + (ez - az) * t;
    chair(doc, P(px - fx * back, pz - fz * back), ptPerM);
    if (it.both) chair(doc, P(px + fx * back, pz + fz * back), ptPerM);
  }
}

function round(doc: Doc, it: Extract<LayoutItem, { t: "round" }>, P: Project, ptPerM: number) {
  const [cx, cy] = P(it.cx, it.cz);
  doc.circle(cx, cy, 0.95 * ptPerM).fill(TABLE);
  doc.circle(cx, cy, 0.95 * ptPerM).lineWidth(0.6).strokeColor("#4b5563").stroke();
  // As the 3D venue seats them (world.js): a cabaret table leaves the third facing the stage empty.
  const openA = it.open === undefined ? null : Math.atan2(Math.cos(it.open), Math.sin(it.open));
  for (let k = 0; k < it.chairs; k++) {
    const a = openA === null ? (k / it.chairs) * Math.PI * 2 + 0.3 : openA + Math.PI / 3 + ((k + 0.5) / it.chairs) * ((Math.PI * 4) / 3);
    chair(doc, P(it.cx + Math.cos(a) * 1.45, it.cz + Math.sin(a) * 1.45), ptPerM);
  }
}

/** A movable wall on the room's edge (one section of a divided ballroom): dashed over the outline, and named. */
function drawMovableWalls(doc: Doc, layout: VenueLayout, zone: LayoutZone, P: Project) {
  const [x0, z0, x1, z1] = zone.rect;
  const EPS = 0.05;
  for (const w of layout.walls.filter((q) => q.movable)) {
    const onEdge = w.axis === "x" ? Math.abs(w.k - z0) < EPS || Math.abs(w.k - z1) < EPS : Math.abs(w.k - x0) < EPS || Math.abs(w.k - x1) < EPS;
    const [lo, hi] = w.axis === "x" ? [x0, x1] : [z0, z1];
    const a = Math.max(w.a0, lo);
    const b = Math.min(w.a1, hi);
    if (!onEdge || b - a < 0.5) continue;
    const [p, q] = w.axis === "x" ? [P(a, w.k), P(b, w.k)] : [P(w.k, a), P(w.k, b)];
    doc.moveTo(p[0], p[1]).lineTo(q[0], q[1]).lineWidth(3).strokeColor(FLOOR).stroke();
    doc.moveTo(p[0], p[1]).lineTo(q[0], q[1]).lineWidth(1.6).dash(4, { space: 3 }).strokeColor(WALL).stroke().undash();
    const label = "Movable wall";
    doc.font("Helvetica").fontSize(6.5).fillColor(MUTED);
    const tw = doc.widthOfString(label);
    const [mx, my] = [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2];
    if (w.axis === "x") doc.text(label, mx - tw / 2, my + 4, { lineBreak: false });
    else doc.save().translate(mx + 4, my + tw / 2).rotate(-90).text(label, 0, 0, { lineBreak: false }).restore();
  }
}

/** The walls of the room that have a door in them. */
function doorWalls(layout: VenueLayout, zone: LayoutZone): Set<"north" | "south" | "east" | "west"> {
  const [x0, z0, x1, z1] = zone.rect;
  const out = new Set<"north" | "south" | "east" | "west">();
  for (const d of layout.doors) {
    if (!d.between.includes(zone.id)) continue;
    if (d.axis === "x") out.add(Math.abs(d.z - z0) < Math.abs(d.z - z1) ? "north" : "south");
    else out.add(Math.abs(d.x - x0) < Math.abs(d.x - x1) ? "west" : "east");
  }
  return out;
}

function drawDoors(doc: Doc, layout: VenueLayout, zone: LayoutZone, P: Project) {
  for (const d of layout.doors) {
    if (!d.between.includes(zone.id)) continue;
    const half = d.width / 2;
    const [a, b] = d.axis === "x" ? [P(d.x - half, d.z), P(d.x + half, d.z)] : [P(d.x, d.z - half), P(d.x, d.z + half)];
    doc.moveTo(a[0], a[1]).lineTo(b[0], b[1]).lineWidth(3.2).strokeColor(FLOOR).stroke();
    doc.circle(a[0], a[1], 1.4).fill(WALL);
    doc.circle(b[0], b[1], 1.4).fill(WALL);
    const [mx, my] = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
    const label = "Door";
    doc.font("Helvetica").fontSize(6.5).fillColor(MUTED);
    const tw = doc.widthOfString(label);
    if (d.axis === "x") doc.text(label, mx - tw / 2, my + (d.z <= (zone.rect[1] + zone.rect[3]) / 2 ? -9 : 3), { lineBreak: false });
    else doc.text(label, mx + (d.x <= (zone.rect[0] + zone.rect[2]) / 2 ? -tw - 4 : 4), my - 3, { lineBreak: false });
  }
}

/** A dimension line with end ticks and its length, the way the hotel's plan marks them. */
function drawDimension(doc: Doc, a: [number, number], b: [number, number], text: string, side: "above" | "below" | "left" | "right", colour = INK) {
  doc.moveTo(a[0], a[1]).lineTo(b[0], b[1]).lineWidth(0.6).strokeColor(colour).stroke();
  const vertical = Math.abs(b[0] - a[0]) < Math.abs(b[1] - a[1]);
  for (const [px, py] of [a, b]) {
    if (vertical) doc.moveTo(px - 3, py).lineTo(px + 3, py);
    else doc.moveTo(px, py - 3).lineTo(px, py + 3);
    doc.lineWidth(0.6).strokeColor(colour).stroke();
  }
  doc.font("Helvetica-Bold").fontSize(7.5).fillColor(colour);
  const tw = doc.widthOfString(text);
  const mx = (a[0] + b[0]) / 2;
  const my = (a[1] + b[1]) / 2;
  if (side === "above") doc.text(text, mx - tw / 2, my - 11, { lineBreak: false });
  else if (side === "below") doc.text(text, mx - tw / 2, my + 4, { lineBreak: false });
  else if (side === "left") {
    doc.save().translate(mx - 4, my + tw / 2).rotate(-90).text(text, 0, -6, { lineBreak: false }).restore();
  } else if (vertical) doc.text(text, mx + 4, my - 3.5, { lineBreak: false });
  else doc.save().translate(mx + 4 + 6, my + tw / 2).rotate(-90).text(text, 0, -6, { lineBreak: false }).restore();
}

function centredLabel(doc: Doc, text: string, x: number, y: number, w: number, h: number, size: number) {
  const widthOf = (t: string, s: number) => doc.font("Helvetica-Bold").fontSize(s).widthOfString(t);
  // A box taller than it is wide reads its label upwards along it, as the hotel's plans do.
  if (h > w * 1.3) {
    const fit = fitLabel(widthOf, sanitizePdfText(text), Math.max(h - 4, 10), size, 5);
    const tw = widthOf(fit.text, fit.size);
    doc.save().translate(x + w / 2 - fit.size / 2, y + h / 2 + tw / 2).rotate(-90);
    doc.font("Helvetica-Bold").fontSize(fit.size).fillColor(INK).text(fit.text, 0, 0, { lineBreak: false });
    doc.restore();
    return;
  }
  const fit = fitLabel(widthOf, sanitizePdfText(text), Math.max(w - 4, 10), size, 5);
  doc.font("Helvetica-Bold").fontSize(fit.size).fillColor(INK).text(fit.text, x, y + h / 2 - fit.size / 2, { width: w, align: "center", lineBreak: false });
}

/** "Al Wasl Ballroom" as a file name part. */
export const roomFilePart = (name: string) => name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "room";
