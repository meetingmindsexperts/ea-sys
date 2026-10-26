/**
 * The building drawn from above, as an architect's plan (owner Oct 24: walls,
 * stairs and the like needed a better 2D look): solid walls, thicker outside;
 * door leaves with their swing; the glass entrance as a double line; room
 * names with their size; furniture drawn lightly; and the drawn plan's
 * fixtures (stairs, lift, toilets, exit, pillar, catering, registration counter,
 * photo wall, standing banner) as their usual symbols. Coordinates are metres, +x east and +z south (down the page).
 * Shared by the Venue tab's plan and the floor plan editor.
 */
import type { LayoutDoor, LayoutItem, LayoutWall, LayoutZone, VenueLayout, ZoneKind } from "@/lib/venue/layout";

const ZONE_FILL: Record<ZoneKind, string> = {
  foyer: "fill-amber-50 dark:fill-amber-950/60",
  corridor: "fill-stone-100 dark:fill-stone-900",
  plenary: "fill-rose-50 dark:fill-rose-950/60",
  hall: "fill-sky-50 dark:fill-sky-950/60",
  workshop: "fill-teal-50 dark:fill-teal-950/60",
  posters: "fill-violet-50 dark:fill-violet-950/60",
  exhibition: "fill-emerald-50 dark:fill-emerald-950/60",
  lounge: "fill-orange-50 dark:fill-orange-950/60",
};

const ITEM_TONE: Partial<Record<LayoutItem["t"], string>> = {
  stage: "fill-stone-500 dark:fill-stone-400",
  stand: "fill-emerald-600/60",
  row: "fill-sky-700/45 dark:fill-sky-300/40",
};

/** Wall thickness in metres: outside walls read heavier, as on a printed plan. */
const WALL = 0.3;
const OUTSIDE_WALL = 0.5;
const INK = "fill-stone-800 dark:fill-stone-200";
const LINE = "stroke-stone-700 dark:stroke-stone-300";

function Item({ it }: { it: LayoutItem }) {
  if (it.t === "fixture") return <Fixture it={it} />;
  const f = it.foot;
  if (it.t === "sign" || it.t === "screen") {
    if ("r" in f) return null;
    return <rect x={f.x0} y={f.z0} width={f.x1 - f.x0} height={Math.max(f.z1 - f.z0, 0.15)} className={it.t === "screen" ? "fill-sky-500" : "fill-none"} />;
  }
  if ("r" in f) {
    const plant = it.t === "plant";
    return <circle cx={f.cx} cy={f.cz} r={plant ? 0.45 : f.r * 0.62} className={plant ? "fill-green-600/70" : "fill-stone-400/80 dark:fill-stone-500"} />;
  }
  const tone = ITEM_TONE[it.t] ?? "fill-stone-400/80 dark:fill-stone-500";
  return <rect x={f.x0} y={f.z0} width={f.x1 - f.x0} height={f.z1 - f.z0} className={tone} rx={it.t === "sofa" ? 0.4 : 0} />;
}

type FixtureItem = Extract<LayoutItem, { t: "fixture" }>;

/** Text fitted to a box, turned to run along its longer side. */
function BoxText({ x0, z0, x1, z1, text, className }: { x0: number; z0: number; x1: number; z1: number; text: string; className: string }) {
  const w = x1 - x0;
  const d = z1 - z0;
  const along = Math.max(w, d);
  const size = Math.max(0.25, Math.min(0.9, Math.min(w, d) * 0.6, (along / Math.max(text.length, 1)) * 1.6));
  const cx = (x0 + x1) / 2;
  const cz = (z0 + z1) / 2;
  return (
    <text
      x={cx}
      y={cz}
      fontSize={size}
      textAnchor="middle"
      dominantBaseline="central"
      transform={d > w ? `rotate(-90 ${cx} ${cz})` : undefined}
      className={`pointer-events-none font-semibold ${className}`}
    >
      {text}
    </text>
  );
}

