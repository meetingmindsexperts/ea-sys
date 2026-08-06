"use client";

import { useMemo } from "react";
import { Loader2, FileText, Users, AlertTriangle } from "lucide-react";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import { useBillingAccount } from "@/hooks/use-api";
import { formatPersonName, formatCurrency } from "@/lib/utils";
// Same module the group portal imports it from — type-only Prisma import,
// so it is client-safe.
import { formatSerialId } from "@/lib/registration-serial";

/**
 * What a payer is covering, broken down per event: the people, the invoices
 * raised, and what has actually been paid.
 *
 * All money arrives pre-computed from the server (`events[].totals`) rather
 * than being re-derived here — "paid" in particular cannot be worked out from
 * the registration rows, because a group is settled by ONE payment covering
 * many of them. Re-deriving it in the browser is exactly how the two surfaces
 * would end up disagreeing.
 *
 * Optionally scoped to a single event (`eventId`), which is how the same view
 * answers the organiser's question — "is this sponsor paid up for MY event?" —
 * without them leaving the event.
 */

interface PayerEventTotals {
  currency: string | null;
  mixedCurrency: boolean;
  invoiced: number | null;
  credited: number | null;
  paid: number | null;
  refunded: number | null;
  outstanding: number | null;
}

interface PayerEventRow {
  eventId: string;
  eventName: string;
  eventStartDate: string | null;
  attachedOnly: boolean;
  registrations: Array<{
    id: string;
    serialId: number | null;
    status: string;
    paymentStatus: string;
    groupId: string | null;
    originalPrice: number | string | null;
    attendee: { firstName: string; lastName: string; email: string } | null;
    ticketType: { name: string } | null;
  }>;
  invoices: Array<{
    id: string;
    invoiceNumber: string;
    type: string;
    status: string;
    total: number | string;
    currency: string;
    issueDate: string;
    groupId: string | null;
  }>;
  totals: PayerEventTotals;
}

const INVOICE_STATUS_TONE: Record<string, string> = {
  PAID: "bg-emerald-100 text-emerald-800",
  SENT: "bg-sky-100 text-sky-800",
  OVERDUE: "bg-red-100 text-red-800",
  DRAFT: "bg-slate-100 text-slate-700",
  CANCELLED: "bg-slate-100 text-slate-500 line-through",
  REFUNDED: "bg-amber-100 text-amber-800",
};

function Money({ value, currency }: { value: number | null; currency: string | null }) {
  if (value === null) return <span className="text-muted-foreground">—</span>;
  return <span className="tabular-nums">{formatCurrency(value, currency ?? "USD")}</span>;
}

