/**
 * The venue's own drawing under the plan (docs/VENUE_FLOOR_PLAN_EDITOR_PLAN.md,
 * section 10, phase B): placing it, moving it and setting its scale, as pure
 * edits from one plan to the next, like plan-edit.ts.
 *
 * Scale is set the way a person would: draw a line over something whose real
 * length is known (a wall, or a stand the drawing labels "6x3") and type that
 * length. The end the line started from stays put on the plan, so what was
 * lined up there stays lined up.
 *
 * Client-safe: pure, no Node imports.
 */
import { r2, type Rect } from "./layout";
import { floorOf, floorView, PLAN_EXTENT, type PlanFloor, type PlanUnderlay, type VenuePlan } from "./plan";
import { UPLOAD_PREFIX } from "../upload-prefixes";

/** Where an event's drawings are stored: the only folder the drawing route reads from. */
export const drawingFolder = (eventId: string) => `${UPLOAD_PREFIX.venueDrawings}${eventId}/`;

/** The largest drawing file, after a PDF is turned into an image (nginx's ceiling is 10 MB). */
export const MAX_DRAWING_BYTES = 10 * 1024 * 1024;
/** The longest side, in pixels, a PDF page is drawn at: sharp at 400 % zoom on a 100 m building, small enough to upload. */
export const DRAWING_LONG_SIDE = 4000;
/** A drawing starts this see-through: lines readable, the rooms still visible through it. */
export const DRAWING_OPACITY = 0.7;

/** A drawing's real type, from its first bytes (never its name); null for anything but a PNG, JPEG or WebP image. */
export function sniffDrawing(buf: Uint8Array): { contentType: string; ext: "png" | "jpg" | "webp" } | null {
  const at = (bytes: number[], from = 0) => bytes.every((b, i) => buf[from + i] === b);
  if (at([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return { contentType: "image/png", ext: "png" };
  if (at([0xff, 0xd8, 0xff])) return { contentType: "image/jpeg", ext: "jpg" };
  if (at([0x52, 0x49, 0x46, 0x46]) && at([0x57, 0x45, 0x42, 0x50], 8)) return { contentType: "image/webp", ext: "webp" };
  return null;
}

export const underlayOf = (plan: VenuePlan, floor: PlanFloor): PlanUnderlay | undefined => plan.underlays?.find((u) => floorOf(u) === floor);

/** The plan with this floor's drawing replaced (null removes it). The ground floor is written as no floor, as elsewhere. */
export function withUnderlay(plan: VenuePlan, floor: PlanFloor, u: PlanUnderlay | null): VenuePlan {
  const rest = (plan.underlays ?? []).filter((x) => floorOf(x) !== floor);
  const next = u ? [...rest, floor === "ground" ? withoutFloor(u) : { ...u, floor }] : rest;
  const out: VenuePlan = { ...plan, underlays: next };
  if (!next.length) delete out.underlays;
  return out;
}

function withoutFloor(u: PlanUnderlay): PlanUnderlay {
  const copy = { ...u };
  delete copy.floor;
  return copy;
}

/** The ground the drawing covers on the plan, in metres. */
export function underlayRect(u: PlanUnderlay): Rect {
  return [u.at[0], u.at[1], r2(u.at[0] + u.px[0] * u.mpp), r2(u.at[1] + u.px[1] * u.mpp)];
}

/**
 * A new drawing's first place: over this floor's building, as wide as it, so the organiser starts from roughly
 * the right size and sets the scale exactly with one line. With nothing drawn yet, 100 m wide at the origin.
 */
export function placeUnderlay(plan: VenuePlan, floor: PlanFloor, file: { path: string; name: string; px: [number, number] }): PlanUnderlay {
  const view = floorView(plan, floor);
  const rects = [...view.rooms, ...view.corridors].map((a) => a.rect);
  const x0 = rects.length ? Math.min(...rects.map((r) => r[0])) : 0;
  const z0 = rects.length ? Math.min(...rects.map((r) => r[1])) : 0;
  const width = rects.length ? Math.max(...rects.map((r) => r[2])) - x0 : 100;
  return { path: file.path, name: file.name, px: file.px, mpp: clampMpp(width / file.px[0]), at: [r2(x0), r2(z0)], opacity: DRAWING_OPACITY };
}

const clampMpp = (m: number) => Math.min(10, Math.max(0.0005, m));
const clampAt = (n: number) => r2(Math.min(PLAN_EXTENT, Math.max(-PLAN_EXTENT, n)));

/** The drawing moved by (dx, dz) metres. */
export function moveUnderlay(u: PlanUnderlay, dx: number, dz: number): PlanUnderlay {
  return { ...u, at: [clampAt(u.at[0] + dx), clampAt(u.at[1] + dz)] };
}

/**
 * The drawing scaled so the line from `a` to `b` (plan metres, drawn over it) is `metres` long. `a` stays where
 * it is. Null when the line is too short to measure by, or the length is not a positive number.
 */
export function scaleUnderlay(u: PlanUnderlay, a: [number, number], b: [number, number], metres: number): PlanUnderlay | null {
  const drawn = Math.hypot(b[0] - a[0], b[1] - a[1]);
  if (drawn < 0.05 || !(metres > 0) || !Number.isFinite(metres)) return null;
  const k = metres / drawn;
  const mpp = clampMpp(u.mpp * k);
  // The factor the clamp allowed, so `a` stays fixed even at the limits.
  const real = mpp / u.mpp;
  return { ...u, mpp, at: [clampAt(a[0] + (u.at[0] - a[0]) * real), clampAt(a[1] + (u.at[1] - a[1]) * real)] };
}
