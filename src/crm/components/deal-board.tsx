"use client";

/**
 * The sponsorship pipeline board.
 *
 * Drag-and-drop with @dnd-kit. Two things here are deliberate and easy to get wrong:
 *
 * 1. THE DRAG SENDS `fromStageId`. We capture the card's stage at drag START, not
 *    at drop. That is the value the server uses as its precondition, so if a
 *    colleague moved the same card while this one was mid-air, our write is refused
 *    (409) instead of silently overwriting their decision. Sending only the target
 *    column would make this last-write-wins.
 *
 * 2. MONEY MAY BE ABSENT. For a MEMBER the server strips `dealValue`, so a card can
 *    have no value at all. We render "—" rather than "$0" — a redacted value and a
 *    genuinely-zero deal are different facts and must not look identical.
 *
 * A pointer sensor with an 8px activation distance keeps a click-to-open from being
 * swallowed as a micro-drag.
 */
import { useMemo, useState } from "react";
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  useSensor,
  useSensors,
  useDraggable,
  useDroppable,
  type DragEndEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import { Building2, CalendarClock, GripVertical, MessageSquare, CheckSquare } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import {
  formatDealValue,
  personName,
  sumStageValue,
  type CrmBoardDeal,
  type CrmStage,
} from "@/crm/lib/crm-types";

interface DealBoardProps {
  stages: CrmStage[];
  deals: CrmBoardDeal[];
  onMove: (args: { dealId: string; fromStageId: string; toStageId: string }) => void;
  onOpenDeal: (deal: CrmBoardDeal) => void;
  /** MEMBER can look but not touch — the board renders read-only. */
  readOnly?: boolean;
}

export function DealBoard({ stages, deals, onMove, onOpenDeal, readOnly }: DealBoardProps) {
  const [draggingId, setDraggingId] = useState<string | null>(null);

  const sensors = useSensors(
    useSensor(PointerSensor, {
      // Without a small activation distance, a click to open a card registers as a
      // 1px drag and the card never opens.
      activationConstraint: { distance: 8 },
    }),
  );

  const byStage = useMemo(() => {
    const map = new Map<string, CrmBoardDeal[]>();
    for (const s of stages) map.set(s.id, []);
    for (const d of deals) {
      if (!map.has(d.stageId)) map.set(d.stageId, []);
      map.get(d.stageId)!.push(d);
    }
    return map;
  }, [stages, deals]);

  const dragging = draggingId ? deals.find((d) => d.id === draggingId) ?? null : null;

  function handleDragStart(e: DragStartEvent) {
    setDraggingId(String(e.active.id));
  }

  function handleDragEnd(e: DragEndEvent) {
    setDraggingId(null);
    const { active, over } = e;
    if (!over) return;

    const dealId = String(active.id);
    const toStageId = String(over.id);
    // The stage the card was in when the drag began — the concurrency precondition.
    const fromStageId = (active.data.current as { stageId?: string } | undefined)?.stageId;

    if (!fromStageId || fromStageId === toStageId) return;
    onMove({ dealId, fromStageId, toStageId });
  }

  return (
    <DndContext
      sensors={sensors}
      onDragStart={handleDragStart}
      onDragEnd={handleDragEnd}
      onDragCancel={() => setDraggingId(null)}
    >
      <div className="flex gap-4 overflow-x-auto pb-4">
        {stages.map((stage) => {
          const stageDeals = byStage.get(stage.id) ?? [];
          return (
            <StageColumn
              key={stage.id}
              stage={stage}
              deals={stageDeals}
              onOpenDeal={onOpenDeal}
              readOnly={readOnly}
            />
          );
        })}
      </div>

      {/* The card follows the cursor; the original stays put until the server agrees. */}
      <DragOverlay>
        {dragging ? <DealCard deal={dragging} isOverlay /> : null}
      </DragOverlay>
    </DndContext>
  );
}

function StageColumn({
  stage,
  deals,
  onOpenDeal,
  readOnly,
}: {
  stage: CrmStage;
  deals: CrmBoardDeal[];
  onOpenDeal: (d: CrmBoardDeal) => void;
  readOnly?: boolean;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: stage.id, disabled: readOnly });
  const total = sumStageValue(deals);

  return (
    <div
      ref={setNodeRef}
      className={cn(
        "flex w-72 shrink-0 flex-col rounded-xl border bg-muted/30 transition-colors",
        isOver && "border-primary bg-primary/5 ring-1 ring-primary/20",
      )}
    >
      <div className="sticky top-0 z-10 flex items-center justify-between gap-2 rounded-t-xl border-b bg-muted/60 px-3 py-2.5 backdrop-blur-sm">
        <div className="flex min-w-0 items-center gap-2">
          <h3 className="truncate text-sm font-semibold">{stage.name}</h3>
          <span className="rounded-full bg-background px-2 py-0.5 text-xs font-medium tabular-nums text-muted-foreground">
            {deals.length}
          </span>
        </div>
        {/* Null when money is redacted (MEMBER) — show nothing rather than a fake 0. */}
        {total && <span className="shrink-0 text-xs font-semibold tabular-nums text-muted-foreground">{total}</span>}
      </div>

      <div className="flex min-h-[500px] flex-1 flex-col gap-2 p-2">
        {deals.length === 0 ? (
          <div className="flex flex-1 items-center justify-center rounded-lg border border-dashed py-8 text-center text-xs text-muted-foreground/70">
            No deals
          </div>
        ) : (
          deals.map((deal) => (
            <DraggableDeal
              key={deal.id}
              deal={deal}
              onOpen={() => onOpenDeal(deal)}
              readOnly={readOnly}
            />
          ))
        )}
      </div>
    </div>
  );
}