export function PayerDetailDialog({
  payer,
  onClose,
  eventId,
}: {
  payer: { id: string; name: string } | null;
  onClose: () => void;
  /** Narrow the view to one event (the in-event entry point). */
  eventId?: string;
}) {
  const { data, isLoading, isError } = useBillingAccount(payer?.id ?? "") as {
    data: { events?: PayerEventRow[] } | undefined;
    isLoading: boolean;
    isError: boolean;
  };

  const events = useMemo(() => {
    const all = data?.events ?? [];
    return eventId ? all.filter((e) => e.eventId === eventId) : all;
  }, [data, eventId]);

  return (
    <Dialog open={!!payer} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-4xl">
        <DialogHeader>
          <DialogTitle>{payer?.name ?? "Payer"}</DialogTitle>
        </DialogHeader>

        {isLoading ? (
          <div className="flex items-center justify-center py-12 text-muted-foreground">
            <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Loading…
          </div>
        ) : isError ? (
          <div className="flex items-start gap-2 rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-800">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
            <span>
              Couldn&apos;t load this payer&apos;s activity. Nothing is wrong
              with the records — please try again.
            </span>
          </div>
        ) : events.length === 0 ? (
          <p className="py-10 text-center text-sm text-muted-foreground">
            {eventId
              ? "This payer isn't covering anyone at this event yet."
              : "This payer has no registrations or invoices yet."}
          </p>
        ) : (
          <div className="space-y-5">
            {events.map((ev) => (
              <section key={ev.eventId} className="rounded-lg border">
                <header className="flex flex-wrap items-baseline justify-between gap-2 border-b bg-muted/30 px-4 py-3">
                  <div>
                    <h3 className="font-medium">{ev.eventName}</h3>
                    {ev.eventStartDate && (
                      <p className="text-xs text-muted-foreground">
                        {new Date(ev.eventStartDate).toLocaleDateString("en-GB", {
                          day: "numeric", month: "short", year: "numeric",
                        })}
                      </p>
                    )}
                  </div>
                  {ev.attachedOnly ? (
                    <Badge variant="outline">Nothing booked yet</Badge>
                  ) : ev.totals.mixedCurrency ? (
                    <Badge variant="outline" className="text-amber-700">
                      Mixed currencies — see invoices
                    </Badge>
                  ) : (
                    <div className="flex flex-wrap gap-x-5 gap-y-1 text-sm">
                      <span className="text-muted-foreground">
                        Invoiced <Money value={ev.totals.invoiced} currency={ev.totals.currency} />
                      </span>
                      <span className="text-muted-foreground">
                        Paid <Money value={ev.totals.paid} currency={ev.totals.currency} />
                      </span>
                      <span
                        className={
                          (ev.totals.outstanding ?? 0) > 0
                            ? "font-medium text-red-700"
                            : "font-medium text-emerald-700"
                        }
                      >
                        {(ev.totals.outstanding ?? 0) > 0 ? "Outstanding " : "Settled "}
                        {(ev.totals.outstanding ?? 0) !== 0 && (
                          <Money value={ev.totals.outstanding} currency={ev.totals.currency} />
                        )}
                      </span>
                    </div>
                  )}
                </header>

                {ev.totals.credited ? (
                  <p className="border-b px-4 py-2 text-xs text-muted-foreground">
                    Includes{" "}
                    <Money value={ev.totals.credited} currency={ev.totals.currency} /> in
                    credit notes
                    {ev.totals.refunded
                      ? <> and <Money value={ev.totals.refunded} currency={ev.totals.currency} /> refunded</>
                      : null}
                    .
                  </p>
                ) : null}

                {ev.registrations.length > 0 && (
                  <div className="px-4 py-3">
                    <h4 className="mb-2 flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                      <Users className="h-3.5 w-3.5" />
                      {ev.registrations.length}{" "}
                      {ev.registrations.length === 1 ? "registration" : "registrations"}
                    </h4>
                    <div className="overflow-x-auto">
                      <table className="w-full text-sm">
                        <tbody>
                          {ev.registrations.map((r) => (
                            <tr key={r.id} className="border-b last:border-0">
                              <td className="py-1.5 pr-3 tabular-nums text-muted-foreground">
                                {formatSerialId(r.serialId)}
                              </td>
                              <td className="py-1.5 pr-3">
                                <span
                                  className={
                                    r.status === "CANCELLED" ? "text-muted-foreground line-through" : ""
                                  }
                                >
                                  {r.attendee
                                    ? formatPersonName(null, r.attendee.firstName, r.attendee.lastName)
                                    : "—"}
                                </span>
                                {r.groupId && (
                                  <Badge variant="outline" className="ml-2 text-[10px]">Group</Badge>
                                )}
                                <div className="text-xs text-muted-foreground">
                                  {r.attendee?.email}
                                </div>
                              </td>
                              <td className="py-1.5 pr-3 text-muted-foreground">
                                {r.ticketType?.name ?? "—"}
                              </td>
                              <td className="py-1.5 pr-3">
                                <Badge variant="outline" className="text-[10px]">
                                  {r.paymentStatus}
                                </Badge>
                              </td>
                              <td className="py-1.5 text-right tabular-nums">
                                {r.originalPrice !== null && r.originalPrice !== undefined
                                  ? formatCurrency(
                                      Number(r.originalPrice),
                                      ev.totals.currency ?? "USD",
                                    )
                                  : "—"}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                )}

                {ev.invoices.length > 0 && (
                  <div className="border-t px-4 py-3">
                    <h4 className="mb-2 flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                      <FileText className="h-3.5 w-3.5" />
                      {ev.invoices.length}{" "}
                      {ev.invoices.length === 1 ? "document" : "documents"}
                    </h4>
                    <ul className="space-y-1.5">
                      {ev.invoices.map((inv) => (
                        <li key={inv.id} className="flex flex-wrap items-center gap-2 text-sm">
                          <span className="font-mono text-xs">{inv.invoiceNumber}</span>
                          {inv.type !== "INVOICE" && (
                            <Badge variant="outline" className="text-[10px]">
                              {inv.type === "CREDIT_NOTE" ? "Credit note" : "Receipt"}
                            </Badge>
                          )}
                          {inv.groupId && (
                            <Badge variant="outline" className="text-[10px]">Group</Badge>
                          )}
                          <Badge
                            className={`text-[10px] ${INVOICE_STATUS_TONE[inv.status] ?? "bg-slate-100 text-slate-700"}`}
                          >
                            {inv.status.toLowerCase()}
                          </Badge>
                          <span className="ml-auto tabular-nums">
                            {formatCurrency(Number(inv.total), inv.currency)}
                          </span>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </section>
            ))}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
