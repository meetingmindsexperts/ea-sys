"use client";

import { useState } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import { useSession } from "next-auth/react";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Receipt, FileText, Download, Send, Search, Loader2, Lock, FileArchive } from "lucide-react";
import { toast } from "sonner";
import {
  useEvent,
  useInvoices,
  useRegistrations,
  useResendInvoice,
  type InvoiceListItem,
} from "@/hooks/use-api";
import { canViewFinance } from "@/lib/finance-visibility";
import { canWrite } from "@/lib/can-write";
import { ReloadingSpinner } from "@/components/ui/reloading-spinner";

const INVOICE_TYPE_LABELS: Record<string, string> = {
  INVOICE: "Invoice",
  RECEIPT: "Receipt",
  CREDIT_NOTE: "Credit Note",
};

const INVOICE_STATUS_STYLES: Record<string, string> = {
  PAID: "border-emerald-200 bg-emerald-50 text-emerald-700",
  SENT: "border-blue-200 bg-blue-50 text-blue-700",
  OVERDUE: "border-red-200 bg-red-50 text-red-700",
  DRAFT: "border-slate-200 bg-slate-50 text-slate-600",
  CANCELLED: "border-slate-200 bg-slate-50 text-slate-500",
  REFUNDED: "border-amber-200 bg-amber-50 text-amber-700",
};

