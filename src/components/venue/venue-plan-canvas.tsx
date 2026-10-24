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
 *
 * Phase 2: a dragged edge lines up with other areas' edges (the guide lines
 * show where; hold Alt to place freely). Ctrl or Cmd with the scroll wheel
 * zooms about the pointer; the plain wheel scrolls the frame, and Space with a
 * drag (or the middle button) pans it.
 */
import { useEffect, useId, useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import type { Rect, VenueLayout } from "@/lib/venue/layout";
import { FIXTURE_INFO, doorPoint, type VenuePlan } from "@/lib/venue/plan";
import { moveSnapped, moveTo, rectOf, resizeSnapped, resizeTo, walkwayRect, type Edges, type PlanTarget, type SnapGuides } from "@/lib/venue/plan-edit";
import { LayoutDrawing } from "@/components/venue/venue-plan-drawing";
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
  | { mode: "pan"; from: [number, number]; scroll: [number, number] }
);

/** The zoom steps, as multiples of the frame's width. */
export const PLAN_ZOOMS = [1, 1.5, 2, 3, 4] as const;
/** The next zoom step in (+1) or out (-1). */
export function stepZoom(zoom: number, dir: 1 | -1): number {
  const i = PLAN_ZOOMS.findIndex((z) => z >= zoom - 0.001);
  const at = i < 0 ? PLAN_ZOOMS.length - 1 : i;
  return PLAN_ZOOMS[Math.max(0, Math.min(PLAN_ZOOMS.length - 1, at + dir))];
}

