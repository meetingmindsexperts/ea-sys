"use client";

/**
 * Compose from the inbox (Oct 27, 2026, phase 3 of docs/CRM_INBOX_PLAN.md).
 * Owner decision: every email belongs to a deal, so Compose picks the deal
 * first and then opens the deal email dialog on it. The email is then a deal
 * email in every respect: that deal's people, its event's tokens and branding,
 * its documents, its history.
 *
 * Deals are filtered in the browser: the deals list already loads up to the
 * CRM_DEALS_LIST_CAP (2,000) and production holds a few dozen.
 */
import { useMemo, useState } from "react";
import { Search } from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { CrmEmailDialog } from "@/crm/components/crm-email-dialog";
import { useCrmDeals } from "@/crm/hooks/use-crm-api";
import type { CrmBoardDeal } from "@/crm/lib/crm-types";

const MAX_SHOWN = 50;

function matches(d: CrmBoardDeal, q: string): boolean {
  const hay = `${d.name} ${d.company?.name ?? ""}`.toLowerCase();
  return q.toLowerCase().split(/\s+/).filter(Boolean).every((w) => hay.includes(w));
}

function pickerMessage(loading: boolean, total: number, shown: number, q: string): string | null {
  if (loading) return "Loading deals…";
  if (total === 0) return q ? `No deal matches “${q}”.` : "No deals yet. Create a deal first.";
  if (total > shown) return `Showing ${shown} of ${total}. Type more of the name to narrow it down.`;
  return null;
}

/**
 * The searchable deal list. Its own component so the deals load only while
 * the dialog is open (Radix unmounts closed dialog content), not every time
 * the inbox renders.
 */
function DealPicker({ onChoose }: { onChoose: (deal: CrmBoardDeal) => void }) {
  const [search, setSearch] = useState("");
  const deals = useCrmDeals({});

  const q = search.trim();
  const matched = useMemo(
    // Open and won deals: a signed sponsor still needs emails. A lost deal is
    // not a sponsor (the sponsor blast's rule too).
    () => (deals.data ?? []).filter((d) => d.status !== "LOST" && (!q || matches(d, q))),
    [deals.data, q],
  );
  const shown = matched.slice(0, MAX_SHOWN);
  const message = pickerMessage(deals.isLoading, matched.length, shown.length, q);

  return (
    <>
      <div className="relative">
        <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
        <Input
          autoFocus
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search deals by name or account…"
          aria-label="Search deals"
          className="pl-8"
        />
      </div>
      {message && <p className="text-sm text-muted-foreground">{message}</p>}
      {shown.length > 0 && (
        <ul className="min-h-0 flex-1 divide-y overflow-y-auto rounded-md border">
          {shown.map((d) => (
            <li key={d.id}>
              <button type="button" onClick={() => onChoose(d)} className="w-full px-3 py-2 text-left hover:bg-muted/50">
                <span className="block truncate text-sm font-medium">{d.name}</span>
                <span className="block truncate text-xs text-muted-foreground">
                  {[d.company?.name, d.stage?.name].filter(Boolean).join(" · ")}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

export function ComposeCrmEmailDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const [deal, setDeal] = useState<CrmBoardDeal | null>(null);

  function choose(d: CrmBoardDeal) {
    setDeal(d);
    onOpenChange(false);
  }

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="flex max-h-[80vh] flex-col gap-3 sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>New email</DialogTitle>
            <DialogDescription>Every email belongs to a deal. Choose the deal, then write to its people.</DialogDescription>
          </DialogHeader>
          <DealPicker onChoose={choose} />
        </DialogContent>
      </Dialog>

      {/* Keyed by deal so one deal's draft never carries into another's. */}
      {deal && (
        <CrmEmailDialog
          key={deal.id}
          open
          onOpenChange={(o) => !o && setDeal(null)}
          target={{ kind: "deal", id: deal.id }}
        />
      )}
    </>
  );
}
