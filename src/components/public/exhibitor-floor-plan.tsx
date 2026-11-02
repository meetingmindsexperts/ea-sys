"use client";

/**
 * The exhibitor floor plan's view (docs/VENUE_FLOOR_PLAN_EDITOR_PLAN.md section 10): a sponsor finds their name,
 * the plan moves to their stand and rings it. Built for a phone first: the search sits above the plan, the plan
 * pans with a finger and zooms with two (or the buttons), and every stand keeps the number the team gave it.
 */
import { useMemo, useRef, useState, type PointerEvent as ReactPointerEvent, type WheelEvent as ReactWheelEvent } from "react";
import { FileDown, Minus, Plus, RotateCcw, Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { LayoutDrawing } from "@/components/venue/venue-plan-drawing";
import { EventBannerBand } from "@/components/public/event-banner";
import type { Rect, VenueLayout } from "@/lib/venue/layout";
import { layoutStands, standNumber, standSponsor, type StandItem, type StandSponsorRef } from "@/lib/venue/stands";
import { cn } from "@/lib/utils";

export interface FloorPlanPayload {
  event: { name: string; startDate: string; endDate: string; timezone: string; bannerImage: string | null; bannerImageMobile: string | null; organizationName: string; venue: string | null; city: string | null };
  updatedAt: string;
  layout: Pick<VenueLayout, "zones" | "walls" | "doors" | "items" | "bounds" | "levels">;
  sponsors: StandSponsorRef[];
  drawings: { floor: string; src: string; rect: Rect; opacity: number }[];
}

type View = { x: number; y: number; w: number; h: number };

const keyOf = (s: StandItem) => s.key ?? `stand-${s.n}`;
const boxOf = (s: StandItem): Rect => {
  const f = s.foot as { x0: number; z0: number; x1: number; z1: number };
  return [f.x0, f.z0, f.x1, f.z1];
};

function dateLine(start: string, end: string, timeZone: string): string {
  const fmt = (d: string) => new Intl.DateTimeFormat("en-GB", { timeZone, day: "numeric", month: "long", year: "numeric" }).format(new Date(d));
  const a = fmt(start);
  const b = fmt(end);
  return a === b ? a : `${a} to ${b}`;
}

/** The whole floor, with a margin, as the starting view. */
function fitView([x0, z0, x1, z1]: Rect): View {
  const pad = 3;
  return { x: x0 - pad, y: z0 - pad, w: x1 - x0 + pad * 2, h: z1 - z0 + pad * 2 };
}

export function ExhibitorFloorPlan({ data, pdfBase }: { data: FloorPlanPayload; pdfBase: string }) {
  const layout: VenueLayout = useMemo(() => ({ v: 1, people: [], hotspots: [], routes: [], ...data.layout }), [data.layout]);
  const levels = layout.levels;
  const [floor, setFloor] = useState(levels?.[0]?.id ?? "");
  const [query, setQuery] = useState("");
  const [picked, setPicked] = useState<string | null>(null);
  const floorBounds = (levels?.find((l) => l.id === floor)?.bounds ?? layout.bounds) as Rect;
  const [view, setView] = useState<View>(() => fitView(floorBounds));

  // Each stand with its sponsor and floor; a sponsor with several stands appears once per stand.
  const stands = useMemo(() => {
    const levelOf = new Map(layout.zones.map((z) => [z.id, z.level ?? ""]));
    return layoutStands(layout).map((s) => ({ s, key: keyOf(s), number: standNumber(s), sponsor: standSponsor(s, data.sponsors), floor: levelOf.get(s.zone) ?? "" }));
  }, [layout, data.sponsors]);
  const taken = stands.filter((x) => x.sponsor).sort((a, b) => a.sponsor!.name.localeCompare(b.sponsor!.name) || a.number.localeCompare(b.number, "en", { numeric: true }));
  const available = stands.length - taken.length;
  const q = query.trim().toLowerCase();
  const shown = q ? taken.filter((x) => x.sponsor!.name.toLowerCase().includes(q) || x.number.toLowerCase() === q.replace(/^stand\s*/, "")) : taken;
  const chosen = stands.find((x) => x.key === picked) ?? null;

  const pick = (key: string) => {
    const x = stands.find((st) => st.key === key);
    if (!x) return;
    setPicked(key);
    if (levels && x.floor && x.floor !== floor) setFloor(x.floor);
    // Close in on the stand: about six of its own widths across, at least 20 m.
    const [x0, z0, x1, z1] = boxOf(x.s);
    const span = Math.max(20, (x1 - x0) * 6, (z1 - z0) * 6);
    const base = fitView((levels?.find((l) => l.id === (x.floor || floor))?.bounds ?? layout.bounds) as Rect);
    const ratio = base.h / base.w;
    setView({ x: (x0 + x1) / 2 - span / 2, y: (z0 + z1) / 2 - (span * ratio) / 2, w: span, h: span * ratio });
    document.getElementById("exhibitor-plan")?.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  const changeFloor = (id: string) => {
    setFloor(id);
    setView(fitView((levels?.find((l) => l.id === id)?.bounds ?? layout.bounds) as Rect));
  };

  const drawing = data.drawings.find((d) => d.floor === (floor || "ground"));
  const place = [data.event.venue, data.event.city].filter(Boolean).join(", ");

  return (
    <main className="min-h-screen bg-slate-50 text-slate-900">
      <header className="border-b bg-white">
        <EventBannerBand banner={data.event.bannerImage} bannerMobile={data.event.bannerImageMobile} name={data.event.name} />
        <div className="mx-auto max-w-5xl space-y-1 px-4 py-4">
          <p className="text-xs font-semibold uppercase tracking-wide text-sky-700">Floor plan for exhibitors</p>
          <h1 className="text-xl font-semibold tracking-tight text-balance sm:text-2xl">{data.event.name}</h1>
          <p className="text-sm text-slate-600">
            {dateLine(data.event.startDate, data.event.endDate, data.event.timezone)}
            {place ? ` · ${place}` : ""}
          </p>
          <p className="text-xs text-slate-500">
            Updated {new Date(data.updatedAt).toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" })}. Stand numbers can change, so check here before you travel.
          </p>
        </div>
      </header>

      <div className="mx-auto grid max-w-5xl gap-4 px-4 py-4 lg:grid-cols-[minmax(0,1fr)_18rem]">
        <section aria-label="Find your stand" className="space-y-3 lg:order-2">
          <div className="relative">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" aria-hidden />
            <Input
              id="exhibitor-search"
              name="exhibitor-search"
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search your company or stand number"
              aria-label="Search your company or stand number"
              className="h-11 bg-white pl-9 text-base"
            />
          </div>
          <ul className="max-h-60 divide-y overflow-y-auto rounded-lg border bg-white lg:max-h-[34rem]" aria-label="Exhibitors">
            {shown.map((x) => (
              <li key={x.key}>
                <button
                  type="button"
                  onClick={() => pick(x.key)}
                  className={cn("flex w-full items-center justify-between gap-3 px-3 py-2.5 text-left text-sm hover:bg-sky-50 focus-visible:bg-sky-50 focus-visible:outline-none", picked === x.key && "bg-sky-50")}
                  aria-current={picked === x.key ? "true" : undefined}
                >
                  <span className="min-w-0 truncate font-medium">{x.sponsor!.name}</span>
                  <span className="shrink-0 tabular-nums text-slate-600">Stand {x.number}</span>
                </button>
              </li>
            ))}
            {shown.length === 0 && <li className="px-3 py-3 text-sm text-slate-500">{q ? "No exhibitor matches that. Try part of the name." : "No exhibitors are listed yet."}</li>}
          </ul>
          <p className="text-xs text-slate-500">
            {taken.length} {taken.length === 1 ? "exhibitor" : "exhibitors"}
            {available > 0 ? `, ${available} ${available === 1 ? "stand" : "stands"} available` : ""}. Tap a name to see the stand.
          </p>
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" size="sm" asChild>
              <a href={`${pdfBase}?paper=A4`}>
                <FileDown className="h-4 w-4" aria-hidden />
                PDF (A4)
              </a>
            </Button>
            <Button variant="outline" size="sm" asChild>
              <a href={`${pdfBase}?paper=A3`}>
                <FileDown className="h-4 w-4" aria-hidden />
                PDF (A3)
              </a>
            </Button>
          </div>
        </section>

        <section id="exhibitor-plan" aria-label="Floor plan" className="scroll-mt-4 space-y-2 lg:order-1">
          {levels && levels.length > 1 && (
            <div role="tablist" aria-label="Floors" className="flex gap-1 rounded-lg border bg-white p-1">
              {levels.map((l) => (
                <button
                  key={l.id}
                  type="button"
                  role="tab"
                  aria-selected={floor === l.id}
                  onClick={() => changeFloor(l.id)}
                  className={cn("flex-1 rounded-md px-3 py-2 text-sm font-medium", floor === l.id ? "bg-sky-600 text-white" : "text-slate-700 hover:bg-slate-100")}
                >
                  {l.name}
                </button>
              ))}
            </div>
          )}
          {chosen?.sponsor && (
            <p role="status" className="rounded-md bg-sky-50 px-3 py-2 text-sm text-sky-900">
              <span className="font-semibold">{chosen.sponsor.name}</span> is on stand {chosen.number}, ringed on the plan.
            </p>
          )}
          <PlanViewer view={view} onView={setView} home={fitView(floorBounds)}>
            <LayoutDrawing layout={layout} sponsors={data.sponsors} faintLabels />
            {drawing && (
              <image
                href={drawing.src}
                x={drawing.rect[0]}
                y={drawing.rect[1]}
                width={drawing.rect[2] - drawing.rect[0]}
                height={drawing.rect[3] - drawing.rect[1]}
                opacity={drawing.opacity}
                preserveAspectRatio="none"
                style={{ mixBlendMode: "multiply", pointerEvents: "none" }}
              />
            )}
            {chosen && <Ring box={boxOf(chosen.s)} />}
          </PlanViewer>
          <p className="text-xs text-slate-500">North is up. Drag to move the plan; pinch or use the buttons to zoom.</p>
        </section>
      </div>
    </main>
  );
}

/** The ring round the chosen stand: steady, with a soft pulse for those who allow motion. */
function Ring({ box: [x0, z0, x1, z1] }: { box: Rect }) {
  const pad = 0.6;
  return (
    <g pointerEvents="none">
      <rect x={x0 - pad} y={z0 - pad} width={x1 - x0 + pad * 2} height={z1 - z0 + pad * 2} rx={0.6} className="fill-none stroke-sky-600" strokeWidth={0.4} />
      <rect x={x0 - pad * 2} y={z0 - pad * 2} width={x1 - x0 + pad * 4} height={z1 - z0 + pad * 4} rx={1} className="fill-none stroke-sky-500 motion-safe:animate-pulse" strokeWidth={0.25} />
    </g>
  );
}

/**
 * The plan in a frame that pans and zooms: drag with a mouse or a finger, pinch with two fingers, the wheel, or the
 * buttons. The view is a viewBox, so the drawing stays sharp at any zoom.
 */
function PlanViewer({ view, onView, home, children }: { view: View; onView: (v: View) => void; home: View; children: React.ReactNode }) {
  const ref = useRef<SVGSVGElement>(null);
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const pinch = useRef<{ d: number; view: View } | null>(null);
  const perPx = () => view.w / (ref.current?.clientWidth || 1);

  const zoom = (factor: number, at?: { x: number; y: number }) => {
    const w = Math.min(home.w * 1.5, Math.max(8, view.w * factor));
    const h = (w / view.w) * view.h;
    const cx = at ? at.x : view.x + view.w / 2;
    const cy = at ? at.y : view.y + view.h / 2;
    onView({ x: cx - ((cx - view.x) / view.w) * w, y: cy - ((cy - view.y) / view.h) * h, w, h });
  };
  const toPlan = (clientX: number, clientY: number) => {
    const r = ref.current!.getBoundingClientRect();
    return { x: view.x + ((clientX - r.left) / r.width) * view.w, y: view.y + ((clientY - r.top) / r.height) * view.h };
  };

  const onDown = (e: ReactPointerEvent<SVGSVGElement>) => {
    ref.current?.setPointerCapture(e.pointerId);
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.current.size === 2) {
      const [a, b] = [...pointers.current.values()];
      pinch.current = { d: Math.hypot(a.x - b.x, a.y - b.y), view };
    }
  };
  const onMove = (e: ReactPointerEvent<SVGSVGElement>) => {
    const prev = pointers.current.get(e.pointerId);
    if (!prev) return;
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.current.size === 2 && pinch.current) {
      const [a, b] = [...pointers.current.values()];
      const d = Math.hypot(a.x - b.x, a.y - b.y);
      const base = pinch.current.view;
      const w = Math.min(home.w * 1.5, Math.max(8, (base.w * pinch.current.d) / Math.max(d, 1)));
      const h = (w / base.w) * base.h;
      onView({ x: base.x + (base.w - w) / 2, y: base.y + (base.h - h) / 2, w, h });
      return;
    }
    const k = perPx();
    onView({ ...view, x: view.x - (e.clientX - prev.x) * k, y: view.y - (e.clientY - prev.y) * k });
  };
  const onUp = (e: ReactPointerEvent<SVGSVGElement>) => {
    pointers.current.delete(e.pointerId);
    if (pointers.current.size < 2) pinch.current = null;
  };
  const onWheel = (e: ReactWheelEvent<SVGSVGElement>) => zoom(e.deltaY > 0 ? 1.15 : 1 / 1.15, toPlan(e.clientX, e.clientY));

  return (
    <div className="relative overflow-hidden rounded-lg border bg-white">
      <svg
        ref={ref}
        viewBox={`${view.x} ${view.y} ${view.w} ${view.h}`}
        className="h-[60vh] max-h-[40rem] min-h-[22rem] w-full cursor-grab touch-none select-none active:cursor-grabbing"
        role="img"
        aria-label="Floor plan of the venue with every stand and its number"
        onPointerDown={onDown}
        onPointerMove={onMove}
        onPointerUp={onUp}
        onPointerCancel={onUp}
        onWheel={onWheel}
      >
        {children}
      </svg>
      <div className="absolute right-2 top-2 flex flex-col gap-1">
        <Button type="button" size="icon" variant="secondary" className="h-9 w-9 shadow" aria-label="Zoom in" onClick={() => zoom(1 / 1.4)}>
          <Plus className="h-4 w-4" aria-hidden />
        </Button>
        <Button type="button" size="icon" variant="secondary" className="h-9 w-9 shadow" aria-label="Zoom out" onClick={() => zoom(1.4)}>
          <Minus className="h-4 w-4" aria-hidden />
        </Button>
        <Button type="button" size="icon" variant="secondary" className="h-9 w-9 shadow" aria-label="Show the whole floor" onClick={() => onView(home)}>
          <RotateCcw className="h-4 w-4" aria-hidden />
        </Button>
      </div>
    </div>
  );
}