function money(currency: string, amount: number): string {
  return `${currency} ${amount.toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

/** Sum amounts grouped by currency (events are usually single-currency, but
 *  don't silently add USD + EUR). Returns e.g. "USD 1,200.00 · EUR 300.00". */
function sumByCurrency(items: { currency: string; total: number }[]): string {
  const map = new Map<string, number>();
  for (const it of items) map.set(it.currency, (map.get(it.currency) ?? 0) + it.total);
  const entries = [...map.entries()].filter(([, v]) => v > 0);
  if (entries.length === 0) return "—";
  return entries.map(([c, v]) => money(c, v)).join(" · ");
}

type QuoteReg = {
  id: string;
  serialId?: number | null;
  paymentStatus: string;
  attendee: { firstName: string; lastName: string; email: string };
  ticketType?: { name: string; price: string; currency: string; isFaculty?: boolean } | null;
  pricingTier?: { name: string; price: string; currency: string } | null;
};

function regNumber(r: { serialId?: number | null; id: string }): string {
  return r.serialId != null ? String(r.serialId).padStart(3, "0") : r.id.slice(-8).toUpperCase();
}

async function openPdf(url: string) {
  try {
    const res = await fetch(url);
    if (!res.ok) {
      const d = await res.json().catch(() => ({}));
      toast.error(d.error || "Session expired or download failed. Try again.");
      return;
    }
    const blob = await res.blob();
    const objectUrl = URL.createObjectURL(blob);
    window.open(objectUrl, "_blank");
    setTimeout(() => URL.revokeObjectURL(objectUrl), 60_000);
  } catch {
    toast.error("Download failed");
  }
}

export default function EventInvoicesPage() {
  const params = useParams();
  const eventId = params.eventId as string;
  const { data: session } = useSession();
  const role = session?.user?.role;
  const canFinance = canViewFinance(role);
  const canWriteFinance = canWrite(role);

  const { data: event } = useEvent(eventId);
  const { data: invoices = [], isLoading: invoicesLoading } = useInvoices(eventId);
  const { data: registrations = [], isLoading: regsLoading } = useRegistrations(eventId);
  const resend = useResendInvoice(eventId);

  const [invSearch, setInvSearch] = useState("");
  const [invType, setInvType] = useState("all");
  const [invStatus, setInvStatus] = useState("all");
  const [quoteSearch, setQuoteSearch] = useState("");
  const [resendingId, setResendingId] = useState<string | null>(null);
  const [zipDownloading, setZipDownloading] = useState(false);

  if (!canFinance) {
    return (
      <Card>
        <CardContent className="py-16 text-center">
          <Lock className="mx-auto mb-3 h-10 w-10 text-muted-foreground" />
          <p className="text-muted-foreground">Financial data is not available to your role.</p>
        </CardContent>
      </Card>
    );
  }

  const q = invSearch.trim().toLowerCase();
  const filteredInvoices = (invoices as InvoiceListItem[]).filter(
    (inv) =>
      (invType === "all" || inv.type === invType) &&
      (invStatus === "all" || inv.status === invStatus) &&
      (!q ||
        inv.invoiceNumber.toLowerCase().includes(q) ||
        `${inv.registration?.attendee.firstName ?? ""} ${inv.registration?.attendee.lastName ?? ""}`
          .toLowerCase()
          .includes(q) ||
        (inv.registration?.attendee.email ?? "").toLowerCase().includes(q)),
  );

  const invAll = invoices as InvoiceListItem[];
  const kpiInvoiced = sumByCurrency(
    invAll.filter((i) => i.type === "INVOICE").map((i) => ({ currency: i.currency, total: Number(i.total) })),
  );
  const kpiPaid = sumByCurrency(
    invAll.filter((i) => i.status === "PAID").map((i) => ({ currency: i.currency, total: Number(i.total) })),
  );
  const kpiOutstanding = sumByCurrency(
    invAll
      .filter((i) => i.status === "SENT" || i.status === "OVERDUE")
      .map((i) => ({ currency: i.currency, total: Number(i.total) })),
  );

  const quoteRows = (registrations as QuoteReg[])
    .map((r) => {
      const price = Number(r.pricingTier?.price ?? r.ticketType?.price ?? 0);
      const currency = r.pricingTier?.currency ?? r.ticketType?.currency ?? "USD";
      return { r, price, currency };
    })
    .filter((x) => x.price > 0);
  const qq = quoteSearch.trim().toLowerCase();
  const filteredQuotes = quoteRows.filter(
    (x) =>
      !qq ||
      `${x.r.attendee.firstName} ${x.r.attendee.lastName}`.toLowerCase().includes(qq) ||
      x.r.attendee.email.toLowerCase().includes(qq) ||
      regNumber(x.r).toLowerCase().includes(qq),
  );

  const handleResend = async (id: string) => {
    setResendingId(id);
    try {
      await resend.mutateAsync(id);
      toast.success("Invoice re-sent");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to re-send invoice");
    } finally {
      setResendingId(null);
    }
  };

  // Bundle every invoice PDF matching the current TYPE/STATUS filter into a
  // ZIP (e.g. Status = Paid → all paid invoices in one download). Server-side
  // filter only — the free-text search box doesn't apply to the ZIP.
  const downloadAllPdfs = async () => {
    setZipDownloading(true);
    try {
      const p = new URLSearchParams();
      if (invType !== "all") p.set("type", invType);
      if (invStatus !== "all") p.set("status", invStatus);
      const res = await fetch(`/api/events/${eventId}/invoices/export?${p.toString()}`);
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        toast.error(d.error || "Export failed");
        return;
      }
      const blob = await res.blob();
      const objectUrl = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = objectUrl;
      a.download =
        res.headers.get("Content-Disposition")?.match(/filename="(.+)"/)?.[1] ||
        `invoices-${eventId}.zip`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(objectUrl), 60_000);
    } catch {
      toast.error("Export failed");
    } finally {
      setZipDownloading(false);
    }
  };

  const exportInvoicesCsv = () => {
    const rows = [
      ["Number", "Type", "Status", "Attendee", "Email", "Amount", "Currency", "Issued", "Sent"],
      ...filteredInvoices.map((i) => [
        i.invoiceNumber,
        INVOICE_TYPE_LABELS[i.type] ?? i.type,
        i.status,
        `${i.registration?.attendee.firstName ?? ""} ${i.registration?.attendee.lastName ?? ""}`.trim(),
        i.registration?.attendee.email ?? "",
        Number(i.total).toFixed(2),
        i.currency,
        new Date(i.issueDate).toLocaleDateString(),
        i.sentAt ? new Date(i.sentAt).toLocaleDateString() : "",
      ]),
    ];
    const csv = rows
      .map((r) => r.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(","))
      .join("\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = `invoices-${eventId}.csv`;
    link.click();
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="flex items-center gap-2 text-3xl font-bold">
          <Receipt className="h-8 w-8" />
          Invoices &amp; Quotes
        </h1>
        <p className="text-muted-foreground">
          All invoices, receipts, and quotes for {event?.name ?? "this event"} in one place.
        </p>
      </div>

      {/* KPI strip */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <KpiCard label="Invoices" value={String(invAll.length)} sub={`${quoteRows.length} quotes`} />
        <KpiCard label="Total invoiced" value={kpiInvoiced} />
        <KpiCard label="Paid" value={kpiPaid} accent="text-emerald-600" />
        <KpiCard label="Outstanding" value={kpiOutstanding} accent="text-amber-600" />
      </div>

      <Tabs defaultValue="invoices">
        <TabsList>
          <TabsTrigger value="invoices">Invoices ({invAll.length})</TabsTrigger>
          <TabsTrigger value="quotes">Quotes ({quoteRows.length})</TabsTrigger>
        </TabsList>

        {/* ── Invoices ─────────────────────────────────────────────────── */}
        <TabsContent value="invoices" className="space-y-3">
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
            <div className="relative w-full sm:max-w-xs">
              <Search className="absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                placeholder="Search number, name, email…"
                value={invSearch}
                onChange={(e) => setInvSearch(e.target.value)}
                className="pl-8"
              />
            </div>
            <Select value={invType} onValueChange={setInvType}>
              <SelectTrigger className="w-full sm:w-40"><SelectValue placeholder="Type" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All types</SelectItem>
                <SelectItem value="INVOICE">Invoice</SelectItem>
                <SelectItem value="RECEIPT">Receipt</SelectItem>
                <SelectItem value="CREDIT_NOTE">Credit Note</SelectItem>
              </SelectContent>
            </Select>
            <Select value={invStatus} onValueChange={setInvStatus}>
              <SelectTrigger className="w-full sm:w-40"><SelectValue placeholder="Status" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All statuses</SelectItem>
                <SelectItem value="DRAFT">Draft</SelectItem>
                <SelectItem value="SENT">Sent</SelectItem>
                <SelectItem value="PAID">Paid</SelectItem>
                <SelectItem value="OVERDUE">Overdue</SelectItem>
                <SelectItem value="CANCELLED">Cancelled</SelectItem>
                <SelectItem value="REFUNDED">Refunded</SelectItem>
              </SelectContent>
            </Select>
            <div className="flex items-center gap-2 sm:ml-auto">
              <Button
                variant="outline"
                size="sm"
                onClick={exportInvoicesCsv}
                disabled={filteredInvoices.length === 0}
              >
                <Download className="mr-2 h-4 w-4" /> Export CSV
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={downloadAllPdfs}
                disabled={zipDownloading || invAll.length === 0}
                title="Download all matching invoice PDFs (current type/status filter) as a ZIP"
              >
                {zipDownloading ? (
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                ) : (
                  <FileArchive className="mr-2 h-4 w-4" />
                )}
                Download PDFs
              </Button>
            </div>
          </div>

          {invoicesLoading ? (
            <div className="flex justify-center py-12"><ReloadingSpinner /></div>
          ) : filteredInvoices.length === 0 ? (
            <EmptyRow icon={<Receipt className="h-10 w-10" />} text="No invoices match your filters." />
          ) : (
            <div className="overflow-x-auto rounded-lg border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Number</TableHead>
                    <TableHead>Type</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Attendee</TableHead>
                    <TableHead className="text-right">Amount</TableHead>
                    <TableHead>Issued</TableHead>
                    <TableHead className="text-right">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {filteredInvoices.map((inv) => (
                    <TableRow key={inv.id}>
                      <TableCell className="font-mono text-xs">{inv.invoiceNumber}</TableCell>
                      <TableCell className="text-sm">{INVOICE_TYPE_LABELS[inv.type] ?? inv.type}</TableCell>
                      <TableCell>
                        <Badge variant="outline" className={INVOICE_STATUS_STYLES[inv.status] ?? ""}>
                          {inv.status}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-sm">
                        {inv.registration ? (
                          <div className="min-w-0">
                            <div className="truncate font-medium">
                              {inv.registration.attendee.firstName} {inv.registration.attendee.lastName}
                            </div>
                            <div className="truncate text-xs text-muted-foreground">
                              {inv.registration.attendee.email}
                            </div>
                          </div>
                        ) : (
                          <span className="text-muted-foreground">—</span>
                        )}
                      </TableCell>
                      <TableCell className="whitespace-nowrap text-right text-sm tabular-nums">
                        {money(inv.currency, Number(inv.total))}
                      </TableCell>
                      <TableCell className="whitespace-nowrap text-sm text-muted-foreground">
                        {new Date(inv.issueDate).toLocaleDateString()}
                      </TableCell>
                      <TableCell>
                        <div className="flex items-center justify-end gap-1">
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-8"
                            onClick={() => openPdf(`/api/events/${eventId}/invoices/${inv.id}/pdf`)}
                          >
                            <Download className="mr-1 h-3.5 w-3.5" /> PDF
                          </Button>
                          {canWriteFinance && (
                            <Button
                              variant="ghost"
                              size="sm"
                              className="h-8"
                              onClick={() => handleResend(inv.id)}
                              disabled={resendingId === inv.id}
                            >
                              {resendingId === inv.id ? (
                                <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
                              ) : (
                                <Send className="mr-1 h-3.5 w-3.5" />
                              )}
                              Resend
                            </Button>
                          )}
                        </div>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </TabsContent>

        {/* ── Quotes ───────────────────────────────────────────────────── */}
        <TabsContent value="quotes" className="space-y-3">
          <div className="relative w-full sm:max-w-xs">
            <Search className="absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              placeholder="Search name, email, reg #…"
              value={quoteSearch}
              onChange={(e) => setQuoteSearch(e.target.value)}
              className="pl-8"
            />
          </div>
          <p className="text-xs text-muted-foreground">
            Every priced registration has a proforma quote. Manage the underlying registration from{" "}
            <Link href={`/events/${eventId}/registrations`} className="text-primary hover:underline">
              Registrations
            </Link>
            .
          </p>

          {regsLoading ? (
            <div className="flex justify-center py-12"><ReloadingSpinner /></div>
          ) : filteredQuotes.length === 0 ? (
            <EmptyRow icon={<FileText className="h-10 w-10" />} text="No priced registrations found." />
          ) : (
            <div className="overflow-x-auto rounded-lg border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Reg #</TableHead>
                    <TableHead>Attendee</TableHead>
                    <TableHead>Registration type</TableHead>
                    <TableHead>Payment</TableHead>
                    <TableHead className="text-right">Amount</TableHead>
                    <TableHead className="text-right">Quote</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {filteredQuotes.map(({ r, price, currency }) => (
                    <TableRow key={r.id}>
                      <TableCell className="font-mono text-xs">{regNumber(r)}</TableCell>
                      <TableCell className="text-sm">
                        <div className="min-w-0">
                          <div className="truncate font-medium">
                            {r.attendee.firstName} {r.attendee.lastName}
                          </div>
                          <div className="truncate text-xs text-muted-foreground">{r.attendee.email}</div>
                        </div>
                      </TableCell>
                      <TableCell className="text-sm">{r.ticketType?.name ?? "—"}</TableCell>
                      <TableCell>
                        <Badge variant="outline">{r.paymentStatus}</Badge>
                      </TableCell>
                      <TableCell className="whitespace-nowrap text-right text-sm tabular-nums">
                        {money(currency, price)}
                      </TableCell>
                      <TableCell className="text-right">
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-8"
                          onClick={() => openPdf(`/api/events/${eventId}/registrations/${r.id}/quote`)}
                        >
                          <Download className="mr-1 h-3.5 w-3.5" /> Quote
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </TabsContent>
      </Tabs>
    </div>
  );
}

function KpiCard({ label, value, sub, accent }: { label: string; value: string; sub?: string; accent?: string }) {
  return (
    <Card>
      <CardContent className="p-5">
        <p className="text-sm font-medium text-muted-foreground">{label}</p>
        <p className={`mt-1 text-2xl font-bold tabular-nums ${accent ?? ""}`}>{value}</p>
        {sub && <p className="mt-0.5 text-xs text-muted-foreground">{sub}</p>}
      </CardContent>
    </Card>
  );
}

function EmptyRow({ icon, text }: { icon: React.ReactNode; text: string }) {
  return (
    <Card>
      <CardContent className="py-12 text-center text-muted-foreground">
        <div className="mx-auto mb-3 w-fit opacity-40">{icon}</div>
        <p>{text}</p>
      </CardContent>
    </Card>
  );
}