function Fixture({ it }: { it: FixtureItem }) {
  if ("r" in it.foot) return null;
  const { x0, z0, x1, z1 } = it.foot;
  const box = { x0, z0, x1, z1 };
  const rect = { x: x0, y: z0, width: x1 - x0, height: z1 - z0 };
  // The way it faces, as (dx, dz).
  const dx = Math.round(Math.sin(it.yaw));
  const dz = Math.round(Math.cos(it.yaw));
  const thin = Math.min(x1 - x0, z1 - z0) * 0.04 + 0.04;
  if (it.kind === "pillar") return <rect {...rect} className={INK} />;
  if (it.kind === "exit") {
    return (
      <g>
        <rect {...rect} className="fill-green-600" />
        <BoxText {...box} text="EXIT" className="fill-white" />
      </g>
    );
  }
  if (it.kind === "toilets") {
    return (
      <g>
        <rect {...rect} className={`fill-sky-100 dark:fill-sky-900 ${LINE}`} strokeWidth={thin} />
        <BoxText {...box} text="WC" className="fill-sky-900 dark:fill-sky-100" />
        <FrontLine {...box} dx={dx} dz={dz} className="stroke-sky-600" />
      </g>
    );
  }
  if (it.kind === "catering") {
    return (
      <g>
        <rect {...rect} className="fill-amber-200 stroke-amber-700 dark:fill-amber-900" strokeWidth={thin} />
        <BoxText {...box} text={it.name} className="fill-amber-950 dark:fill-amber-100" />
      </g>
    );
  }
  if (it.kind === "registration") {
    return (
      <g>
        <rect {...rect} className="fill-rose-200 stroke-rose-700 dark:fill-rose-900" strokeWidth={thin} />
        <BoxText {...box} text={it.name} className="fill-rose-950 dark:fill-rose-100" />
        <FrontLine {...box} dx={dx} dz={dz} className="stroke-rose-700" />
      </g>
    );
  }
  if (it.kind === "photo-wall" || it.kind === "banner") {
    return (
      <g>
        <rect {...rect} className={it.kind === "banner" ? "fill-indigo-300 dark:fill-indigo-700" : INK} />
        <FrontLine {...box} dx={dx} dz={dz} className="stroke-amber-500" />
      </g>
    );
  }
  if (it.kind === "lift") {
    return (
      <g>
        <rect {...rect} className={`fill-stone-200 dark:fill-stone-700 ${LINE}`} strokeWidth={thin} />
        <line x1={x0} y1={z0} x2={x1} y2={z1} className={LINE} strokeWidth={thin} />
        <line x1={x1} y1={z0} x2={x0} y2={z1} className={LINE} strokeWidth={thin} />
        <FrontLine {...box} dx={dx} dz={dz} className="stroke-sky-600" />
      </g>
    );
  }
  return <Stairs box={box} dx={dx} dz={dz} thin={thin} />;
}

/** A thick line along the side a fixture faces: its doors or its open front. */
function FrontLine({ x0, z0, x1, z1, dx, dz, className }: { x0: number; z0: number; x1: number; z1: number; dx: number; dz: number; className: string }) {
  const t = Math.min(x1 - x0, z1 - z0) * 0.08 + 0.05;
  if (dz) {
    const z = dz > 0 ? z1 : z0;
    return <line x1={x0 + (x1 - x0) * 0.2} y1={z} x2={x1 - (x1 - x0) * 0.2} y2={z} className={className} strokeWidth={t} />;
  }
  const x = dx > 0 ? x1 : x0;
  return <line x1={x} y1={z0 + (z1 - z0) * 0.2} x2={x} y2={z1 - (z1 - z0) * 0.2} className={className} strokeWidth={t} />;
}

/** Treads across the flight every 0.3 m, and an arrow pointing up the stairs (the way it faces). */
function Stairs({ box, dx, dz, thin }: { box: { x0: number; z0: number; x1: number; z1: number }; dx: number; dz: number; thin: number }) {
  const { x0, z0, x1, z1 } = box;
  const alongZ = dz !== 0;
  const [a0, a1] = alongZ ? [z0, z1] : [x0, x1];
  const treads: number[] = [];
  for (let a = a0 + 0.3; a < a1 - 0.05; a += 0.3) treads.push(a);
  const cx = (x0 + x1) / 2;
  const cz = (z0 + z1) / 2;
  const half = (a1 - a0) / 2 - 0.3;
  const sign = dz || dx;
  const head = Math.min(x1 - x0, z1 - z0) * 0.25;
  const tip: [number, number] = alongZ ? [cx, cz + sign * half] : [cx + sign * half, cz];
  const tail: [number, number] = alongZ ? [cx, cz - sign * half] : [cx - sign * half, cz];
  const wing = (s: number): [number, number] => (alongZ ? [tip[0] + s * head, tip[1] - sign * head] : [tip[0] - sign * head, tip[1] + s * head]);
  return (
    <g>
      <rect x={x0} y={z0} width={x1 - x0} height={z1 - z0} className={`fill-background ${LINE}`} strokeWidth={thin} />
      {treads.map((a) => (alongZ ? <line key={a} x1={x0} y1={a} x2={x1} y2={a} className={LINE} strokeWidth={thin / 2} /> : <line key={a} x1={a} y1={z0} x2={a} y2={z1} className={LINE} strokeWidth={thin / 2} />))}
      <polyline points={[tail, tip].map((p) => p.join(",")).join(" ")} className="fill-none stroke-sky-700 dark:stroke-sky-300" strokeWidth={thin * 1.5} />
      <polyline points={[wing(-1), tip, wing(1)].map((p) => p.join(",")).join(" ")} className="fill-none stroke-sky-700 dark:stroke-sky-300" strokeWidth={thin * 1.5} />
    </g>
  );
}