const NO_GUIDES: SnapGuides = { x: [], z: [] };
/** A mouse wheel notch, in deltaY: the wheel zooms one step per notch, a pinch per notch's worth. */
const WHEEL_STEP = 100;
/** Space pans only when nothing focused would use it: a focused button or field keeps Space for itself. */
const spaceIsFree = (el: EventTarget | null) => !(el instanceof HTMLElement) || el === document.body;

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
  zoom,
  onZoom,
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
  /** How many times the frame's width the plan is drawn (PLAN_ZOOMS). */
  zoom: number;
  onZoom: (zoom: number) => void;
}) {
  const gridId = useId();
  const svgRef = useRef<SVGSVGElement>(null);
  const frameRef = useRef<HTMLDivElement>(null);
  const [guides, setGuides] = useState<SnapGuides>(NO_GUIDES);
  // Space held: a drag pans instead of editing.
  const [space, setSpace] = useState(false);
  // Where the pointer was, as a share of the plan, when the wheel zoomed: kept under the pointer after the redraw.
  const anchor = useRef<{ fx: number; fy: number; cx: number; cy: number } | null>(null);
  // Where the middle of the frame is, as a share of the plan: the zoom buttons keep it in the middle.
  const centre = useRef<{ fx: number; fy: number }>({ fx: 0.5, fy: 0 });
  const overFrame = useRef(false);
  // A trackpad pinch sends dozens of small wheel events: they add up to one step per notch's worth.
  const wheelSum = useRef(0);
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
  // Handles and door dots keep their size on screen at any zoom.
  const handle = Math.max(0.6, view[2] / 110) / zoom;

  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      // Only over the plan: elsewhere Space keeps scrolling the page.
      if (e.code !== "Space" || !spaceIsFree(e.target) || !overFrame.current) return;
      e.preventDefault();
      setSpace(true);
    };
    const up = (e: KeyboardEvent) => {
      if (e.code === "Space") setSpace(false);
    };
    const blur = () => setSpace(false);
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    window.addEventListener("blur", blur);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
      window.removeEventListener("blur", blur);
    };
  }, []);

  // Ctrl or Cmd + wheel zooms. A native listener, because React's wheel listener is passive and cannot stop the page zooming.
  const zoomRef = useRef(zoom);
  useEffect(() => {
    zoomRef.current = zoom;
  }, [zoom]);
  useEffect(() => {
    const frame = frameRef.current;
    if (!frame) return;
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      wheelSum.current += e.deltaY;
      if (Math.abs(wheelSum.current) < WHEEL_STEP) return;
      const next = stepZoom(zoomRef.current, wheelSum.current < 0 ? 1 : -1);
      wheelSum.current = 0;
      if (next === zoomRef.current) return;
      // Set now, not after the redraw: a wheel event before the effect runs must step from here.
      zoomRef.current = next;
      const box = frame.getBoundingClientRect();
      const cx = e.clientX - box.left;
      const cy = e.clientY - box.top;
      anchor.current = { fx: (frame.scrollLeft + cx) / frame.scrollWidth, fy: (frame.scrollTop + cy) / frame.scrollHeight, cx, cy };
      onZoom(next);
    };
    frame.addEventListener("wheel", onWheel, { passive: false });
    return () => frame.removeEventListener("wheel", onWheel);
  }, [onZoom]);
  useLayoutEffect(() => {
    const frame = frameRef.current;
    if (!frame) return;
    // The wheel's point stays under the pointer; a button keeps the middle in the middle.
    const half = { cx: frame.clientWidth / 2, cy: frame.clientHeight / 2 };
    const a = anchor.current ?? { ...centre.current, ...half };
    anchor.current = null;
    frame.scrollLeft = a.fx * frame.scrollWidth - a.cx;
    frame.scrollTop = a.fy * frame.scrollHeight - a.cy;
  }, [zoom]);

  const onScroll = () => {
    const f = frameRef.current;
    if (!f) return;
    centre.current = { fx: (f.scrollLeft + f.clientWidth / 2) / f.scrollWidth, fy: (f.scrollTop + f.clientHeight / 2) / f.scrollHeight };
  };

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

  /** Space with a drag, or the middle button: pan the frame, before any area sees the pointer. */
  const onPanStart = (e: ReactPointerEvent) => {
    if (!(space && e.button === 0) && e.button !== 1) return;
    if (drag.current !== null || !frameRef.current) return;
    e.preventDefault();
    e.stopPropagation();
    drag.current = { pointer: e.pointerId, mode: "pan", from: [e.clientX, e.clientY], scroll: [frameRef.current.scrollLeft, frameRef.current.scrollTop] };
    svgRef.current?.setPointerCapture(e.pointerId);
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
    if (d.mode === "pan") {
      const frame = frameRef.current;
      if (!frame) return;
      frame.scrollLeft = d.scroll[0] - (e.clientX - d.from[0]);
      frame.scrollTop = d.scroll[1] - (e.clientY - d.from[1]);
      return;
    }
    const at = toPlan(e);
    if (!at) return;
    if (d.mode === "draw") {
      d.rect = walkwayRect(d.from[0], d.from[1], at[0], at[1]);
      setDrawing(d.rect);
      return;
    }
    d.base ??= latestPlan.current;
    const r = rectOf(d.base, d.target);
    if (!r) return;
    const placed = place(d, d.base, r, at, e.altKey);
    d.latest = placed.plan;
    setGuides(placed.guides);
    onLive(placed.plan);
  };

  /** Where a move or resize lands: lined up with other areas' edges, or (Alt held) on the grid alone. */
  const place = (d: Extract<Drag, { mode: "move" | "resize" }>, base: VenuePlan, r: Rect, at: [number, number], free: boolean) => {
    if (d.mode === "move") {
      const x0 = r[0] + at[0] - d.from[0];
      const z0 = r[1] + at[1] - d.from[1];
      return free ? { plan: moveTo(base, d.target, x0, z0, foyerId), guides: NO_GUIDES } : moveSnapped(base, d.target, x0, z0, foyerId);
    }
    return free ? { plan: resizeTo(base, d.target, d.edges, at[0], at[1], foyerId), guides: NO_GUIDES } : resizeSnapped(base, d.target, d.edges, at[0], at[1], foyerId);
  };

  /** The gesture lands: on lifting the pointer, on a cancel, or when the browser takes the pointer away (the window lost focus). */
  const end = (e: ReactPointerEvent) => {
    const d = drag.current;
    if (!d || e.pointerId !== d.pointer) return;
    drag.current = null;
    setFrozen(null);
    setGuides(NO_GUIDES);
    if (d.mode === "pan") return;
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
    // Last, so a fixture is on top of the room it stands in and takes the click.
    ...plan.fixtures.map((f) => ({ target: { kind: "fixture", id: f.id } as PlanTarget, rect: f.rect, name: f.name || FIXTURE_INFO[f.kind].label })),
  ];
  const sel = selected ? areas.find((a) => a.target.kind === selected.kind && a.target.id === selected.id) : undefined;
  const foyer = foyerId ? plan.rooms.find((p) => p.id === foyerId) : undefined;

  return (
    // Drawn to the full width (never under 760 px, owner Oct 24: a tall building fitted to the height came out
    // about 260 px wide), its height following the plan's shape; a tall plan scrolls inside the frame.
    // Zoomed, it is that many times as wide and the frame scrolls both ways.
    <div
      ref={frameRef}
      className="max-h-[80vh] overflow-auto rounded-md border"
      onScroll={onScroll}
      onPointerEnter={() => {
        overFrame.current = true;
      }}
      onPointerLeave={() => {
        overFrame.current = false;
      }}
    >
      <svg
        ref={svgRef}
        viewBox={view.join(" ")}
        style={{ aspectRatio: `${view[2]} / ${view[3]}`, width: `${zoom * 100}%`, minWidth: `${760 * zoom}px` }}
        className={cn("block touch-none select-none bg-background", tool === "walkway" && "cursor-crosshair", space && "cursor-grab")}
        role="group"
        aria-label="Floor plan editor. Drag a room or walkway to move it; drag the handles of the selected one to resize it. Everything here can also be done from the panel beside the plan and the Add a walkway button."
        onPointerDownCapture={onPanStart}
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
            // On a small fixture (a 0.8 m pillar) the handles shrink, so its middle stays free to grab and drag.
            const size = Math.min(handle, Math.min(sel.rect[2] - sel.rect[0], sel.rect[3] - sel.rect[1]) / 3);
            return (
              <rect
                key={i}
                x={x - size / 2}
                y={z - size / 2}
                width={size}
                height={size}
                className={cn("fill-background stroke-primary", h.cursor)}
                strokeWidth={size / 5}
                onPointerDown={(e) => startResize(e, sel.target, h.edges)}
              />
            );
          })}
        {guides.x.map((x) => (
          <line key={`gx${x}`} x1={x} y1={view[1]} x2={x} y2={view[1] + view[3]} className="pointer-events-none stroke-fuchsia-500" strokeWidth={handle / 4} strokeDasharray={`${handle} ${handle / 2}`} />
        ))}
        {guides.z.map((z) => (
          <line key={`gz${z}`} x1={view[0]} y1={z} x2={view[0] + view[2]} y2={z} className="pointer-events-none stroke-fuchsia-500" strokeWidth={handle / 4} strokeDasharray={`${handle} ${handle / 2}`} />
        ))}
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
