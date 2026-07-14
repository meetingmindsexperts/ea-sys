"use client";

/**
 * Deals — the sponsorship pipeline board.
 *
 * The event filter is first-class here rather than an afterthought: the whole point
 * of building this instead of buying Freshsales is that a deal is tied to an event
 * ("show me everything we're selling against BRIDGES 2026"), and no off-the-shelf
 * CRM can do that join against our data.
 *
 * MEMBER gets the board read-only, with money stripped server-side. We disable the
 * drag rather than hide the board — leadership is exactly who wants to look at it.
 */
import { useState } from "react";
import { useSession } from "next-auth/react";
import { Plus, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useEvents } from "@/hooks/use-api";
import { DealBoard } from "@/crm/components/deal-board";
import { DealDetailSheet } from "@/crm/components/deal-detail-sheet";
import { CreateDealDialog } from "@/crm/components/create-deal-dialog";
import { useCrmDeals, useCrmStages, useMoveDealStage } from "@/crm/hooks/use-crm-api";
import { canOwnDeals } from "@/crm/lib/crm-roles";
import type { CrmBoardDeal } from "@/crm/lib/crm-types";

const ALL_EVENTS = "__all__";

export default function CrmDealsPage() {
  const { data: session } = useSession();
  const role = session?.user?.role;
  // MEMBER reads the board but never moves a card — same predicate the server uses,
  // so the UI can't offer an action the API will refuse.
  const canWrite = canOwnDeals(role);

  const [eventId, setEventId] = useState<string>(ALL_EVENTS);
  const [openDeal, setOpenDeal] = useState<CrmBoardDeal | null>(null);
  const [createOpen, setCreateOpen] = useState(false);

  const filters = eventId === ALL_EVENTS ? {} : { eventId };

  const { data: stages = [], isLoading: stagesLoading } = useCrmStages();
  const { data: deals = [], isLoading: dealsLoading } = useCrmDeals(filters);
  const move = useMoveDealStage(filters);

  const { data: events = [] } = useEvents();

  const isLoading = stagesLoading || dealsLoading;

  return (
    <div className="space-y-6 p-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold">Deals</h1>
          <p className="text-sm text-muted-foreground">
            Sponsorship and exhibitor pipeline
            {!canWrite && " — read-only"}
          </p>
        </div>

        <div className="flex items-center gap-2">
          <Select value={eventId} onValueChange={setEventId}>
            <SelectTrigger className="w-[16rem]">
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

          {canWrite && (
            <Button onClick={() => setCreateOpen(true)}>
              <Plus className="mr-2 h-4 w-4" />
              New deal
            </Button>
          )}
        </div>
      </div>

      {isLoading ? (
        <div className="flex items-center gap-2 py-16 text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" />
          Loading the pipeline…
        </div>
      ) : stages.length === 0 ? (
        <p className="py-16 text-center text-sm text-muted-foreground">
          No pipeline stages yet.
        </p>
      ) : (
        <DealBoard
          stages={stages}
          deals={deals}
          onMove={(args) => move.mutate(args)}
          onOpenDeal={setOpenDeal}
          readOnly={!canWrite}
        />
      )}

      <CreateDealDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        stages={stages}
        defaultEventId={eventId === ALL_EVENTS ? null : eventId}
      />

      <DealDetailSheet
        deal={openDeal}
        onOpenChange={(o) => !o && setOpenDeal(null)}
        canWrite={canWrite}
      />
    </div>
  );
}
