"use client";

/**
 * The venue drawn from above: the same layout the walkable venue is built
 * from (the drawn plan when there is one that fits, else the automatic one,
 * docs/VENUE_FLOOR_PLAN_EDITOR_PLAN.md), built in the browser from the room
 * list as it is edited, with the walkability check's verdict. North is up.
 */
import { useMemo, type ReactNode } from "react";
import { CheckCircle2, AlertCircle } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { SectionHeading } from "@/components/ui/typography";
import type { LayoutItem, LayoutWall, VenueLayout, ZoneKind } from "@/lib/venue/layout";
import { buildVenueLayout } from "@/lib/venue/plan-layout";
import type { VenuePlan } from "@/lib/venue/plan";
import { checkLayout } from "@/lib/venue/layout-check";
import type { VenueRoom } from "@/lib/venue/rooms";
import { cn } from "@/lib/utils";

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

/** Seats an item holds, for the plan's count. */
function seatsOf(it: LayoutItem): number {
  if (it.t === "row") return it.n;
  if (it.t === "round") return it.chairs;
  return 0;
}

function Item({ it }: { it: LayoutItem }) {
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

/** A line along a wall, from a to b on its own axis. */
function WallLine({ w, a, b, className, dash }: { w: LayoutWall; a: number; b: number; className: string; dash?: string }) {
  if (w.axis === "x") return <line x1={a} y1={w.k} x2={b} y2={w.k} className={className} strokeWidth={0.35} strokeDasharray={dash} />;
  return <line x1={w.k} y1={a} x2={w.k} y2={b} className={className} strokeWidth={0.35} strokeDasharray={dash} />;
}

/** A wall's solid pieces: everything but its openings. */
function solidPieces(w: LayoutWall): [number, number][] {
  const segs: [number, number][] = [];
  let cur = w.a0;
  for (const o of [...w.opens].sort((p, q) => p.a - q.a)) {
    if (o.glass) continue;
    if (o.a > cur) segs.push([cur, o.a]);
    cur = o.b;
  }
  if (cur < w.a1) segs.push([cur, w.a1]);
  return segs;
}

/** The building drawn from above: floors, furniture, walls with their openings, the glass entrance and room names. Shared by the plan view and the editor. */
export function LayoutDrawing({ layout }: { layout: VenueLayout }) {
  return (
    <g>
      {layout.zones.map((z) => (
        <rect key={z.id} x={z.rect[0]} y={z.rect[1]} width={z.rect[2] - z.rect[0]} height={z.rect[3] - z.rect[1]} className={ZONE_FILL[z.kind]} />
      ))}
      {layout.items.map((it, i) => (
        <Item key={i} it={it} />
      ))}
      {layout.walls.map((w, i) =>
        solidPieces(w).map(([a, b], j) => <WallLine key={`${i}-${j}`} w={w} a={a} b={b} className="stroke-stone-700 dark:stroke-stone-300" />),
      )}
      {layout.walls.map((w, i) =>
        w.opens.filter((o) => o.glass).map((o, j) => <WallLine key={`g${i}-${j}`} w={w} a={o.a} b={o.b} className="stroke-sky-400" dash="0.8 0.5" />),
      )}
      {layout.zones
        .filter((z) => z.kind !== "corridor")
        .map((z) => {
          const w = z.rect[2] - z.rect[0];
          const size = Math.max(1.1, Math.min(2.2, w / 9));
          return (
            <text
              key={`t${z.id}`}
              x={(z.rect[0] + z.rect[2]) / 2}
              y={(z.rect[1] + z.rect[3]) / 2}
              textAnchor="middle"
              dominantBaseline="middle"
              fontSize={size}
              className="pointer-events-none fill-foreground font-medium"
              paintOrder="stroke"
              stroke="var(--background)"
              strokeWidth={size * 0.35}
            >
              {z.name}
            </text>
          );
        })}
    </g>
  );
}

export function VenueFloorPlan({ rooms, eventName, actions, plan = null }: { rooms: VenueRoom[]; eventName: string; actions?: ReactNode; plan?: VenuePlan | null }) {
  // The saved drawn plan when it still fits these rooms, else the automatic one: what the venue and the PDF use.
  const { layout, check, mode, notUsed } = useMemo(() => {
    const built = buildVenueLayout(rooms, plan, { eventName });
    return { layout: built.layout, check: checkLayout(built.layout), mode: built.mode, notUsed: built.planIssues };
  }, [rooms, eventName, plan]);
  const [x0, z0, x1, z1] = layout.bounds;
  const pad = 3;
  const width = x1 - x0;
  const depth = z1 - z0;

  return (
    <section className="space-y-3">
      <SectionHeading
        title="Floor plan"
        description={`${mode === "drawn" ? "The plan drawn for this event" : "The building made from these rooms"}: ${Math.round(width)} m across and ${Math.round(depth)} m deep. North is up; the blue dashed line is the entrance.`}
        actions={actions}
      />
      <Card>
        <CardContent className="grid gap-4 p-5 lg:grid-cols-[minmax(0,1fr)_16rem]">
          <svg
            viewBox={`${x0 - pad} ${z0 - pad} ${width + pad * 2} ${depth + pad * 2}`}
            className="max-h-[42rem] w-full"
            role="img"
            aria-label={`Floor plan with ${layout.zones.length} areas`}
          >
            <LayoutDrawing layout={layout} />
          </svg>
          <div className="space-y-4 text-sm">
            {notUsed.length > 0 && (
              <div role="status" className="space-y-1 rounded-md border border-amber-300 bg-amber-50 p-3 text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-200">
                <p className="font-medium">The drawn plan is not used, so this is the automatic one.</p>
                <ul className="list-disc space-y-0.5 pl-4">
                  {notUsed.map((m) => (
                    <li key={m}>{m}</li>
                  ))}
                </ul>
                <p>Edit the floor plan to fix it.</p>
              </div>
            )}
            <div className={cn("flex gap-2", check.ok ? "text-emerald-700 dark:text-emerald-400" : "text-amber-700 dark:text-amber-400")}>
              {check.ok ? <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" aria-hidden /> : <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />}
              <p>{check.ok ? "Walkable: every room, doorway, stand and desk can be reached from the entrance." : "Not walkable yet:"}</p>
            </div>
            {!check.ok && (
              <ul className="list-disc space-y-0.5 pl-5 text-muted-foreground">
                {check.issues.map((m) => (
                  <li key={m}>{m}</li>
                ))}
              </ul>
            )}
            <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-muted-foreground">
              <dt>Seats drawn</dt>
              <dd className="tabular-nums text-foreground">{layout.items.reduce((n, it) => n + seatsOf(it), 0).toLocaleString("en-GB")}</dd>
              <dt>Stands</dt>
              <dd className="tabular-nums text-foreground">{layout.items.filter((it) => it.t === "stand").length}</dd>
              <dt>Poster boards</dt>
              <dd className="tabular-nums text-foreground">{layout.items.filter((it) => it.t === "poster").length}</dd>
            </dl>
            <p className="text-xs text-muted-foreground">
              Very large rooms show up to 420 seats; the room is still sized for everyone it holds. Stands show the event&apos;s sponsors once the venue is built.
            </p>
          </div>
        </CardContent>
      </Card>
    </section>
  );
}
