"use client";
/**
 * /procurement/requests: every spend request in the organisation (org staff
 * read), with a status strip that doubles as the filter (Approved counts both
 * forms of approved), "mine" and a search; the request grant adds "New request".
 */
import { useMemo, useState } from "react";
import Link from "next/link";
import { useSession } from "next-auth/react";
import { canRequestProcurement } from "@/lib/procurement-visibility";
import type { SpendRequestStatusValue } from "@/procurement/lib/spend-request-rules";
import { useSpendRequests } from "@/procurement/hooks/use-procurement-api";
import { ErrorState, LoadingState, fmtWhen, money2 } from "@/procurement/components/budget-ui";
import { BudgetCheckBadge, PriorityBadge, RequestStatusBadge } from "@/procurement/components/spend-request-ui";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ArrowLeft, FileText, Plus } from "lucide-react";

const ALL = "ALL";
/** "Approved" on the strip means approved in either form: waiting on its supplier or ready for an order. */
const STRIP: { key: string; label: string; statuses: SpendRequestStatusValue[] }[] = [
  { key: "DRAFT", label: "Draft", statuses: ["DRAFT"] },
  { key: "PENDING_APPROVAL", label: "Pending approval", statuses: ["PENDING_APPROVAL"] },
  { key: "APPROVED_ANY", label: "Approved", statuses: ["APPROVED", "AWAITING_SUPPLIER"] },
  { key: "CONVERTED", label: "Ordered", statuses: ["CONVERTED", "CLOSED"] },
  { key: "REJECTED", label: "Rejected", statuses: ["REJECTED"] },
  { key: "CANCELLED", label: "Cancelled", statuses: ["CANCELLED"] },
];

export default function SpendRequestsPage() {
  const { data: session } = useSession();
  const canRequest = canRequestProcurement(session?.user);
  const [strip, setStrip] = useState<string>(ALL);
  const [mine, setMine] = useState(false);
  const [search, setSearch] = useState("");
  // Fetched once, filtered here: the strip's counts and the rows come from the same list.
  const requests = useSpendRequests({ mine });

  const counts = useMemo(() => {
    const all = requests.data ?? [];
    return Object.fromEntries(STRIP.map((s) => [s.key, all.filter((r) => s.statuses.includes(r.status)).length]));
  }, [requests.data]);
  const rows = useMemo(() => {
    const q = search.trim().toLowerCase();
    const wanted = STRIP.find((s) => s.key === strip)?.statuses;
    return (requests.data ?? [])
      .filter((r) => !wanted || wanted.includes(r.status))
      .filter((r) => !q || r.requestNo.toLowerCase().includes(q) || r.title.toLowerCase().includes(q) || r.eventCode.toLowerCase().includes(q) || (r.requesterName ?? "").toLowerCase().includes(q));
  }, [requests.data, search, strip]);

  if (requests.isPending) return <LoadingState label="Loading spend requests…" />;
  if (requests.isError) return <ErrorState title="Couldn't load the spend requests" message={(requests.error as Error)?.message ?? ""} backHref="/procurement" backLabel="Budgets" />;

  const pending = (requests.data ?? []).filter((r) => r.status === "PENDING_APPROVAL").length;

  return (
    <div className="space-y-5">
      <div>
        <Link href="/procurement" className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
          <ArrowLeft className="h-4 w-4" /> Budgets
        </Link>
        <div className="mt-2 flex flex-wrap items-start justify-between gap-3">
          <div>
            <h1 className="flex items-center gap-2 text-2xl font-bold tracking-tight"><FileText className="h-6 w-6 text-primary" /> Spend requests</h1>
            <p className="mt-1 text-sm text-muted-foreground">{`${rows.length} shown${pending > 0 ? ` · ${pending} awaiting a decision` : ""}. A request is raised against a budget line, checked against what the line has left, and approved on the AED matrix.`}</p>
          </div>
          {canRequest && (
            <Button asChild><Link href="/procurement/requests/new"><Plus className="h-4 w-4" /> New request</Link></Button>
          )}
        </div>
      </div>

      <div className="flex flex-wrap gap-2">
        <Button size="sm" variant={strip === ALL ? "default" : "outline"} onClick={() => setStrip(ALL)}>{`All ${(requests.data ?? []).length}`}</Button>
        {STRIP.map((s) => (
          <Button key={s.key} size="sm" variant={strip === s.key ? "default" : "outline"} onClick={() => setStrip(strip === s.key ? ALL : s.key)}>{`${s.label} ${counts[s.key] ?? 0}`}</Button>
        ))}
      </div>

      <div className="flex flex-wrap items-end gap-3">
        <div className="w-64 space-y-1">
          <Label htmlFor="sr-search">Search</Label>
          <Input id="sr-search" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Number, title, event, requester" />
        </div>
        <div className="flex items-center gap-2 pb-2">
          <Switch id="sr-mine" checked={mine} onCheckedChange={setMine} />
          <Label htmlFor="sr-mine">Only mine</Label>
        </div>
      </div>

      {rows.length === 0 ? (
        <div className="rounded-lg border bg-card p-8 text-center text-sm text-muted-foreground">{canRequest ? "No spend requests yet. Raise the first one against an active budget." : "No spend requests yet."}</div>
      ) : (
        <div className="overflow-x-auto rounded-lg border bg-card">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Request</TableHead>
                <TableHead>Event</TableHead>
                <TableHead>Requested by</TableHead>
                <TableHead className="text-right">Amount, ex-VAT</TableHead>
                <TableHead>Budget check</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Order</TableHead>
                <TableHead>Raised</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((r) => (
                <TableRow key={r.id}>
                  <TableCell>
                    <Link href={`/procurement/requests/${r.id}`} className="font-medium hover:underline">{r.requestNo}</Link>
                    <div className="flex items-center gap-2 text-sm text-muted-foreground"><span className="truncate">{r.title}</span><PriorityBadge priority={r.priority} /></div>
                  </TableCell>
                  <TableCell>{r.budget ? `${r.budget.eventCode} · v${r.budget.versionNo}` : r.eventCode}</TableCell>
                  <TableCell>{r.requesterName ?? "Unknown"}</TableCell>
                  <TableCell className="text-right tabular-nums">{`${r.currency} ${money2(r.amount)}`}</TableCell>
                  <TableCell>{r.budgetCheckStatus === "NOT_CHECKED" ? <span className="text-xs text-muted-foreground">Not yet</span> : <BudgetCheckBadge status={r.budgetCheckStatus} />}</TableCell>
                  <TableCell><RequestStatusBadge status={r.status} /></TableCell>
                  <TableCell>
                    {r.order ? (
                      <div className="text-sm">
                        <div className="font-medium tabular-nums">{r.order.commitmentNo}</div>
                        <div className="text-xs text-muted-foreground">{r.order.status === "CANCELLED" ? "Cancelled" : r.order.fulfillmentLabel}{r.order.sentToSupplierAt ? " · sent" : ""}</div>
                      </div>
                    ) : (
                      <span className="text-xs text-muted-foreground">{r.status === "APPROVED" ? "To be issued" : "None"}</span>
                    )}
                  </TableCell>
                  <TableCell className="text-sm text-muted-foreground">{fmtWhen(r.createdAt)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  );
}
