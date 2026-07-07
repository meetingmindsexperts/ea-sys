"use client";

import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Receipt, Download, FileText, FileSpreadsheet, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { useEvents } from "@/hooks/use-api";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

interface OrgInvoice {
  id: string;
  eventId: string;
  eventName: string;
  invoiceNumber: string;
  type: "INVOICE" | "RECEIPT" | "CREDIT_NOTE";
  status: "DRAFT" | "SENT" | "PAID" | "OVERDUE" | "CANCELLED" | "REFUNDED";
  issueDate: string;
  total: number;
  currency: string;
  billToName: string;
  billToEmail: string;
}

const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

const TYPE_LABEL: Record<OrgInvoice["type"], string> = {
  INVOICE: "Invoice",
  RECEIPT: "Receipt",
  CREDIT_NOTE: "Credit Note",
};
const TYPE_COLOR: Record<OrgInvoice["type"], string> = {
  INVOICE: "bg-sky-100 text-sky-800",
  RECEIPT: "bg-emerald-100 text-emerald-800",
  CREDIT_NOTE: "bg-amber-100 text-amber-800",
};
const STATUS_COLOR: Record<OrgInvoice["status"], string> = {
  DRAFT: "bg-slate-100 text-slate-700",
  SENT: "bg-blue-100 text-blue-800",
  PAID: "bg-green-100 text-green-800",
  OVERDUE: "bg-red-100 text-red-800",
  CANCELLED: "bg-slate-100 text-slate-500",
  REFUNDED: "bg-violet-100 text-violet-800",
};

function money(n: number, currency: string) {
  return new Intl.NumberFormat("en-US", { style: "currency", currency }).format(n);
}

