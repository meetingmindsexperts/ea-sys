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
import { useRouter } from "next/navigation";
import { useSession } from "next-auth/react";
import { Archive, Columns3, Handshake, Mail, Plus, Upload, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { EventCombobox } from "@/crm/components/event-combobox";
import { DealBoard } from "@/crm/components/deal-board";
import { CreateDealDialog } from "@/crm/components/create-deal-dialog";
import { CrmEmailDialog } from "@/crm/components/crm-email-dialog";
import { CrmEmptyState } from "@/crm/components/crm-empty-state";
import { CrmBoardSkeleton } from "@/crm/components/crm-skeletons";
import { OwnerFilter } from "@/crm/components/filters/owner-filter";
import { DateRangeFilter } from "@/crm/components/filters/date-range-filter";
import { ValueRangeFilter } from "@/crm/components/filters/value-range-filter";
import { useCrmDeals, useCrmStages, useMoveDealStage } from "@/crm/hooks/use-crm-api";
import { ManageStagesDialog } from "@/crm/components/manage-stages-dialog";
import { EmptyArchiveButton } from "@/crm/components/empty-archive-button";
import { FreshsalesImportDialog } from "@/crm/components/freshsales-import-dialog";
import { CrmLoadError } from "@/crm/components/crm-load-error";
import { useCrmFilters } from "@/crm/lib/use-crm-filters";
import { canOwnDeals, canViewDealValues } from "@/crm/lib/crm-roles";
import { sumStageValue } from "@/crm/lib/crm-types";

const ALL_STATUS = "__all__";

const DATE_FIELDS = [
  { value: "expectedClose", label: "Expected close" },
  { value: "createdAt", label: "Created" },
  { value: "closed", label: "Closed (won/lost)" },
];

// The query keys this page owns — for the "Clear" affordance and the server query.
const FILTER_KEYS = ["event", "owner", "status", "dateField", "from", "to", "min", "max", "archived"];

function DealsPageInner() {
  const { data: session } = useSession();
  const role = session?.user?.role;
  const canWrite = canOwnDeals(role);
  const canSeeValues = canViewDealValues(role);

  const { get, set, clear, anyActive } = useCrmFilters();
  const router = useRouter();

  const [createOpen, setCreateOpen] = useState(false);
  const [sponsorEmailOpen, setSponsorEmailOpen] = useState(false);
  const [manageStagesOpen, setManageStagesOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);

  const eventId = get("event");
  const archivedView = !!get("archived");
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
    archived: archivedView ? "1" : undefined,
  };

  const { data: stages = [], isLoading: stagesLoading, isError: stagesError, refetch: refetchStages } = useCrmStages();
  const { data: deals = [], isLoading: dealsLoading, isError: dealsError, refetch: refetchDeals } = useCrmDeals(filters);
  const move = useMoveDealStage(filters);

  const isLoading = stagesLoading || dealsLoading;
  const filtersActive = anyActive(FILTER_KEYS);

  return (
    <div className="space-y-4 p-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-muted-foreground">
          {canWrite ? "Drag a card to move it through the pipeline." : "Read-only."}
        </p>
        {canWrite && (
          <div className="flex items-center gap-2">
            <Button variant="outline" onClick={() => setImportOpen(true)}>
              <Upload className="mr-2 h-4 w-4" />
              Import CSV
            </Button>
            <Button variant="outline" onClick={() => setManageStagesOpen(true)}>
              <Columns3 className="mr-2 h-4 w-4" />
              Manage stages
            </Button>
            <Button
              variant="outline"
              disabled={!eventId}
              title={eventId ? "Email this event's sponsors" : "Pick an event to email its sponsors"}
              onClick={() => setSponsorEmailOpen(true)}
            >
              <Mail className="mr-2 h-4 w-4" />
              Email sponsors
            </Button>
            <Button onClick={() => setCreateOpen(true)}>
              <Plus className="mr-2 h-4 w-4" />
              New deal
            </Button>
          </div>
        )}
      </div>

      {/* ── Filter bar ─────────────────────────────────────────────────────── */}
      <div className="flex flex-wrap items-center gap-2 rounded-lg border bg-muted/20 p-2">
        <EventCombobox
          value={eventId || null}
          onChange={(v) => set({ event: v })}
          clearLabel="All events"
          className="w-[14rem]"
        />

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

        <Button
          variant={archivedView ? "default" : "outline"}
          size="sm"
          onClick={() => set({ archived: archivedView ? null : "1" })}
        >
          <Archive className="mr-2 h-3.5 w-3.5" />
          {archivedView ? "Showing archived" : "Show archived"}
        </Button>
        <EmptyArchiveButton entity="deals" visible={archivedView} />

        {filtersActive && (
          <Button variant="ghost" size="sm" onClick={() => clear(FILTER_KEYS)}>
            <X className="mr-1 h-3.5 w-3.5" />
            Clear
          </Button>
        )}
      </div>

      {isLoading ? (
        <CrmBoardSkeleton columns={stages.length || 5} />
      ) : stagesError || dealsError ? (
        // A failed board fetch must never render as an empty pipeline — M6.
        <CrmLoadError
          what="the deals board"
          onRetry={() => {
            void refetchStages();
            void refetchDeals();
          }}
        />
      ) : stages.length === 0 ? (
        <CrmEmptyState
          icon={Handshake}
          title="No pipeline stages yet"
          description="The pipeline seeds a default set of stages on first use — reload in a moment if this persists."
        />
      ) : deals.length === 0 ? (
        <CrmEmptyState
          icon={Handshake}
          title={
            archivedView
              ? "No archived deals"
              : filtersActive
                ? "No deals match these filters"
                : "No deals yet"
          }
          description={
            archivedView
              ? "Deals you archive will show up here, ready to restore."
              : filtersActive
                ? "Try clearing a filter to widen the view."
                : "Track a sponsorship or exhibitor opportunity against an event."
          }
          action={
            canWrite && !archivedView && !filtersActive ? (
              <Button onClick={() => setCreateOpen(true)}>
                <Plus className="mr-2 h-4 w-4" />
                New deal
              </Button>
            ) : undefined
          }
        />
      ) : (
        <>
          <p className="text-xs text-muted-foreground tabular-nums">
            {deals.length} deal{deals.length === 1 ? "" : "s"}
            {filtersActive && " match these filters"}
            {canSeeValues && sumStageValue(deals) && (
              <> · {sumStageValue(deals)} total</>
            )}
          </p>
          <DealBoard
            stages={stages}
            deals={deals}
            onMove={(args) => move.mutate(args)}
            onOpenDeal={(deal) => router.push(`/crm/deals/${deal.id}`)}
            // Archived deals are a read-only listing — you restore them from the
            // deal page, you don't drag them around the pipeline.
            readOnly={!canWrite || archivedView}
          />
        </>
      )}

      <CreateDealDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        stages={stages}
        defaultEventId={eventId || null}
      />

      <ManageStagesDialog stages={stages} open={manageStagesOpen} onOpenChange={setManageStagesOpen} />
      {importOpen && <FreshsalesImportDialog type="deals" open={importOpen} onOpenChange={setImportOpen} />}

      <CrmEmailDialog
        open={sponsorEmailOpen}
        onOpenChange={setSponsorEmailOpen}
        target={eventId ? { kind: "event", id: eventId } : null}
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
