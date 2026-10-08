"use client";

/**
 * The generated venue, drawn from above (docs/EVENT_BLUEPRINT_PLAN.md, D10):
 * the same layout the walkable venue is built from, generated in the browser
 * from the room list as it is edited, with the walkability check's verdict.
 * North is up; the entrance is at the bottom.
 */
import { useMemo } from "react";
import { CheckCircle2, AlertCircle } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { SectionHeading } from "@/components/ui/typography";
import { generateLayout, type LayoutItem, type ZoneKind } from "@/lib/venue/layout";
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

export function VenueFloorPlan({ rooms, eventName }: { rooms: VenueRoom[]; eventName: string }) {
  const { layout, check } = useMemo(() => {
    const l = generateLayout(rooms, { eventName });
    return { layout: l, check: checkLayout(l) };
  }, [rooms, eventName]);
  const [x0, z0, x1, z1] = layout.bounds;
  const pad = 3;
  const width = x1 - x0;
  const depth = z1 - z0;

  return (
    <section className="space-y-3">
      <SectionHeading
        title="Floor plan"
        description={`The building made from these rooms: ${Math.round(width)} m across and ${Math.round(depth)} m deep. North is up; the entrance is at the bottom.`}
      />
      <Card>
        <CardContent className="grid gap-4 p-5 lg:grid-cols-[minmax(0,1fr)_16rem]">
          <svg
            viewBox={`${x0 - pad} ${z0 - pad} ${width + pad * 2} ${depth + pad * 2 + 4}`}
            className="max-h-[42rem] w-full"
            role="img"
            aria-label={`Floor plan with ${layout.zones.length} areas`}
          >
            {layout.zones.map((z) => (
              <rect key={z.id} x={z.rect[0]} y={z.rect[1]} width={z.rect[2] - z.rect[0]} height={z.rect[3] - z.rect[1]} className={ZONE_FILL[z.kind]} />
            ))}
            {layout.items.map((it, i) => (
              <Item key={i} it={it} />
            ))}
            {layout.walls.map((w, i) => {
              const segs: [number, number][] = [];
              let cur = w.a0;
              for (const o of [...w.opens].sort((p, q) => p.a - q.a)) {
                if (o.glass) continue;
                if (o.a > cur) segs.push([cur, o.a]);
                cur = o.b;
              }
              if (cur < w.a1) segs.push([cur, w.a1]);
              return segs.map(([a, b], j) =>
                w.axis === "x" ? (
                  <line key={`${i}-${j}`} x1={a} y1={w.k} x2={b} y2={w.k} className="stroke-stone-700 dark:stroke-stone-300" strokeWidth={0.35} />
                ) : (
                  <line key={`${i}-${j}`} x1={w.k} y1={a} x2={w.k} y2={b} className="stroke-stone-700 dark:stroke-stone-300" strokeWidth={0.35} />
                ),
              );
            })}
            {layout.walls
              .flatMap((w) => w.opens.filter((o) => o.glass).map((o) => ({ w, o })))
              .map(({ w, o }, i) => (
                <line key={`g${i}`} x1={o.a} y1={w.k} x2={o.b} y2={w.k} className="stroke-sky-400" strokeWidth={0.35} strokeDasharray="0.8 0.5" />
              ))}
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
                    className="fill-foreground font-medium"
                    paintOrder="stroke"
                    stroke="var(--background)"
                    strokeWidth={size * 0.35}
                  >
                    {z.name}
                  </text>
                );
              })}
            <text x={(x0 + x1) / 2} y={z1 + 3.2} textAnchor="middle" fontSize={1.6} className="fill-muted-foreground">
              ↑ Entrance
            </text>
          </svg>
          <div className="space-y-4 text-sm">
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