export default function OrgInvoicesClient() {
  // Lazy once — avoids `new Date()` during render (react-hooks/purity) and a
  // per-render-changing memo dependency.
  const [currentYear] = useState(() => new Date().getFullYear());
  const [year, setYear] = useState("all");
  const [month, setMonth] = useState("all");
  const [eventId, setEventId] = useState("all");
  const [type, setType] = useState("all");

  const { data: events = [] } = useEvents();

  const query = useMemo(() => {
    const p = new URLSearchParams();
    if (year !== "all") p.set("year", year);
    if (month !== "all") p.set("month", month);
    if (eventId !== "all") p.set("eventId", eventId);
    if (type !== "all") p.set("type", type);
    return p.toString();
  }, [year, month, eventId, type]);

  const { data, isLoading, isError, error } = useQuery({
    queryKey: ["org-invoices", query],
    queryFn: async () => {
      const res = await fetch(`/api/invoices?${query}`);
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        const err = new Error(body.error || "Failed to load invoices") as Error & { status?: number };
        err.status = res.status;
        throw err;
      }
      return res.json() as Promise<{ invoices: OrgInvoice[]; earliestYear: number }>;
    },
  });

  const invoices = useMemo(() => data?.invoices ?? [], [data]);
  const earliestYear = data?.earliestYear ?? currentYear;
  const years = useMemo(() => {
    const out: number[] = [];
    for (let y = currentYear; y >= earliestYear; y--) out.push(y);
    return out;
  }, [earliestYear, currentYear]);

  // Totals for the current filter (per currency, so mixed-currency orgs are correct).
  const totals = useMemo(() => {
    const byCurrency = new Map<string, number>();
    for (const inv of invoices) {
      // Credit notes are money out — subtract so the net is honest.
      const signed = inv.type === "CREDIT_NOTE" ? -inv.total : inv.total;
      byCurrency.set(inv.currency, (byCurrency.get(inv.currency) ?? 0) + signed);
    }
    return [...byCurrency.entries()];
  }, [invoices]);

  const isForbidden = isError && (error as { status?: number })?.status === 403;

  function exportUrl(format: string) {
    const p = new URLSearchParams(query);
    p.set("format", format);
    return `/api/invoices/export?${p.toString()}`;
  }

  return (
    <div className="space-y-6 p-6">
      <div className="flex items-center justify-between gap-4 flex-wrap">
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-bold text-slate-900">
            <Receipt className="h-6 w-6 text-primary" /> Invoices
          </h1>
          <p className="text-sm text-muted-foreground">
            All invoices and credit notes across every event, filterable by month, year, and event.
          </p>
        </div>
        {!isForbidden && (
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" asChild disabled={invoices.length === 0}>
              <a href={exportUrl("pdf")}><Download className="mr-1.5 h-4 w-4" /> PDFs (ZIP)</a>
            </Button>
            <Button variant="outline" size="sm" asChild disabled={invoices.length === 0}>
              <a href={exportUrl("csv")}><FileSpreadsheet className="mr-1.5 h-4 w-4" /> CSV</a>
            </Button>
            <Button variant="outline" size="sm" asChild disabled={invoices.length === 0}>
              <a href={exportUrl("quickbooks")}><FileText className="mr-1.5 h-4 w-4" /> QuickBooks</a>
            </Button>
          </div>
        )}
      </div>

      {isForbidden ? (
        <div className="rounded-xl border border-amber-200 bg-amber-50 px-5 py-4 text-sm text-amber-800">
          You don&rsquo;t have access to invoices. This area is limited to finance roles (Admin / Organizer).
        </div>
      ) : (
        <>
          {/* Filters */}
          <div className="flex flex-wrap items-center gap-3 rounded-xl border border-slate-200 bg-white px-4 py-3">
            <Select
              value={year}
              onValueChange={(v) => {
                setYear(v);
                // A month is only meaningful within a year — clearing the year
                // clears the month so we never filter a month across all years.
                if (v === "all") setMonth("all");
              }}
            >
              <SelectTrigger className="w-[130px]"><SelectValue placeholder="Year" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All years</SelectItem>
                {years.map((y) => <SelectItem key={y} value={String(y)}>{y}</SelectItem>)}
              </SelectContent>
            </Select>
            <Select
              value={month}
              onValueChange={(v) => {
                if (v !== "all" && year === "all") {
                  toast.error("Select a year first, then choose a month.");
                  return;
                }
                setMonth(v);
              }}
            >
              <SelectTrigger className="w-[150px]"><SelectValue placeholder="Month" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All months</SelectItem>
                {MONTHS.map((m, i) => <SelectItem key={m} value={String(i + 1)}>{m}</SelectItem>)}
              </SelectContent>
            </Select>
            <Select value={eventId} onValueChange={setEventId}>
              <SelectTrigger className="w-[220px]"><SelectValue placeholder="Event" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All events</SelectItem>
                {events.map((e: { id: string; name: string }) => (
                  <SelectItem key={e.id} value={e.id}>{e.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select value={type} onValueChange={setType}>
              <SelectTrigger className="w-[160px]"><SelectValue placeholder="Type" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All types</SelectItem>
                <SelectItem value="INVOICE">Invoices</SelectItem>
                <SelectItem value="CREDIT_NOTE">Credit Notes</SelectItem>
                <SelectItem value="RECEIPT">Receipts</SelectItem>
              </SelectContent>
            </Select>
            {totals.length > 0 && (
              <div className="ml-auto text-sm text-slate-600">
                <span className="font-medium">{invoices.length}</span> document{invoices.length === 1 ? "" : "s"} ·{" "}
                {totals.map(([cur, amt], i) => (
                  <span key={cur} className="font-semibold text-slate-900">
                    {i > 0 ? " · " : ""}{money(amt, cur)}
                  </span>
                ))}
              </div>
            )}
          </div>

          {/* Table */}
          <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white">
            <table className="w-full text-sm">
              <thead className="border-b border-slate-200 bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
                <tr>
                  <th className="px-4 py-3 font-semibold">Invoice #</th>
                  <th className="px-4 py-3 font-semibold">Event</th>
                  <th className="px-4 py-3 font-semibold">Bill-to</th>
                  <th className="px-4 py-3 font-semibold">Type</th>
                  <th className="px-4 py-3 font-semibold">Status</th>
                  <th className="px-4 py-3 font-semibold">Issued</th>
                  <th className="px-4 py-3 font-semibold text-right">Total</th>
                  <th className="px-4 py-3 font-semibold text-right">PDF</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {isLoading ? (
                  <tr><td colSpan={8} className="px-4 py-10 text-center text-muted-foreground">
                    <Loader2 className="mx-auto h-5 w-5 animate-spin" />
                  </td></tr>
                ) : invoices.length === 0 ? (
                  <tr><td colSpan={8} className="px-4 py-10 text-center text-muted-foreground">
                    No invoices match these filters.
                  </td></tr>
                ) : (
                  invoices.map((inv) => (
                    <tr key={inv.id} className="hover:bg-slate-50">
                      <td className="px-4 py-3 font-mono font-medium text-slate-900">{inv.invoiceNumber}</td>
                      <td className="px-4 py-3 text-slate-700">{inv.eventName}</td>
                      <td className="px-4 py-3">
                        <div className="font-medium text-slate-800">{inv.billToName}</div>
                        <div className="text-xs text-muted-foreground">{inv.billToEmail}</div>
                      </td>
                      <td className="px-4 py-3">
                        <Badge className={TYPE_COLOR[inv.type]} variant="outline">{TYPE_LABEL[inv.type]}</Badge>
                      </td>
                      <td className="px-4 py-3">
                        <Badge className={STATUS_COLOR[inv.status]} variant="outline">{inv.status}</Badge>
                      </td>
                      <td className="px-4 py-3 text-slate-600">
                        {new Date(inv.issueDate).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" })}
                      </td>
                      <td className="px-4 py-3 text-right font-medium tabular-nums text-slate-900">
                        {inv.type === "CREDIT_NOTE" ? "−" : ""}{money(inv.total, inv.currency)}
                      </td>
                      <td className="px-4 py-3 text-right">
                        <a
                          href={`/api/events/${inv.eventId}/invoices/${inv.id}/pdf`}
                          className="inline-flex items-center text-primary hover:underline"
                          target="_blank" rel="noopener noreferrer"
                        >
                          <Download className="h-4 w-4" />
                        </a>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}