/** A wall's solid pieces: everything but its openings, the glass entrance included (its glazing is drawn on its own). */
function solidPieces(w: LayoutWall): [number, number][] {
  const segs: [number, number][] = [];
  let cur = w.a0;
  for (const o of [...w.opens].sort((p, q) => p.a - q.a)) {
    if (o.a > cur) segs.push([cur, o.a]);
    cur = Math.max(cur, o.b);
  }
  if (cur < w.a1) segs.push([cur, w.a1]);
  return segs;
}

const inside = (zones: LayoutZone[], x: number, z: number) => zones.some((zn) => x > zn.rect[0] && x < zn.rect[2] && z > zn.rect[1] && z < zn.rect[3]);

/** Outside on one side: the building's edge. */
function isOutside(zones: LayoutZone[], w: LayoutWall): boolean {
  const m = (w.a0 + w.a1) / 2;
  if (w.axis === "x") return !inside(zones, m, w.k - 0.3) || !inside(zones, m, w.k + 0.3);
  return !inside(zones, w.k - 0.3, m) || !inside(zones, w.k + 0.3, m);
}

function Walls({ layout }: { layout: VenueLayout }) {
  return (
    <g>
      {layout.walls.map((w, i) => {
        const t = isOutside(layout.zones, w) ? OUTSIDE_WALL : WALL;
        return solidPieces(w).map(([a, b], j) => {
          // Grown by half the thickness only at the wall's own ends, to close the corners; never into a doorway.
          const s = a <= w.a0 + 0.01 ? a - t / 2 : a;
          const e = b >= w.a1 - 0.01 ? b + t / 2 : b;
          return w.axis === "x" ? (
            <rect key={`${i}-${j}`} x={s} y={w.k - t / 2} width={e - s} height={t} className={INK} />
          ) : (
            <rect key={`${i}-${j}`} x={w.k - t / 2} y={s} width={t} height={e - s} className={INK} />
          );
        });
      })}
    </g>
  );
}

/** The glass entrance: two thin lines across the opening, as glazing is drawn. */
function Glazing({ layout }: { layout: VenueLayout }) {
  return (
    <g>
      {layout.walls.flatMap((w, i) =>
        w.opens
          .filter((o) => o.glass)
          .flatMap((o, j) =>
            [-0.12, 0.12].map((off) =>
              w.axis === "x" ? (
                <line key={`${i}-${j}-${off}`} x1={o.a} y1={w.k + off} x2={o.b} y2={w.k + off} className="stroke-sky-500" strokeWidth={0.08} />
              ) : (
                <line key={`${i}-${j}-${off}`} x1={w.k + off} y1={o.a} x2={w.k + off} y2={o.b} className="stroke-sky-500" strokeWidth={0.08} />
              ),
            ),
          ),
      )}
    </g>
  );
}

/** Points along a quarter circle about (cx, cz) from angle a0 to a1 (radians, 0 = +x, pi/2 = +z). */
function arc(cx: number, cz: number, r: number, a0: number, a1: number): string {
  const pts: string[] = [];
  for (let i = 0; i <= 10; i++) {
    const a = a0 + ((a1 - a0) * i) / 10;
    pts.push(`${cx + r * Math.cos(a)},${cz + r * Math.sin(a)}`);
  }
  return pts.join(" ");
}

/**
 * Each door's leaf and swing, opening into the room it leads to: one leaf up
 * to 3 m, a pair up to 6 m, and wider openings (a walkway's mouth) left open.
 */
function DoorSwings({ layout }: { layout: VenueLayout }) {
  return <g>{layout.doors.flatMap((d, i) => swing(layout, d, i))}</g>;
}

