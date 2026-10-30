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
import type { LayoutItem, VenueLayout } from "@/lib/venue/layout";
import { LayoutDrawing } from "@/components/venue/venue-plan-drawing";
import { buildVenueLayout } from "@/lib/venue/plan-layout";
import type { VenuePlan } from "@/lib/venue/plan";
import type { StandSponsorRef } from "@/lib/venue/stands";
import { checkLayout } from "@/lib/venue/layout-check";
import type { VenueRoom } from "@/lib/venue/rooms";
import { cn } from "@/lib/utils";

/** Seats an item holds, for the plan's count. */
function seatsOf(it: LayoutItem): number {
  if (it.t === "row") return it.n;
  if (it.t === "round") return it.chairs;
  return 0;
}

function planSummary(layout: VenueLayout, mode: "automatic" | "drawn", width: number, depth: number): string {
  const floors = layout.levels?.map((l) => l.name);
  if (floors) return `The plan drawn for this event, on ${floors.length} floors: ${floors.join(" and ")}, side by side. North is up; the blue dashed line is the entrance.`;
  return `${mode === "drawn" ? "The plan drawn for this event" : "The building made from these rooms"}: ${Math.round(width)} m across and ${Math.round(depth)} m deep. North is up; the blue dashed line is the entrance.`;
}

export function VenueFloorPlan({
  rooms,
  eventName,
  actions,
  plan = null,
  sponsors = [],
}: {
  rooms: VenueRoom[];
  eventName: string;
  actions?: ReactNode;
  plan?: VenuePlan | null;
  /** The event's sponsors in stand order, to name each stand. */
  sponsors?: StandSponsorRef[];
}) {
  // The saved drawn plan when it still fits these rooms, else the automatic one: what the venue and the PDF use.
  const { layout, check, mode, notUsed } = useMemo(() => {
    const built = buildVenueLayout(rooms, plan, { eventName });
    return { layout: built.layout, check: checkLayout(built.layout), mode: built.mode, notUsed: built.planIssues };
  }, [rooms, eventName, plan]);
  const [x0, z0, x1, z1] = layout.bounds;
  // Room above for the floor names when there are several floors.
  const pad = layout.levels ? 5 : 3;
  const width = x1 - x0;
  const depth = z1 - z0;

  return (
    <section className="space-y-3">
      <SectionHeading
        title="Floor plan"
        description={planSummary(layout, mode, width, depth)}
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
            <LayoutDrawing layout={layout} sponsors={sponsors} />
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
