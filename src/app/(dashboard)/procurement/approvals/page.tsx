"use client";

/**
 * /procurement/approvals: the inbox. "Waiting on me" lists the pending
 * requests whose step is assigned (or delegated) to the caller, each with
 * approve or reject and a note; "My requests" lists what the caller raised
 * and how it was decided. A decision is a conditional claim on the step, so
 * two approvers racing commit once and the second is told so.
 */

import { useState } from "react";
import Link from "next/link";
import { toast } from "sonner";
import { useApprovals, useDecideApproval, type ApprovalRequestRow } from "@/procurement/hooks/use-procurement-api";
import { ErrorState, LoadingState, StatusBadge, fmtWhen, money2 } from "@/procurement/components/budget-ui";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ArrowLeft, Check, Inbox, Loader2, X } from "lucide-react";

const REQUEST_STATUS_CLASS: Record<string, string> = {
  PENDING: "bg-amber-100 text-amber-900 dark:bg-amber-900 dark:text-amber-100",
  APPROVED: "bg-emerald-100 text-emerald-900 dark:bg-emerald-900 dark:text-emerald-100",
  REJECTED: "bg-red-100 text-red-900 dark:bg-red-900 dark:text-red-100",
  CANCELLED: "bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300",
};

export default function ApprovalsPage() {
  const inbox = useApprovals("inbox");
  const mine = useApprovals("mine");

  if (inbox.isLoading && mine.isLoading) return <LoadingState label="Loading approvals…" />;
  if (inbox.isError) return <ErrorState title="Couldn't load the approvals" message={(inbox.error as Error)?.message ?? "Try again."} backHref="/procurement" backLabel="Back to budgets" />;

  const waiting = inbox.data ?? [];
  const raised = mine.data ?? [];

  return (
    <div className="space-y-5">
      <div>
        <Link href="/procurement" className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
          <ArrowLeft className="h-4 w-4" /> Budgets
        </Link>
        <h1 className="mt-2 flex items-center gap-2 text-2xl font-bold tracking-tight">
          <Inbox className="h-6 w-6 text-primary" />
          Approvals
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">
          {`${waiting.length} waiting on you · ${raised.length} raised by you. A decision is taken here, never from an email; your ceiling is checked against the AED amount when you decide.`}
        </p>
      </div>

      <Tabs defaultValue="inbox">
        <TabsList>
          <TabsTrigger value="inbox">{`Waiting on me${waiting.length ? ` (${waiting.length})` : ""}`}</TabsTrigger>
          <TabsTrigger value="mine">My requests</TabsTrigger>
        </TabsList>
        <TabsContent value="inbox" className="space-y-3">
          {waiting.length === 0 && <Empty text="Nothing is waiting on you." />}
          {waiting.map((r) => <RequestCard key={r.id} r={r} decidable />)}
        </TabsContent>
        <TabsContent value="mine" className="space-y-3">
          {mine.isLoading && <div className="flex items-center gap-2 py-6 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" /> Loading…</div>}
          {!mine.isLoading && raised.length === 0 && <Empty text="You have not raised a request." />}
          {raised.map((r) => <RequestCard key={r.id} r={r} />)}
        </TabsContent>
      </Tabs>
    </div>
  );
}

function Empty({ text }: { text: string }) {
  return <div className="rounded-lg border bg-card p-8 text-center text-sm text-muted-foreground">{text}</div>;
}

function RequestCard({ r, decidable }: { r: ApprovalRequestRow; decidable?: boolean }) {
  const decide = useDecideApproval();
  const [note, setNote] = useState("");
  const [pending, setPending] = useState<"APPROVED" | "REJECTED" | null>(null);
  const subject = r.subjectType === "BUDGET" ? "Budget" : "Reallocation";
  const cur = r.currency ?? r.budget?.reportingCurrency ?? "";
  const step = r.steps.find((s) => s.status !== "PENDING") ?? r.steps[0];

  async function go(decision: "APPROVED" | "REJECTED") {
    setPending(decision);
    try {
      await decide.mutateAsync({ requestId: r.id, decision, note: note.trim() || null });
      toast.success(decision === "APPROVED" ? (r.subjectType === "BUDGET" ? "Approved. The budget is active." : "Approved. The amount is moved.") : "Rejected.");
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setPending(null);
    }
  }

  return (
    <div className="rounded-lg border bg-card p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant="secondary">{subject}</Badge>
            {r.budget ? (
              <Link href={`/procurement/budgets/${r.budget.id}`} className="font-medium hover:underline">{`${r.budget.eventCode} · v${r.budget.versionNo}`}</Link>
            ) : (
              <span className="font-medium text-muted-foreground">budget no longer exists</span>
            )}
            {r.budget?.event?.name && <span className="text-sm text-muted-foreground">{r.budget.event.name}</span>}
            {r.budget && <StatusBadge status={r.budget.status} />}
            {!decidable && <Badge variant="secondary" className={REQUEST_STATUS_CLASS[r.status] ?? ""}>{r.status.toLowerCase()}</Badge>}
          </div>
          <div className="text-sm">
            <span className="font-semibold tabular-nums">{`${cur} ${money2(r.amount ?? r.amountAed)}`}</span>
            {cur !== "AED" && <span className="text-muted-foreground tabular-nums">{` (AED ${money2(r.amountAed)} for the ceiling)`}</span>}
            {r.subjectType === "BUDGET" && <span className="text-muted-foreground"> planned, ex-VAT</span>}
          </div>
          {r.move && (
            <div className="text-sm text-muted-foreground">
              {`Move ${cur} ${money2(r.move.amount)} from "${r.move.fromDescription ?? r.move.fromLineKey}" to "${r.move.toDescription ?? r.move.toLineKey}".`}
            </div>
          )}
          {r.reason && <div className="text-sm"><span className="text-muted-foreground">Reason: </span>{r.reason}</div>}
          <div className="text-xs text-muted-foreground">
            {`Raised by ${r.requesterName ?? "someone no longer on the team"} · ${fmtWhen(r.createdAt)}${step?.assigneeName ? ` · assigned to ${step.assigneeName}` : ""}${r.decidedAt ? ` · decided ${fmtWhen(r.decidedAt)}` : ""}`}
          </div>
          {!decidable && step?.note && <div className="text-sm"><span className="text-muted-foreground">Decision note: </span>{step.note}</div>}
        </div>
        {decidable && (
          <div className="w-full space-y-2 sm:w-72">
            <Textarea rows={2} value={note} onChange={(e) => setNote(e.target.value)} placeholder="Note for the requester (optional)" />
            <div className="flex justify-end gap-2">
              <Button size="sm" variant="outline" className="text-destructive" onClick={() => void go("REJECTED")} disabled={decide.isPending}>
                {pending === "REJECTED" ? <Loader2 className="h-4 w-4 animate-spin" /> : <X className="h-4 w-4" />}
                Reject
              </Button>
              <Button size="sm" onClick={() => void go("APPROVED")} disabled={decide.isPending}>
                {pending === "APPROVED" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}
                Approve
              </Button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