function swing(layout: VenueLayout, d: LayoutDoor, i: number) {
  if (d.width > 6) return [];
  const room = layout.zones.find((z) => z.id === d.between[1]);
  if (!room) return [];
  const leaves = d.width > 3 ? 2 : 1;
  const r = d.width / leaves;
  const out = [];
  for (let k = 0; k < leaves; k++) {
    // The hinge at one end of the opening (each end for a pair), the leaf standing open into the room.
    const end = k === 0 ? -1 : 1;
    if (d.axis === "x") {
      const into = (room.rect[1] + room.rect[3]) / 2 > d.z ? 1 : -1;
      const hx = d.x + (end * d.width) / 2;
      // Angles chosen so the swing is the quarter turn between them, never the long way round.
      const closed = end < 0 ? 0 : Math.PI;
      const open = closed + (end < 0 ? into : -into) * (Math.PI / 2);
      out.push(<line key={`l${i}-${k}`} x1={hx} y1={d.z} x2={hx} y2={d.z + into * r} className={LINE} strokeWidth={0.06} />);
      out.push(<polyline key={`a${i}-${k}`} points={arc(hx, d.z, r, closed, open)} className="fill-none stroke-stone-400 dark:stroke-stone-500" strokeWidth={0.04} />);
      continue;
    }
    const into = (room.rect[0] + room.rect[2]) / 2 > d.x ? 1 : -1;
    const hz = d.z + (end * d.width) / 2;
    const closed = end < 0 ? Math.PI / 2 : -Math.PI / 2;
    const open = closed + (end < 0 ? -into : into) * (Math.PI / 2);
    out.push(<line key={`l${i}-${k}`} x1={d.x} y1={hz} x2={d.x + into * r} y2={hz} className={LINE} strokeWidth={0.06} />);
    out.push(<polyline key={`a${i}-${k}`} points={arc(d.x, hz, r, closed, open)} className="fill-none stroke-stone-400 dark:stroke-stone-500" strokeWidth={0.04} />);
  }
  return out;
}

const sizeLabel = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(1));

/** Each room's name, with its size under it, kept within the room. */
function Labels({ layout }: { layout: VenueLayout }) {
  return (
    <g>
      {layout.zones
        .filter((z) => z.kind !== "corridor")
        .map((z) => {
          const w = z.rect[2] - z.rect[0];
          const d = z.rect[3] - z.rect[1];
          const size = Math.max(1.1, Math.min(2.2, w / 9));
          const cx = (z.rect[0] + z.rect[2]) / 2;
          const cz = (z.rect[1] + z.rect[3]) / 2;
          const halo = { paintOrder: "stroke" as const, stroke: "var(--background)" };
          return (
            <g key={`t${z.id}`} className="pointer-events-none">
              <text x={cx} y={cz} textAnchor="middle" dominantBaseline="middle" fontSize={size} className="fill-foreground font-medium" {...halo} strokeWidth={size * 0.35}>
                {z.name}
              </text>
              {d > size * 3 && (
                <text x={cx} y={cz + size * 1.1} textAnchor="middle" dominantBaseline="middle" fontSize={size * 0.6} className="fill-muted-foreground tabular-nums" {...halo} strokeWidth={size * 0.2}>
                  {sizeLabel(w)} × {sizeLabel(d)} m
                </text>
              )}
            </g>
          );
        })}
    </g>
  );
}

/** A venue of several floors, drawn side by side: each floor's name above it. */
function FloorNames({ layout }: { layout: VenueLayout }) {
  if (!layout.levels) return null;
  return (
    <g className="pointer-events-none">
      {layout.levels.map((l) => (
        <text key={l.id} x={l.bounds[0]} y={l.bounds[1] - 1.2} fontSize={2.4} className="fill-foreground font-semibold">
          {l.name}
        </text>
      ))}
    </g>
  );
}

/** The building drawn from above. Shared by the plan view and the editor. */
export function LayoutDrawing({ layout }: { layout: VenueLayout }) {
  return (
    <g>
      {layout.zones.map((z) => (
        <rect key={z.id} x={z.rect[0]} y={z.rect[1]} width={z.rect[2] - z.rect[0]} height={z.rect[3] - z.rect[1]} className={ZONE_FILL[z.kind]} />
      ))}
      {layout.items.map((it, i) => (
        <Item key={i} it={it} />
      ))}
      <DoorSwings layout={layout} />
      <Walls layout={layout} />
      <Glazing layout={layout} />
      <Labels layout={layout} />
      <FloorNames layout={layout} />
    </g>
  );
}