/** Owner initials in a small token — a face on the card without a photo. */
function Monogram({ name }: { name: string }) {
  const initials =
    name === "Unassigned"
      ? "?"
      : name
          .split(" ")
          .filter(Boolean)
          .slice(0, 2)
          .map((w) => w[0])
          .join("")
          .toUpperCase();
  return (
    <span
      className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-primary/10 text-[9px] font-semibold text-primary"
      aria-hidden="true"
    >
      {initials}
    </span>
  );
}

function DraggableDeal({
  deal,
  onOpen,
  readOnly,
}: {
  deal: CrmBoardDeal;
  onOpen: () => void;
  readOnly?: boolean;
}) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: deal.id,
    disabled: readOnly,
    // Carried into handleDragEnd — this is what becomes `fromStageId`.
    data: { stageId: deal.stageId },
  });

  return (
    <div ref={setNodeRef} className={cn(isDragging && "opacity-40")}>
      <DealCard
        deal={deal}
        onOpen={onOpen}
        dragHandle={
          readOnly ? null : (
            <button
              type="button"
              className="cursor-grab touch-none text-muted-foreground/60 hover:text-muted-foreground active:cursor-grabbing"
              aria-label={`Move ${deal.name}`}
              {...listeners}
              {...attributes}
            >
              <GripVertical className="h-4 w-4" />
            </button>
          )
        }
      />
    </div>
  );
}

function DealCard({
  deal,
  onOpen,
  dragHandle,
  isOverlay,
}: {
  deal: CrmBoardDeal;
  onOpen?: () => void;
  dragHandle?: React.ReactNode;
  isOverlay?: boolean;
}) {
  const value = formatDealValue(deal.dealValue, deal.currency);
  const tasks = deal._count?.tasks ?? 0;
  const notes = deal._count?.notes ?? 0;
  const ownerName = personName(deal.owner);
  // A subtle left accent for closed deals (seen in the Won/Lost columns + archived
  // view) — status you can read at a glance without parsing a badge.
  const statusAccent =
    deal.status === "WON"
      ? "border-l-2 border-l-emerald-400"
      : deal.status === "LOST"
        ? "border-l-2 border-l-rose-300"
        : "";

  return (
    <div
      className={cn(
        "group rounded-lg border bg-background p-3 shadow-sm transition-all",
        statusAccent,
        onOpen && "hover:border-primary/40 hover:shadow-md",
        isOverlay && "rotate-2 shadow-lg ring-1 ring-primary/20",
      )}
    >
      <div className="flex items-start gap-2">
        {dragHandle}
        <button
          type="button"
          onClick={onOpen}
          className={cn("min-w-0 flex-1 text-left", onOpen && "cursor-pointer")}
          disabled={!onOpen}
        >
          <p className="text-sm font-medium leading-snug">{deal.name}</p>

          {deal.company && (
            <p className="mt-1 flex items-center gap-1 truncate text-xs text-muted-foreground">
              <Building2 className="h-3 w-3 shrink-0" />
              {deal.company.name}
            </p>
          )}

          <div className="mt-2 flex items-center justify-between gap-2">
            {/* A redacted value and a $0 deal are different facts. Tabular figures
                keep the column of numbers aligned across cards. */}
            <span className="text-sm font-semibold tabular-nums">
              {value ?? <span className="font-normal text-muted-foreground">—</span>}
            </span>
            {deal.event && (
              <Badge variant="outline" className="max-w-[8rem] shrink-0 truncate text-[10px]">
                {deal.event.name}
              </Badge>
            )}
          </div>

          <div className="mt-2.5 flex items-center justify-between gap-2 text-[11px] text-muted-foreground">
            <span className="flex min-w-0 items-center gap-1.5">
              <Monogram name={ownerName} />
              <span className="truncate">{ownerName}</span>
            </span>
            <span className="flex shrink-0 items-center gap-2.5 tabular-nums">
              {deal.expectedClose && (
                <span className="flex items-center gap-1">
                  <CalendarClock className="h-3 w-3" />
                  {new Date(deal.expectedClose).toLocaleDateString()}
                </span>
              )}
              {tasks > 0 && (
                <span className="flex items-center gap-1" title={`${tasks} task${tasks === 1 ? "" : "s"}`}>
                  <CheckSquare className="h-3 w-3" />
                  {tasks}
                </span>
              )}
              {notes > 0 && (
                <span className="flex items-center gap-1" title={`${notes} note${notes === 1 ? "" : "s"}`}>
                  <MessageSquare className="h-3 w-3" />
                  {notes}
                </span>
              )}
            </span>
          </div>
        </button>
      </div>
    </div>
  );
}
