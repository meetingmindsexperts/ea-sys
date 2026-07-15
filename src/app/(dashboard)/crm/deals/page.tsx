"use client";

/**
 * Deals — the sponsorship pipeline board.
 *
 * The event filter is first-class here: the whole point of building this rather
 * than buying Freshsales is that a deal is tied to an event ("show me everything
 * we're selling against BRIDGES 2026"), and no off-the-shelf CRM can do that join.
 *
 * All filters live in the URL (see use-crm-filters), so a filtered board is
 * shareable, bookmarkable and survives a refresh — consistent with the tabs being
 * links, not state.
 *
 * MEMBER gets the board read-only, with money stripped server-side, and no value
 * filter (the server also ignores value params from a non-finance caller, so a
 * redacted number can't be binary-searched through a filter).
 */
import { Suspense, useState } from "react";
import { useSession } from "next-auth/react";
import { Plus, Loader2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useCrmEvents } from "@/crm/hooks/use-crm-api";
import { DealBoard } from "@/crm/components/deal-board";
import { DealDetailSheet } from "@/crm/components/deal-detail-sheet";
import { CreateDealDialog } from "@/crm/components/create-deal-dialog";
import { OwnerFilter } from "@/crm/components/filters/owner-filter";
import { DateRangeFilter } from "@/crm/components/filters/date-range-filter";
import { ValueRangeFilter } from "@/crm/components/filters/value-range-filter";
import { useCrmDeals, useCrmStages, useMoveDealStage } from "@/crm/hooks/use-crm-api";
import { useCrmFilters } from "@/crm/lib/use-crm-filters";
import { canOwnDeals, canViewDealValues } from "@/crm/lib/crm-roles";
import type { CrmBoardDeal } from "@/crm/lib/crm-types";

const ALL_EVENTS = "__all__";
const ALL_STATUS = "__all__";

const DATE_FIELDS = [
  { value: "expectedClose", label: "Expected close" },
  { value: "createdAt", label: "Created" },
  { value: "closed", label: "Closed (won/lost)" },
];

// The query keys this page owns — for the "Clear" affordance and the server query.
const FILTER_KEYS = ["event", "owner", "status", "dateField", "from", "to", "min", "max"];

function DealsPageInner() {
  const { data: session } = useSession();
  const role = session?.user?.role;
  const canWrite = canOwnDeals(role);
  const canSeeValues = canViewDealValues(role);

  const { get, set, clear, anyActive } = useCrmFilters();

  const [openDeal, setOpenDeal] = useState<CrmBoardDeal | null>(null);
  const [createOpen, setCreateOpen] = useState(false);

  const eventId = get("event");
  const filters = {
    eventId: eventId || undefined,
    ownerId: get("owner") || undefined,
    status: get("status") || undefined,
    dateField: get("dateField") || undefined,
    from: get("from") || undefined,
    to: get("to") || undefined,
    // Sent only when the caller may see values; the server enforces this too, so
    // this is just to keep the URL honest for a MEMBER.
    min: canSeeValues ? get("min") || undefined : undefined,
    max: canSeeValues ? get("max") || undefined : undefined,
  };

  const { data: stages = [], isLoading: stagesLoading } = useCrmStages();
  const { data: deals = [], isLoading: dealsLoading } = useCrmDeals(filters);
  const move = useMoveDealStage(filters);
  const { data: events = [] } = useCrmEvents();

  const isLoading = stagesLoading || dealsLoading;
  const filtersActive = anyActive(FILTER_KEYS);

  return (
    <div className="space-y-4 p-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-muted-foreground">
          {canWrite ? "Drag a card to move it through the pipeline." : "Read-only."}
        </p>
        {canWrite && (
          <Button onClick={() => setCreateOpen(true)}>
            <Plus className="mr-2 h-4 w-4" />
            New deal
          </Button>
        )}
      </div>

      {/* ── Filter bar ─────────────────────────────────────────────────────── */}
      <div className="flex flex-wrap items-center gap-2 rounded-lg border bg-muted/20 p-2">
        <Select value={eventId || ALL_EVENTS} onValueChange={(v) => set({ event: v === ALL_EVENTS ? null : v })}>
          <SelectTrigger className="w-[14rem]">
            <SelectValue placeholder="All events" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL_EVENTS}>All events</SelectItem>
            {events.map((e: { id: string; name: string }) => (
              <SelectItem key={e.id} value={e.id}>
                {e.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <OwnerFilter value={get("owner")} onChange={(v) => set({ owner: v })} />

        <Select value={get("status") || ALL_STATUS} onValueChange={(v) => set({ status: v === ALL_STATUS ? null : v })}>
          <SelectTrigger className="w-[9rem]">
            <SelectValue placeholder="Any status" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL_STATUS}>Any status</SelectItem>
            <SelectItem value="OPEN">Open</SelectItem>
            <SelectItem value="WON">Won</SelectItem>
            <SelectItem value="LOST">Lost</SelectItem>
          </SelectContent>
        </Select>

        <DateRangeFilter
          fields={DATE_FIELDS}
          fieldValue={get("dateField") || "expectedClose"}
          onFieldChange={(v) => set({ dateField: v === "expectedClose" ? null : v })}
          from={get("from")}
          to={get("to")}
          onFromChange={(v) => set({ from: v })}
          onToChange={(v) => set({ to: v })}
        />

        {/* Value filter is staff-only — the server independently drops it for MEMBER. */}
        {canSeeValues && (
          <ValueRangeFilter
            min={get("min")}
            max={get("max")}
            onMinChange={(v) => set({ min: v })}
            onMaxChange={(v) => set({ max: v })}
          />
        )}

        {filtersActive && (
          <Button variant="ghost" size="sm" onClick={() => clear(FILTER_KEYS)}>
            <X className="mr-1 h-3.5 w-3.5" />
            Clear
          </Button>
        )}
      </div>

      {isLoading ? (
        <div className="flex items-center gap-2 py-16 text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" />
          Loading the pipeline…
        </div>
      ) : stages.length === 0 ? (
        <p className="py-16 text-center text-sm text-muted-foreground">No pipeline stages yet.</p>
      ) : (
        <>
          {filtersActive && (
            <p className="text-xs text-muted-foreground">
              {deals.length} deal{deals.length === 1 ? "" : "s"} match these filters.
            </p>
          )}
          <DealBoard
            stages={stages}
            deals={deals}
            onMove={(args) => move.mutate(args)}
            onOpenDeal={setOpenDeal}
            readOnly={!canWrite}
          />
        </>
      )}

      <CreateDealDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        stages={stages}
        defaultEventId={eventId || null}
      />

      <DealDetailSheet
        deal={openDeal}
        onOpenChange={(o) => !o && setOpenDeal(null)}
        canWrite={canWrite}
      />
    </div>
  );
}

export default function CrmDealsPage() {
  // useSearchParams (inside useCrmFilters) needs a Suspense boundary.
  return (
    <Suspense fallback={<div className="p-6 text-sm text-muted-foreground">Loading…</div>}>
      <DealsPageInner />
    </Suspense>
  );
}
