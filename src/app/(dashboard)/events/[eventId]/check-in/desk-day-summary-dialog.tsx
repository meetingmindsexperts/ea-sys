"use client";

import { useRef, useState } from "react";
import { ClipboardList, Printer } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useDeskSummary, type DeskSummaryResponse } from "@/hooks/use-api";
import { useCan } from "@/hooks/use-can";
import { localDateInTz, resolveTimezone } from "@/lib/event-time";
import { WALK_IN_BUCKETS, type WalkInBucket } from "@/lib/desk-day-summary";

const BUCKET_LABEL: Record<WalkInBucket, string> = {
  free: "Free",
  comp: "Comp",
  sponsor: "Sponsor",
  paid: "Paid",
  unpaid: "Not paid",
};

const METHOD_LABEL = { cash: "Cash", card_onsite: "Card" } as const;

/**
 * The desk's day summary (owner, Nov 2, 2026): walk-ins by rate and the cash
 * and card per desk user, for one day in the event's timezone. Opens from the
 * desk header for whoever records payments; the route decides whether they see
 * everyone or only themselves.
 */
export function DeskDaySummaryDialog({ eventId, eventName, timezone }: { eventId: string; eventName: string; timezone: string | null }) {
  const allowed = useCan("payments.record", eventId) === "allowed";
  const tz = resolveTimezone(timezone);
  const [open, setOpen] = useState(false);
  const [date, setDate] = useState(() => localDateInTz(new Date(), tz));
  const { data, isLoading, isError } = useDeskSummary(eventId, date, open);
  const sheet = useRef<HTMLDivElement>(null);

  if (!allowed) return null;

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm" className="gap-1.5">
          <ClipboardList className="h-4 w-4" /> Day summary
        </Button>
      </DialogTrigger>
      <DialogContent className="max-h-[90vh] max-w-3xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Desk day summary</DialogTitle>
          <DialogDescription>
            Walk-ins by rate, and the cash and card taken at the desk. Times are in {tz}.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-wrap items-end justify-between gap-3">
          <div className="space-y-1">
            <Label htmlFor="desk-summary-date">Day</Label>
            <Input id="desk-summary-date" type="date" value={date} onChange={(e) => e.target.value && setDate(e.target.value)} className="w-44" />
          </div>
          <Button variant="outline" size="sm" className="gap-1.5" disabled={!data} onClick={() => printSummary(sheet.current, eventName, date)}>
            <Printer className="h-4 w-4" /> Print
          </Button>
        </div>

        {isLoading && <p className="text-sm text-muted-foreground">Loading…</p>}
        {isError && <p className="text-sm text-destructive">The summary could not be loaded. Try again.</p>}
        {data && (
          <div ref={sheet}>
            {/* Hidden here; the print window has no `hidden` rule, so it heads the sheet there. */}
            <h2 className="hidden">{eventName}: desk day summary, {data.date}</h2>
            {data.scope === "own" && (
              <p className="mb-3 rounded-md bg-muted px-3 py-2 text-sm">Showing only the walk-ins you registered and the payments you took.</p>
            )}
            <WalkIns data={data} />
            <Money data={data} />
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

function WalkIns({ data }: { data: DeskSummaryResponse }) {
  const { walkIns } = data;
  return (
    <section className="space-y-2">
      <h3 className="text-sm font-semibold">Walk-ins: {walkIns.total}</h3>
      {walkIns.total === 0 ? (
        <p className="text-sm text-muted-foreground">No walk-ins on this day.</p>
      ) : (
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr className="border-b text-left text-muted-foreground">
              <th className="py-1.5 pr-2 font-medium">Type · rate</th>
              {WALK_IN_BUCKETS.map((b) => (
                <th key={b} className="px-2 py-1.5 text-right font-medium">{BUCKET_LABEL[b]}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {walkIns.byRate.map((line) => (
              <tr key={`${line.ticketTypeName}·${line.rateName ?? ""}`} className="border-b">
                <td className="py-1.5 pr-2">{line.rateName ? `${line.ticketTypeName} · ${line.rateName}` : line.ticketTypeName}</td>
                {WALK_IN_BUCKETS.map((b) => (
                  <td key={b} className="px-2 py-1.5 text-right tabular-nums">{line.counts[b] || ""}</td>
                ))}
              </tr>
            ))}
            <tr className="font-semibold">
              <td className="py-1.5 pr-2">Total</td>
              {WALK_IN_BUCKETS.map((b) => (
                <td key={b} className="px-2 py-1.5 text-right tabular-nums">{walkIns.totals[b]}</td>
              ))}
            </tr>
          </tbody>
        </table>
      )}
      {walkIns.totals.unpaid > 0 && (
        <p className="text-sm text-amber-700">
          {walkIns.totals.unpaid} walk-in{walkIns.totals.unpaid === 1 ? "" : "s"} registered without the payment recording. Find them in the search and record it.
        </p>
      )}
    </section>
  );
}

function Money({ data }: { data: DeskSummaryResponse }) {
  const { money, userNames } = data;
  return (
    <section className="mt-5 space-y-2">
      <h3 className="text-sm font-semibold">Cash and card taken</h3>
      <p className="text-xs text-muted-foreground">Every desk payment recorded on this day, walk-ins and people who registered before.</p>
      {money.totals.length === 0 ? (
        <p className="text-sm text-muted-foreground">No cash or card recorded on this day.</p>
      ) : (
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr className="border-b text-left text-muted-foreground">
              <th className="py-1.5 pr-2 font-medium">Taken by</th>
              <th className="px-2 py-1.5 font-medium">Method</th>
              <th className="px-2 py-1.5 text-right font-medium">Payments</th>
              <th className="px-2 py-1.5 text-right font-medium">Amount</th>
              <th className="px-2 py-1.5 text-right font-medium">Refunded</th>
            </tr>
          </thead>
          <tbody>
            {money.byUser.map((m) => (
              <tr key={`${m.userId ?? ""}·${m.method}·${m.currency}`} className="border-b">
                <td className="py-1.5 pr-2">{(m.userId && userNames[m.userId]) || "Unknown"}</td>
                <td className="px-2 py-1.5">{METHOD_LABEL[m.method]}</td>
                <td className="px-2 py-1.5 text-right tabular-nums">{m.count}</td>
                <td className="px-2 py-1.5 text-right tabular-nums">{formatMoney(m.amount, m.currency)}</td>
                <td className="px-2 py-1.5 text-right tabular-nums">{m.refunded ? formatMoney(m.refunded, m.currency) : ""}</td>
              </tr>
            ))}
            {money.totals.map((t) => (
              <tr key={`total·${t.method}·${t.currency}`} className="font-semibold">
                <td className="py-1.5 pr-2">Total</td>
                <td className="px-2 py-1.5">{METHOD_LABEL[t.method]}</td>
                <td className="px-2 py-1.5 text-right tabular-nums">{t.count}</td>
                <td className="px-2 py-1.5 text-right tabular-nums">{formatMoney(t.amount, t.currency)}</td>
                <td className="px-2 py-1.5 text-right tabular-nums">{t.refunded ? formatMoney(t.refunded, t.currency) : ""}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

function formatMoney(amount: number, currency: string): string {
  return `${currency} ${amount.toFixed(2)}`;
}

/** The summary as rendered, in a window of its own, printed with the browser's dialog. */
function printSummary(node: HTMLElement | null, eventName: string, date: string) {
  if (!node) return;
  const win = window.open("", "_blank", "width=900,height=1000");
  if (!win) {
    toast.error("The print window was blocked. Allow pop-ups for this site and try again.");
    return;
  }
  // React has already escaped every text in the node; the title is set through the DOM.
  win.document.write(`<!doctype html><html><head><meta charset="utf-8"><title></title>
<style>
  @page { size: A4; margin: 15mm; }
  body { font-family: system-ui, -apple-system, "Segoe UI", sans-serif; color: #0f172a; font-size: 10.5pt; }
  h2 { font-size: 15pt; margin: 0 0 6mm; }
  h3 { font-size: 12pt; margin: 6mm 0 2mm; }
  table { width: 100%; border-collapse: collapse; }
  th, td { padding: 4px 6px; border-bottom: 1px solid #cbd5e1; text-align: left; }
  .text-right { text-align: right; }
  .font-semibold { font-weight: 600; }
  p { margin: 2mm 0; }
</style></head><body>${node.outerHTML}</body></html>`);
  win.document.close();
  win.document.title = `${eventName}: desk day summary, ${date}`;
  win.focus();
  win.print();
}
