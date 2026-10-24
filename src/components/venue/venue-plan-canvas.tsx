"use client";

/**
 * The floor plan editor's drawing surface (docs/VENUE_FLOOR_PLAN_EDITOR_PLAN.md,
 * 3.5): the building as it will be built, with a hit area over each room and
 * walkway. Drag an area to move it, drag the handles of the selected one to
 * resize it, and with the Walkway tool drag across empty floor to draw one.
 *
 * It owns only the gesture. Every change goes through lib/venue/plan-edit.ts:
 * `onLive` while dragging (redrawn, not yet in the undo history) and
 * `onCommit` when the pointer lifts (one undo step per gesture).
 */
import { useEffect, useId, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import type { Rect, VenueLayout } from "@/lib/venue/layout";
import { doorPoint, type VenuePlan } from "@/lib/venue/plan";
import { moveTo, rectOf, resizeTo, walkwayRect, type Edges, type PlanTarget } from "@/lib/venue/plan-edit";
import { LayoutDrawing } from "@/components/venue/venue-floor-plan";
import { cn } from "@/lib/utils";

export type PlanTool = "select" | "walkway";

/**
 * A gesture in progress, for one pointer. `base` is read at the first move, not
 * at pointerdown: a size typed in the panel is applied when its field loses
 * focus, which happens after the pointerdown, so reading it then would drop it.
 */
type Drag = { pointer: number } & (
  | { mode: "move"; target: PlanTarget; from: [number, number]; base: VenuePlan | null; latest: VenuePlan | null }
  | { mode: "resize"; target: PlanTarget; edges: Edges; base: VenuePlan | null; latest: VenuePlan | null }
  | { mode: "draw"; from: [number, number]; rect: Rect | null }
);

const HANDLES: { edges: Edges; at: (r: Rect) => [number, number]; cursor: string }[] = [
  { edges: { w: true, n: true }, at: (r) => [r[0], r[1]], cursor: "cursor-nwse-resize" },
  { edges: { n: true }, at: (r) => [(r[0] + r[2]) / 2, r[1]], cursor: "cursor-ns-resize" },
  { edges: { e: true, n: true }, at: (r) => [r[2], r[1]], cursor: "cursor-nesw-resize" },
  { edges: { e: true }, at: (r) => [r[2], (r[1] + r[3]) / 2], cursor: "cursor-ew-resize" },
  { edges: { e: true, s: true }, at: (r) => [r[2], r[3]], cursor: "cursor-nwse-resize" },
  { edges: { s: true }, at: (r) => [(r[0] + r[2]) / 2, r[3]], cursor: "cursor-ns-resize" },
  { edges: { w: true, s: true }, at: (r) => [r[0], r[3]], cursor: "cursor-nesw-resize" },
  { edges: { w: true }, at: (r) => [r[0], (r[1] + r[3]) / 2], cursor: "cursor-ew-resize" },
];

/** Room around the building on the canvas, in metres, so there is floor to drag onto and draw on. */
const MARGIN = 8;

function viewOf(plan: VenuePlan): [number, number, number, number] {
  const rects = [...plan.rooms.map((p) => p.rect), ...plan.corridors.map((c) => c.rect)];
  if (!rects.length) return [-50, -50, 100, 100];
  const x0 = Math.min(...rects.map((r) => r[0])) - MARGIN;
  const z0 = Math.min(...rects.map((r) => r[1])) - MARGIN;
  const x1 = Math.max(...rects.map((r) => r[2])) + MARGIN;
  const z1 = Math.max(...rects.map((r) => r[3])) + MARGIN;
  return [x0, z0, x1 - x0, z1 - z0];
}

const sameRect = (a: Rect, b: Rect) => a.every((v, i) => v === b[i]);

export function VenuePlanCanvas({
  plan,
  layout,
  names,
  selected,
  tool,
  flagged,
  foyerId,
  onSelect,
  onLive,
  onCommit,
  onDrawn,
}: {
  plan: VenuePlan;
  layout: VenueLayout;
  names: Map<string, string>;
  selected: PlanTarget | null;
  tool: PlanTool;
  /** Areas to mark as wrong (overlapping another). */
  flagged: Set<string>;
  foyerId: string | null;
  onSelect: (t: PlanTarget | null) => void;
  onLive: (plan: VenuePlan | null) => void;
  onCommit: (plan: VenuePlan) => void;
  onDrawn: (rect: Rect) => void;
}) {
  const gridId = useId();
  const svgRef = useRef<SVGSVGElement>(null);
  const drag = useRef<Drag | null>(null);
  // The plan as last drawn, for a gesture to start from (see Drag).
  const latestPlan = useRef(plan);
  useEffect(() => {
    latestPlan.current = plan;
  }, [plan]);
  // The view stays put while a gesture runs, so the area under the pointer does not slide away as the building grows.
  const [frozen, setFrozen] = useState<[number, number, number, number] | null>(null);
  const [drawing, setDrawing] = useState<Rect | null>(null);
  const view = frozen ?? viewOf(plan);
  const handle = Math.max(0.6, view[2] / 110);

  const toPlan = (e: ReactPointerEvent): [number, number] | null => {
    const m = svgRef.current?.getScreenCTM();
    if (!m) return null;
    const p = new DOMPoint(e.clientX, e.clientY).matrixTransform(m.inverse());
    return [p.x, p.y];
  };

  /** Only the main button, and one gesture at a time: a second finger on a tablet is ignored. */
  const usable = (e: ReactPointerEvent) => e.button === 0 && drag.current === null;

  const begin = (e: ReactPointerEvent, d: Drag) => {
    drag.current = d;
    setFrozen(view);
    svgRef.current?.setPointerCapture(e.pointerId);
  };

  const startMove = (e: ReactPointerEvent, target: PlanTarget) => {
    e.stopPropagation();
    if (tool !== "select" || !usable(e)) return;
    const at = toPlan(e);
    if (!at) return;
    onSelect(target);
    begin(e, { pointer: e.pointerId, mode: "move", target, from: at, base: null, latest: null });
  };

  const startResize = (e: ReactPointerEvent, target: PlanTarget, edges: Edges) => {
    e.stopPropagation();
    if (!usable(e)) return;
    begin(e, { pointer: e.pointerId, mode: "resize", target, edges, base: null, latest: null });
  };

  const onBackground = (e: ReactPointerEvent) => {
    if (!usable(e)) return;
    if (tool === "select") {
      onSelect(null);
      return;
    }
    const at = toPlan(e);
    if (at) begin(e, { pointer: e.pointerId, mode: "draw", from: at, rect: null });
  };

  const onMove = (e: ReactPointerEvent) => {
    const d = drag.current;
    if (!d || e.pointerId !== d.pointer) return;
    const at = toPlan(e);
    if (!at) return;
    if (d.mode === "draw") {
      d.rect = walkwayRect(d.from[0], d.from[1], at[0], at[1]);
      setDrawing(d.rect);
      return;
    }
    d.base ??= latestPlan.current;
    const next = d.mode === "move" ? moveBy(d.base, d.target, at[0] - d.from[0], at[1] - d.from[1]) : resizeTo(d.base, d.target, d.edges, at[0], at[1], foyerId);
    d.latest = next;
    onLive(next);
  };

  const moveBy = (base: VenuePlan, target: PlanTarget, dx: number, dz: number) => {
    const r = rectOf(base, target);
    return r ? moveTo(base, target, r[0] + dx, r[1] + dz, foyerId) : base;
  };

  /** The gesture lands: on lifting the pointer, on a cancel, or when the browser takes the pointer away (the window lost focus). */
  const end = (e: ReactPointerEvent) => {
    const d = drag.current;
    if (!d || e.pointerId !== d.pointer) return;
    drag.current = null;
    setFrozen(null);
    if (d.mode === "draw") {
      setDrawing(null);
      if (d.rect) onDrawn(d.rect);
      return;
    }
    onLive(null);
    const before = d.base ? rectOf(d.base, d.target) : null;
    const after = d.latest ? rectOf(d.latest, d.target) : null;
    // A click without a real move is a selection, not an undo step.
    if (d.latest && before && after && !sameRect(before, after)) onCommit(d.latest);
  };

  const areas = [
    ...plan.corridors.map((c) => ({ target: { kind: "corridor", id: c.id } as PlanTarget, rect: c.rect, name: c.name })),
    ...plan.rooms.map((p) => ({ target: { kind: "room", id: p.id } as PlanTarget, rect: p.rect, name: names.get(p.id) ?? p.id })),
  ];
  const sel = selected ? areas.find((a) => a.target.kind === selected.kind && a.target.id === selected.id) : undefined;
  const foyer = foyerId ? plan.rooms.find((p) => p.id === foyerId) : undefined;

  return (
    // Drawn to the full width (never under 760 px, owner Oct 24: a tall building fitted to the height came out
    // about 260 px wide), its height following the plan's shape; a tall plan scrolls inside the frame.
    <div className="max-h-[80vh] overflow-auto rounded-md border">
      <svg
        ref={svgRef}
        viewBox={view.join(" ")}
        style={{ aspectRatio: `${view[2]} / ${view[3]}` }}
        className={cn("block w-full min-w-[760px] touch-none select-none bg-background", tool === "walkway" && "cursor-crosshair")}
        role="group"
        aria-label="Floor plan editor. Drag a room or walkway to move it; drag the handles of the selected one to resize it. Everything here can also be done from the panel beside the plan and the Add a walkway button."
        onPointerDown={onBackground}
        onPointerMove={onMove}
        onPointerUp={end}
        onPointerCancel={end}
        onLostPointerCapture={end}
      >
        <defs>
          <pattern id={gridId} width={5} height={5} patternUnits="userSpaceOnUse">
            <path d="M 5 0 L 0 0 0 5" className="fill-none stroke-border" strokeWidth={0.08} />
          </pattern>
        </defs>
        <rect x={view[0]} y={view[1]} width={view[2]} height={view[3]} fill={`url(#${gridId})`} />
        <LayoutDrawing layout={layout} />
        {areas.map((a) => {
          const isSel = sel?.target === a.target;
          const bad = flagged.has(a.target.id);
          return (
            <rect
              key={`${a.target.kind}:${a.target.id}`}
              x={a.rect[0]}
              y={a.rect[1]}
              width={a.rect[2] - a.rect[0]}
              height={a.rect[3] - a.rect[1]}
              className={cn(
                tool === "select" && "cursor-move",
                bad ? "fill-red-500/15 stroke-red-600" : "fill-transparent stroke-transparent",
                isSel && !bad && "stroke-primary",
                tool === "select" && !isSel && !bad && "hover:stroke-primary/50",
              )}
              strokeWidth={isSel ? 0.4 : 0.3}
              pointerEvents={tool === "select" ? "all" : "none"}
              onPointerDown={(e) => startMove(e, a.target)}
            >
              <title>{a.name}</title>
            </rect>
          );
        })}
        {plan.rooms.map((p) => {
          const [x, z] = doorPoint(p.rect, p.door);
          return <circle key={`d${p.id}`} cx={x} cy={z} r={handle * 0.55} className="pointer-events-none fill-amber-500" />;
        })}
        {foyer && <circle cx={doorPoint(foyer.rect, plan.entrance)[0]} cy={doorPoint(foyer.rect, plan.entrance)[1]} r={handle * 0.7} className="pointer-events-none fill-sky-500" />}
        {sel &&
          tool === "select" &&
          HANDLES.map((h, i) => {
            const [x, z] = h.at(sel.rect);
            return (
              <rect
                key={i}
                x={x - handle / 2}
                y={z - handle / 2}
                width={handle}
                height={handle}
                className={cn("fill-background stroke-primary", h.cursor)}
                strokeWidth={handle / 5}
                onPointerDown={(e) => startResize(e, sel.target, h.edges)}
              />
            );
          })}
        {drawing && (
          <rect
            x={drawing[0]}
            y={drawing[1]}
            width={drawing[2] - drawing[0]}
            height={drawing[3] - drawing[1]}
            className="pointer-events-none fill-stone-300/40 stroke-primary"
            strokeWidth={0.3}
            strokeDasharray="1 0.6"
          />
        )}
      </svg>
    </div>
  );
}
