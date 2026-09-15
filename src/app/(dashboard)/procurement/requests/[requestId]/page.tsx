"use client";
/**
 * /procurement/requests/[requestId]: one spend request. The figures, the
 * line it draws on, the quotes (edited on a draft), the approval trail, and
 * an action bar keyed on status: edit, attach a quote, submit and cancel on a
 * draft; withdraw while a decision is pending; change the amount once
 * approved. Approving happens on the Approvals page, never here.
 */
import { useRef, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useSession } from "next-auth/react";
import { toast } from "sonner";
import { canAdminProcurement, canApproveProcurement, canRequestProcurement, canSettleProcurement } from "@/lib/procurement-visibility";
import { AED_PEG_RATES } from "@/procurement/lib/money";
import { missingForSubmission } from "@/procurement/lib/spend-request-rules";
import { orderReadiness } from "@/procurement/lib/commitment-rules";
import {
  useAddQuote,
  useAmendSpendRequest,
  useCancelOrder,
  useConfirmReceipt,
  useRaiseOrder,
  useReceiveOrder,
  useRemoveQuote,
  useRemoveQuoteFile,
  useSendOrder,
  useSpendRequest,
  useSubmitSpendRequest,
  useSuppliers,
  useTransitionSpendRequest,
  useUploadQuoteFile,
  type CommitmentRow,
  type QuoteInput,
  type SpendRequestDetailRow,
} from "@/procurement/hooks/use-procurement-api";
import { SpendRequestForm } from "@/procurement/components/spend-request-form";
import { ErrorState, LoadingState, StatusBadge, fmtWhen, money2, signed2 } from "@/procurement/components/budget-ui";
import { BudgetCheckBadge, FulfillmentBadge, OrderStatusBadge, PRIORITY_LABEL, PriorityBadge, RequestStatusBadge, SOURCING_LABEL } from "@/procurement/components/spend-request-ui";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { ArrowLeft, Ban, Download, FileText, Loader2, Mail, PackageCheck, Paperclip, PencilLine, Plus, RotateCcw, Send, ShieldAlert, ShoppingCart, Star, Trash2, TriangleAlert } from "lucide-react";

const NONE = "__none__";

export default function SpendRequestPage() {
  const { requestId } = useParams<{ requestId: string }>();
  const { data: session } = useSession();
  const request = useSpendRequest(requestId);
  const [editing, setEditing] = useState(false);
  const [prompt, setPrompt] = useState<null | "submit" | "cancel" | "withdraw" | "amend" | "quote" | "raise">(null);

  if (request.isPending) return <LoadingState label="Loading the request…" />;
  if (request.isError || !request.data) return <ErrorState title="Couldn't load the request" message={(request.error as Error)?.message ?? "It may have been removed."} backHref="/procurement/requests" backLabel="Spend requests" />;

  const r = request.data;
  const me = session?.user?.id;
  const isRequester = me === r.requesterUserId;
  const canRequest = canRequestProcurement(session?.user);
  const isAdmin = canAdminProcurement(session?.user);
  const canSettle = canSettleProcurement(session?.user);
  const canApprove = canApproveProcurement(session?.user, 0);
  /** Approval issues the order by itself; this is the by-hand path after a failed conversion or a cancel. */
  const canRaiseOrder = orderReadiness(r).ready && (isAdmin || (isRequester && canRequest));
  const canEditDraft = r.status === "DRAFT" && (isRequester || isAdmin) && (canRequest || isAdmin);
  const canSubmit = r.status === "DRAFT" && isRequester && canRequest;
  const canWithdraw = r.status === "PENDING_APPROVAL" && isRequester && canRequest;
  const canCancel = ["DRAFT", "PENDING_APPROVAL", "APPROVED", "AWAITING_SUPPLIER"].includes(r.status) && !r.linkedCommitmentId && (isRequester ? canRequest : isAdmin);
  const canAmend = (r.status === "APPROVED" || r.status === "AWAITING_SUPPLIER") && isRequester && canRequest;
  const missing = r.status === "DRAFT" ? missingForSubmission(r) : [];
  const cur = r.currency;
  const rep = r.budget?.reportingCurrency ?? cur;

  if (editing) {
    return (
      <div className="space-y-5">
        <Header r={r} />
        <SpendRequestForm request={r} onSaved={() => { setEditing(false); }} onCancel={() => setEditing(false)} />
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <Header r={r} />
      <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_18rem]">
        <div className="space-y-5">
          <section className="grid gap-3 rounded-lg border bg-card p-4 sm:grid-cols-2">
            <Field k="Amount, ex-VAT" v={`${cur} ${money2(r.amount)}`} strong />
            <Field k="VAT" v={`${cur} ${money2(r.taxAmount)}`} />
            {cur !== rep && <Field k={`In ${rep}`} v={`${rep} ${money2(r.amountReporting)}${r.fxRateToReporting ? ` at ${r.fxRateToReporting}` : ""}`} />}
            {r.amountAed && <Field k="For the ceiling" v={`AED ${money2(r.amountAed)}`} />}
            <Field k="Vendor" v={r.supplier ? `${r.supplier.displayName}${r.supplier.approvalStatus !== "APPROVED" ? ` (supplier ${r.supplier.approvalStatus.toLowerCase()})` : ""}` : r.proposedVendorName ? `${r.proposedVendorName} (proposed, not on the supplier list)` : "Not given"} />
            <Field k="Needed by" v={r.neededBy ?? "Not given"} />
            <Field k="Sourcing" v={r.sourcingMethod ? SOURCING_LABEL[r.sourcingMethod] : "Not stated"} />
            <Field k="Priority" v={PRIORITY_LABEL[r.priority]} />
            {r.category && <Field k="Category" v={`${r.category.code} · ${r.category.name}`} />}
            <div className="sm:col-span-2">
              <div className="text-xs text-muted-foreground">Justification</div>
              <div className="mt-0.5 whitespace-pre-line text-sm">{r.justification ?? <span className="text-muted-foreground">None given.</span>}</div>
            </div>
          </section>

          <section className="rounded-lg border bg-card p-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h2 className="text-sm font-semibold">Budget line</h2>
              {r.budget && <Link href={`/procurement/budgets/${r.budget.id}`} className="text-sm text-primary hover:underline">{`${r.budget.eventCode} · v${r.budget.versionNo}`}</Link>}
            </div>
            {r.line ? (
              <dl className="mt-2 grid gap-x-6 gap-y-1 text-sm sm:grid-cols-2">
                <Field k="Line" v={`${r.line.category.code} · ${r.line.description}${r.line.isContingency ? " (contingency)" : ""}`} />
                <Field k="Planned" v={`${rep} ${money2(r.line.planned)}`} />
                <Field k="Committed" v={`${rep} ${money2(r.line.committedOpen)}`} />
                <Field k="Actual" v={`${rep} ${money2(r.line.actual)}`} />
                <Field k="Remaining now" v={`${rep} ${signed2(r.line.remaining)}`} strong />
                {r.budgetCheckStatus !== "NOT_CHECKED" && <div className="flex items-center gap-2"><span className="text-xs text-muted-foreground">Check at submit</span><BudgetCheckBadge status={r.budgetCheckStatus} /></div>}
              </dl>
            ) : (
              <p className="mt-2 text-sm text-muted-foreground">No line yet; a request needs one before it can be submitted.</p>
            )}
          </section>

          {r.order && <OrderSection r={r} order={r.order} me={me} isAdmin={isAdmin} canRequest={canRequest} canSettle={canSettle} canApprove={canApprove} />}

          <QuotesSection r={r} editable={canEditDraft} onAdd={() => setPrompt("quote")} />

          <ApprovalTrail r={r} />
        </div>

        <aside className="space-y-3 lg:sticky lg:top-4 lg:self-start">
          <div className="space-y-2 rounded-lg border bg-card p-4">
            <h2 className="text-sm font-semibold">Actions</h2>
            {r.status === "DRAFT" && (
              <>
                {missing.length > 0 && (
                  <div className="rounded-md bg-muted/60 p-2 text-xs text-muted-foreground">
                    <div className="font-medium text-foreground">Before it can be submitted:</div>
                    <ul className="mt-1 list-disc pl-4">{missing.map((m) => <li key={m}>{m}</li>)}</ul>
                  </div>
                )}
                {canSubmit && <Button className="w-full" onClick={() => setPrompt("submit")} disabled={missing.length > 0}><Send className="h-4 w-4" /> Submit for approval</Button>}
                {canEditDraft && <Button variant="outline" className="w-full" onClick={() => setEditing(true)}><PencilLine className="h-4 w-4" /> Edit</Button>}
                {canEditDraft && <Button variant="outline" className="w-full" onClick={() => setPrompt("quote")}><Plus className="h-4 w-4" /> Attach a quote</Button>}
                {!isRequester && !isAdmin && <Note>Only the person who raised it can change or submit a draft.</Note>}
              </>
            )}
            {r.status === "PENDING_APPROVAL" && (
              <>
                <Note>Waiting for a decision on the Approvals page{r.budgetCheckStatus === "OVER_BUDGET" || r.budgetCheckStatus === "FROZEN" ? ", as an over-budget exception for the final approver" : ""}.</Note>
                {canWithdraw && <Button variant="outline" className="w-full" onClick={() => setPrompt("withdraw")}><RotateCcw className="h-4 w-4" /> Withdraw</Button>}
              </>
            )}
            {r.status === "AWAITING_SUPPLIER" && !canRaiseOrder && <Note>Approved. The order is issued by itself the moment the supplier is approved on the Suppliers page.</Note>}
            {r.status === "APPROVED" && !canRaiseOrder && <Note>Approved. The purchase order is issued on approval; if it is missing here, the person who raised the request or an admin can raise it.</Note>}
            {canRaiseOrder && (
              <>
                <Note>{r.status === "AWAITING_SUPPLIER" ? "The supplier is approved now, but the order was not issued. Raise it here." : "Approved without an order (after a cancel, or a conversion that failed). Raise it here."}</Note>
                <Button className="w-full" onClick={() => setPrompt("raise")}><ShoppingCart className="h-4 w-4" /> Raise the purchase order</Button>
              </>
            )}
            {r.status === "CONVERTED" && r.order && <Note>{`Ordered as ${r.order.commitmentNo}. The order section shows where it stands; a change is cancel and re-issue.`}</Note>}
            {canAmend && <Button variant="outline" className="w-full" onClick={() => setPrompt("amend")}><PencilLine className="h-4 w-4" /> Change the amount</Button>}
            {canCancel && <Button variant="outline" className="w-full text-destructive" onClick={() => setPrompt("cancel")}><Ban className="h-4 w-4" /> Cancel request</Button>}
            {r.status === "REJECTED" && <Note>{`Rejected${r.decidedByName ? ` by ${r.decidedByName}` : ""}${r.decisionNote ? `: ${r.decisionNote}` : "."} Raise a new request if the need stands.`}</Note>}
            {r.status === "CANCELLED" && <Note>{`Cancelled${r.cancelReason ? `: ${r.cancelReason}` : "."}`}</Note>}
          </div>
          <div className="rounded-lg border bg-card p-4 text-xs text-muted-foreground">
            <div>{`Raised by ${r.requesterName ?? "someone no longer on the team"} · ${fmtWhen(r.createdAt)}`}</div>
            {r.submittedAt && <div>{`Submitted ${fmtWhen(r.submittedAt)}`}</div>}
            {r.decidedAt && <div>{`Decided ${fmtWhen(r.decidedAt)}${r.decidedByName ? ` by ${r.decidedByName}` : ""}`}</div>}
          </div>
        </aside>
      </div>

      {prompt === "submit" && <SubmitDialog r={r} onClose={() => setPrompt(null)} />}
      {(prompt === "cancel" || prompt === "withdraw") && <TransitionDialog r={r} action={prompt} onClose={() => setPrompt(null)} />}
      {prompt === "amend" && <AmendDialog r={r} onClose={() => setPrompt(null)} />}
      {prompt === "quote" && <QuoteDialog r={r} onClose={() => setPrompt(null)} />}
      {prompt === "raise" && <RaiseOrderDialog r={r} onClose={() => setPrompt(null)} />}
    </div>
  );
}

function RaiseOrderDialog({ r, onClose }: { r: SpendRequestDetailRow; onClose: () => void }) {
  const raise = useRaiseOrder(r.id);
  async function go() {
    try {
      const c = await raise.mutateAsync();
      toast.success(`Purchase order ${c.commitmentNo} issued.${c.sentToSupplierAt ? " Sent to the supplier." : ""}`);
      onClose();
    } catch (err) {
      toast.error((err as Error).message);
    }
  }
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Raise the purchase order</DialogTitle>
          <DialogDescription>{`A PO number is taken, ${r.currency} ${money2(r.amount)} ex-VAT is committed on the line, and the request becomes the order.${r.emailSupplierOnIssue ? " The PDF is emailed to the supplier's contact at once, as the request asked." : " The PDF is sent when someone clicks Send on the order."}`}</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={raise.isPending}>Not yet</Button>
          <Button onClick={() => void go()} disabled={raise.isPending}>{raise.isPending && <Loader2 className="h-4 w-4 animate-spin" />} Raise the order</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function OrderSection({ r, order: o, me, isAdmin, canRequest, canSettle, canApprove }: { r: SpendRequestDetailRow; order: CommitmentRow; me: string | undefined; isAdmin: boolean; canRequest: boolean; canSettle: boolean; canApprove: boolean }) {
  const send = useSendOrder(o.id);
  const receive = useReceiveOrder(o.id);
  const confirm = useConfirmReceipt(o.id);
  const cancel = useCancelOrder(o.id);
  const [prompt, setPrompt] = useState<null | "receive" | "cancel">(null);
  const [extent, setExtent] = useState<"PARTIAL" | "FULL">("FULL");
  const [reason, setReason] = useState("");
  const isRequester = me === r.requesterUserId;
  const actsOnOrder = isAdmin || canSettle || (isRequester && canRequest);
  const live = o.status === "APPROVED";
  const canReceive = live && actsOnOrder && o.fulfillmentStatus !== "RECEIVED";
  const awaitingSecond = live && o.fulfillmentStatus === "RECEIVED" && o.receiptNeedsSecondPerson && !o.receiptConfirmed;
  const canConfirm = awaitingSecond && (canSettle || canApprove) && me !== o.receivedByUserId;
  const canCancelOrder = live && (canSettle || isAdmin);
  const hasEmail = o.supplier.contactEmails.length > 0;
  const cur = o.currency;
  const rep = o.budget?.reportingCurrency ?? cur;

  async function run<T>(m: { mutateAsync: () => Promise<T> } | { mutateAsync: (input: never) => Promise<T> }, input: unknown, ok: (v: T) => string, after?: () => void) {
    try {
      const v = await (m as { mutateAsync: (i: unknown) => Promise<T> }).mutateAsync(input);
      toast.success(ok(v));
      after?.();
    } catch (err) {
      toast.error((err as Error).message);
    }
  }

  return (
    <section className="rounded-lg border bg-card p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="flex items-center gap-2 text-sm font-semibold"><ShoppingCart className="h-4 w-4 text-primary" /> {`Purchase order ${o.commitmentNo}`}</h2>
        <div className="flex flex-wrap items-center gap-2">
          <OrderStatusBadge status={o.status} />
          {live && <FulfillmentBadge status={o.fulfillmentStatus} />}
          {awaitingSecond && <Badge variant="secondary" className="bg-amber-100 text-amber-900 dark:bg-amber-900 dark:text-amber-100">Needs a second person</Badge>}
        </div>
      </div>
      <dl className="mt-3 grid gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
        <Field k="Amount, ex-VAT" v={`${cur} ${money2(o.amount)}`} strong />
        <Field k="VAT" v={`${cur} ${money2(o.taxAmount)}`} />
        {cur !== rep && <Field k={`Committed in ${rep}`} v={`${rep} ${money2(o.amountReporting)} at ${o.fxRateToReporting}`} />}
        <Field k="Issued" v={`${fmtWhen(o.approvedAt)}`} />
        <Field k="Supplier" v={`${o.supplier.displayName} (${o.supplier.code})`} />
        <Field k="Sent to supplier" v={o.sentToSupplierAt ? fmtWhen(o.sentToSupplierAt) : hasEmail ? "Not yet" : "Not yet; the supplier has no contact email"} />
        {o.receivedAt && <Field k="Received" v={fmtWhen(o.receivedAt)} />}
        {o.fulfillmentStatus === "PARTIALLY_RECEIVED" && <Field k="Received" v="Partly" />}
        {o.receiptNeedsSecondPerson && o.fulfillmentStatus === "RECEIVED" && <Field k="Second person" v={o.receiptConfirmedAt ? `Confirmed ${fmtWhen(o.receiptConfirmedAt)}` : "Awaiting confirmation (above AED 50,000)"} />}
        {o.status === "CANCELLED" && <Field k="Cancelled" v={`${o.cancelledAt ? fmtWhen(o.cancelledAt) : ""}${o.cancelReason ? ` · ${o.cancelReason}` : ""}`} />}
      </dl>
      {o.lines.length > 0 && (
        <ul className="mt-3 divide-y rounded-md border text-sm">
          {o.lines.map((l) => (
            <li key={l.id} className="flex items-center justify-between gap-2 px-3 py-1.5">
              <span>{l.description}{Number(l.qty) !== 1 ? ` · ${l.qty} × ${money2(l.unitCost)}` : ""}{l.taxRatePercent ? ` · VAT ${l.taxRatePercent}%` : ""}</span>
              <span className="tabular-nums">{`${cur} ${money2(l.amount)}`}</span>
            </li>
          ))}
        </ul>
      )}
      <div className="mt-3 flex flex-wrap gap-2">
        <Button asChild size="sm" variant="outline"><a href={`/api/procurement/commitments/${o.id}/pdf`} target="_blank" rel="noreferrer"><Download className="h-4 w-4" /> PDF</a></Button>
        {live && actsOnOrder && (
          <Button size="sm" variant="outline" disabled={!hasEmail || send.isPending} title={hasEmail ? undefined : "Add a contact email on the Suppliers page first"} onClick={() => void run(send, undefined, () => `Sent to ${o.supplier.contactEmails.map((c) => c.email).join(", ")}.`)}>
            {send.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Mail className="h-4 w-4" />} {o.sentToSupplierAt ? "Send again" : "Send to supplier"}
          </Button>
        )}
        {canReceive && <Button size="sm" variant="outline" onClick={() => { setExtent("FULL"); setPrompt("receive"); }}><PackageCheck className="h-4 w-4" /> Mark received</Button>}
        {canConfirm && <Button size="sm" onClick={() => void run(confirm, { expectedVersion: o.version }, () => "Receipt confirmed.")} disabled={confirm.isPending}>{confirm.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <PackageCheck className="h-4 w-4" />} Confirm receipt</Button>}
        {canCancelOrder && <Button size="sm" variant="outline" className="text-destructive" onClick={() => setPrompt("cancel")}><Ban className="h-4 w-4" /> Cancel order</Button>}
      </div>
      {awaitingSecond && !canConfirm && <p className="mt-2 text-xs text-muted-foreground">{me === o.receivedByUserId ? "You marked it received; a second person (the settle holder or an approver) confirms it." : "The settle holder or an approver confirms the receipt."}</p>}

      {prompt === "receive" && (
        <Dialog open onOpenChange={(v) => !v && setPrompt(null)}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Mark the order received</DialogTitle>
              <DialogDescription>{o.receiptNeedsSecondPerson ? "Above AED 50,000 a full receipt is confirmed by a second person, the settle holder or an approver, before it counts." : "Below AED 50,000 your mark is the receipt."}</DialogDescription>
            </DialogHeader>
            <div className="space-y-2">
              <Label htmlFor="rc-extent">How much arrived</Label>
              <Select value={extent} onValueChange={(v) => setExtent(v as "PARTIAL" | "FULL")}>
                <SelectTrigger id="rc-extent" className="w-full"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="FULL">Everything</SelectItem>
                  <SelectItem value="PARTIAL">Part of it</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => setPrompt(null)} disabled={receive.isPending}>Not yet</Button>
              <Button onClick={() => void run(receive, { extent, expectedVersion: o.version }, (c) => (extent === "FULL" ? (c.receiptNeedsSecondPerson ? "Marked received; a second person confirms it." : "Marked received.") : "Marked partly received."), () => setPrompt(null))} disabled={receive.isPending}>
                {receive.isPending && <Loader2 className="h-4 w-4 animate-spin" />} Record
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
      {prompt === "cancel" && (
        <Dialog open onOpenChange={(v) => !v && setPrompt(null)}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Cancel the purchase order</DialogTitle>
              <DialogDescription>{`${rep} ${money2(o.amountReporting)} is released on the line and the request goes back to approved, so it can be re-issued or cancelled in its turn. Tell the supplier yourself; nothing is emailed.`}</DialogDescription>
            </DialogHeader>
            <div className="space-y-1">
              <Label htmlFor="oc-reason">Reason</Label>
              <Textarea id="oc-reason" rows={3} value={reason} onChange={(e) => setReason(e.target.value)} />
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => setPrompt(null)} disabled={cancel.isPending}>Keep it</Button>
              <Button variant="destructive" onClick={() => void run(cancel, { reason: reason.trim(), expectedVersion: o.version }, () => "Order cancelled; the request is back to approved.", () => setPrompt(null))} disabled={cancel.isPending || !reason.trim()}>
                {cancel.isPending && <Loader2 className="h-4 w-4 animate-spin" />} Cancel order
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
    </section>
  );
}

function Header({ r }: { r: SpendRequestDetailRow }) {
  return (
    <div>
      <Link href="/procurement/requests" className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
        <ArrowLeft className="h-4 w-4" /> Spend requests
      </Link>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <h1 className="flex items-center gap-2 text-2xl font-bold tracking-tight"><FileText className="h-6 w-6 text-primary" /> {r.requestNo}</h1>
        <RequestStatusBadge status={r.status} />
        <PriorityBadge priority={r.priority} />
        {(r.budgetCheckStatus === "OVER_BUDGET" || r.budgetCheckStatus === "FROZEN") && <Badge variant="secondary" className="bg-red-100 text-red-900 dark:bg-red-900 dark:text-red-100"><ShieldAlert className="mr-1 h-3 w-3" /> Exception</Badge>}
        {r.budget && <StatusBadge status={r.budget.status} />}
      </div>
      <p className="mt-1 text-lg">{r.title}</p>
      <p className="text-sm text-muted-foreground">{r.budget ? `${r.budget.eventCode} · v${r.budget.versionNo}${r.budget.event?.name ? ` · ${r.budget.event.name}` : ""}` : r.eventCode}</p>
    </div>
  );
}

function Field({ k, v, strong }: { k: string; v: string; strong?: boolean }) {
  return (
    <div>
      <div className="text-xs text-muted-foreground">{k}</div>
      <div className={`mt-0.5 text-sm tabular-nums ${strong ? "font-semibold" : ""}`}>{v}</div>
    </div>
  );
}

function Note({ children }: { children: React.ReactNode }) {
  return <p className="text-xs text-muted-foreground">{children}</p>;
}

function QuotesSection({ r, editable, onAdd }: { r: SpendRequestDetailRow; editable: boolean; onAdd: () => void }) {
  const remove = useRemoveQuote(r.id);
  const upload = useUploadQuoteFile(r.id);
  const removeFile = useRemoveQuoteFile(r.id);
  const fileInput = useRef<HTMLInputElement>(null);
  const [target, setTarget] = useState<string | null>(null);
  async function del(id: string) {
    try {
      await remove.mutateAsync(id);
      toast.success("Quote removed.");
    } catch (err) {
      toast.error((err as Error).message);
    }
  }
  function pickFile(quoteId: string) {
    setTarget(quoteId);
    fileInput.current?.click();
  }
  async function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    e.target.value = "";
    if (!f || !target) return;
    try {
      await upload.mutateAsync({ quoteId: target, file: f });
      toast.success("File attached.");
    } catch (err) {
      toast.error((err as Error).message);
    }
  }
  async function dropFile(quoteId: string) {
    try {
      await removeFile.mutateAsync(quoteId);
      toast.success("File removed.");
    } catch (err) {
      toast.error((err as Error).message);
    }
  }
  return (
    <section className="rounded-lg border bg-card p-4">
      <input ref={fileInput} type="file" accept="application/pdf,image/png,image/jpeg" className="hidden" onChange={(e) => void onFile(e)} />
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-semibold">{`Quotes (${r.quotes.length})`}</h2>
        {editable && <Button size="sm" variant="outline" onClick={onAdd}><Plus className="h-4 w-4" /> Attach a quote</Button>}
      </div>
      {r.quotes.length === 0 ? (
        <p className="mt-2 text-sm text-muted-foreground">No quotes attached. At least one is needed to submit.</p>
      ) : (
        <ul className="mt-2 divide-y">
          {r.quotes.map((q) => (
            <li key={q.id} className="flex flex-wrap items-start justify-between gap-2 py-2 text-sm">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium">{q.vendorName}</span>
                  {q.recommended && <Badge variant="secondary" className="bg-emerald-100 text-emerald-900 dark:bg-emerald-900 dark:text-emerald-100"><Star className="mr-1 h-3 w-3" /> Recommended</Badge>}
                  {q.supplier && q.supplier.approvalStatus !== "APPROVED" && <span className="text-xs text-muted-foreground">supplier {q.supplier.approvalStatus.toLowerCase()}</span>}
                </div>
                <div className="text-xs text-muted-foreground">
                  {`${q.currency} ${money2(q.amount)} ex-VAT${Number(q.taxAmount) > 0 ? ` · VAT ${money2(q.taxAmount)}` : ""}${q.quotedOn ? ` · quoted ${q.quotedOn}` : ""}${q.validUntil ? ` · valid until ${q.validUntil}` : ""}`}
                </div>
                {q.notes && <div className="mt-1 whitespace-pre-line text-xs">{q.notes}</div>}
                <div className="mt-1 flex flex-wrap items-center gap-2 text-xs">
                  {q.fileUrl ? (
                    <>
                      <a href={`/api/procurement/requests/${r.id}/quotes/${q.id}/file`} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-primary hover:underline"><Paperclip className="h-3 w-3" /> {q.fileName ?? "Quote file"}{q.fileSize ? ` (${Math.max(1, Math.round(q.fileSize / 1024))} KB)` : ""}</a>
                      {editable && <button type="button" className="text-muted-foreground hover:text-destructive" onClick={() => void dropFile(q.id)} disabled={removeFile.isPending}>remove file</button>}
                    </>
                  ) : editable ? (
                    <button type="button" className="inline-flex items-center gap-1 text-muted-foreground hover:text-foreground" onClick={() => pickFile(q.id)} disabled={upload.isPending}><Paperclip className="h-3 w-3" /> {upload.isPending && target === q.id ? "Uploading…" : "Attach the quote file (PDF, PNG or JPEG, 10 MB)"}</button>
                  ) : (
                    <span className="text-muted-foreground">No file attached</span>
                  )}
                </div>
              </div>
              {editable && (
                <Button size="sm" variant="ghost" className="text-destructive" onClick={() => void del(q.id)} disabled={remove.isPending}><Trash2 className="h-4 w-4" /></Button>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function ApprovalTrail({ r }: { r: SpendRequestDetailRow }) {
  if (r.approvals.length === 0) return null;
  return (
    <section className="rounded-lg border bg-card p-4">
      <h2 className="text-sm font-semibold">Approval trail</h2>
      <ul className="mt-2 space-y-2 text-sm">
        {r.approvals.map((a) => {
          const kind = (a.payload as { kind?: string } | null)?.kind;
          const amend = kind === "AMENDMENT" ? (a.payload as { previousAmount?: string; nextAmount?: string; reason?: string }) : null;
          const step = a.steps[0];
          return (
            <li key={a.id} className="rounded-md bg-muted/40 p-2">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-medium">{kind === "AMENDMENT" ? "Amount change" : "Submission"}</span>
                <Badge variant="secondary">{a.status.toLowerCase()}</Badge>
                <span className="text-xs text-muted-foreground tabular-nums">{`AED ${money2(a.amountAed)} for the ceiling`}</span>
              </div>
              {amend && <div className="text-xs text-muted-foreground">{`${r.currency} ${money2(amend.previousAmount)} to ${money2(amend.nextAmount)}${amend.reason ? ` · ${amend.reason}` : ""}`}</div>}
              <div className="text-xs text-muted-foreground">
                {`${fmtWhen(a.createdAt)}${step?.assigneeName ? ` · assigned to ${step.assigneeName}` : ""}${step?.decidedByName ? ` · decided by ${step.decidedByName}` : ""}${step?.decidedAt ? ` ${fmtWhen(step.decidedAt)}` : ""}`}
              </div>
              {step?.note && <div className="mt-1 text-xs"><span className="text-muted-foreground">Note: </span>{step.note}</div>}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/** The reporting currency floats against AED (EUR, GBP): the rate is asked for here and decides who approves. */
function needsAedRate(r: SpendRequestDetailRow): boolean {
  const rep = r.budget?.reportingCurrency;
  return !!rep && AED_PEG_RATES[rep] === undefined;
}

function SubmitDialog({ r, onClose }: { r: SpendRequestDetailRow; onClose: () => void }) {
  const submit = useSubmitSpendRequest(r.id);
  const [rate, setRate] = useState("");
  const floats = needsAedRate(r);
  async function go() {
    try {
      const saved = await submit.mutateAsync({ expectedVersion: r.version, reportingToAedRate: floats ? rate : null });
      toast.success(saved.budgetCheckStatus === "WITHIN_BUDGET" ? "Submitted and routed for approval." : "Submitted as an over-budget exception to the final approver.");
      onClose();
    } catch (err) {
      toast.error((err as Error).message);
    }
  }
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Submit for approval</DialogTitle>
          <DialogDescription>{`The budget check runs now against what "${r.line?.description ?? "the line"}" has left, and the request goes to whoever the AED amount requires. Over the line it goes to the final approver as an exception.`}</DialogDescription>
        </DialogHeader>
        {floats && (
          <div className="space-y-1">
            <Label htmlFor="sr-aed">{`${r.budget?.reportingCurrency} to AED rate`}</Label>
            <Input id="sr-aed" inputMode="decimal" value={rate} onChange={(e) => setRate(e.target.value)} placeholder="4.2" />
            <p className="text-xs text-muted-foreground">Between 2.5 and 8; it decides the ceiling and travels with the request.</p>
          </div>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={submit.isPending}>Not yet</Button>
          <Button onClick={() => void go()} disabled={submit.isPending || (floats && !(Number(rate) > 0))}>{submit.isPending && <Loader2 className="h-4 w-4 animate-spin" />} Submit</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function TransitionDialog({ r, action, onClose }: { r: SpendRequestDetailRow; action: "cancel" | "withdraw"; onClose: () => void }) {
  const transition = useTransitionSpendRequest(r.id);
  const [reason, setReason] = useState("");
  async function go() {
    try {
      await transition.mutateAsync({ action, reason: reason.trim() || null, expectedVersion: r.version });
      toast.success(action === "withdraw" ? "Withdrawn. It is a draft again." : "Cancelled.");
      onClose();
    } catch (err) {
      toast.error((err as Error).message);
    }
  }
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{action === "withdraw" ? "Withdraw the request" : "Cancel the request"}</DialogTitle>
          <DialogDescription>{action === "withdraw" ? "The pending approval is cancelled and the request goes back to draft, where you can change it and submit again." : "A cancelled request cannot be brought back; raise a new one if the need returns."}</DialogDescription>
        </DialogHeader>
        {action === "cancel" && (
          <div className="space-y-1">
            <Label htmlFor="sr-reason">Reason</Label>
            <Textarea id="sr-reason" rows={3} value={reason} onChange={(e) => setReason(e.target.value)} />
          </div>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={transition.isPending}>Keep it</Button>
          <Button variant={action === "cancel" ? "destructive" : "default"} onClick={() => void go()} disabled={transition.isPending || (action === "cancel" && !reason.trim())}>
            {transition.isPending && <Loader2 className="h-4 w-4 animate-spin" />}
            {action === "withdraw" ? "Withdraw" : "Cancel request"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function AmendDialog({ r, onClose }: { r: SpendRequestDetailRow; onClose: () => void }) {
  const amend = useAmendSpendRequest(r.id);
  const [amount, setAmount] = useState(money2(r.amount).replace(/,/g, ""));
  const [tax, setTax] = useState(Number(r.taxAmount) > 0 ? money2(r.taxAmount).replace(/,/g, "") : "");
  const [reason, setReason] = useState("");
  const [rate, setRate] = useState("");
  const floats = needsAedRate(r);
  const rising = Number(amount) > Number(r.amount);
  async function go() {
    try {
      const saved = await amend.mutateAsync({ amount, taxAmount: tax || null, reason: reason.trim(), reportingToAedRate: floats ? rate : null, expectedVersion: r.version });
      toast.success(saved.status === "PENDING_APPROVAL" ? "The rise is routed for approval on the new total." : "Amount lowered and recorded.");
      onClose();
    } catch (err) {
      toast.error((err as Error).message);
    }
  }
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Change the approved amount</DialogTitle>
          <DialogDescription>A higher amount is routed on the new total and approved for the difference; a lower amount applies at once. The change is recorded either way.</DialogDescription>
        </DialogHeader>
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1">
            <Label htmlFor="am-amount">{`New amount, ex-VAT (${r.currency})`}</Label>
            <Input id="am-amount" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} />
          </div>
          <div className="space-y-1">
            <Label htmlFor="am-tax">VAT amount</Label>
            <Input id="am-tax" inputMode="decimal" value={tax} onChange={(e) => setTax(e.target.value)} placeholder="0.00" />
          </div>
        </div>
        {floats && rising && (
          <div className="space-y-1">
            <Label htmlFor="am-aed">{`${r.budget?.reportingCurrency} to AED rate`}</Label>
            <Input id="am-aed" inputMode="decimal" value={rate} onChange={(e) => setRate(e.target.value)} placeholder="4.2" />
          </div>
        )}
        <div className="space-y-1">
          <Label htmlFor="am-reason">Reason</Label>
          <Textarea id="am-reason" rows={3} value={reason} onChange={(e) => setReason(e.target.value)} />
        </div>
        {rising && <p className="flex items-start gap-1 text-xs text-muted-foreground"><TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" /> The budget check runs again on the new total; over the line it goes to the final approver as an exception.</p>}
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={amend.isPending}>Keep it</Button>
          <Button onClick={() => void go()} disabled={amend.isPending || !(Number(amount) > 0) || !reason.trim() || (floats && rising && !(Number(rate) > 0))}>{amend.isPending && <Loader2 className="h-4 w-4 animate-spin" />} {rising ? "Route the change" : "Apply"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function QuoteDialog({ r, onClose }: { r: SpendRequestDetailRow; onClose: () => void }) {
  const add = useAddQuote(r.id);
  const suppliers = useSuppliers();
  const [q, setQ] = useState<QuoteInput>({ vendorName: r.supplier?.displayName ?? r.proposedVendorName ?? "", supplierId: r.supplierId ?? null, amount: money2(r.amount).replace(/,/g, ""), taxAmount: null, currency: r.currency, quotedOn: null, validUntil: null, recommended: r.quotes.length === 0, notes: null });
  const set = <K extends keyof QuoteInput>(k: K, v: QuoteInput[K]) => setQ((s) => ({ ...s, [k]: v }));
  async function go() {
    try {
      await add.mutateAsync({ ...q, vendorName: q.vendorName.trim(), notes: q.notes?.trim() || null });
      toast.success("Quote attached.");
      onClose();
    } catch (err) {
      toast.error((err as Error).message);
    }
  }
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Attach a quote</DialogTitle>
          <DialogDescription>{"The figures from the vendor's quote, ex-VAT with the VAT beside it. The quote file itself is attached on the row once this is saved."}</DialogDescription>
        </DialogHeader>
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1 sm:col-span-2">
            <Label htmlFor="q-vendor">Vendor</Label>
            <Input id="q-vendor" value={q.vendorName} onChange={(e) => set("vendorName", e.target.value)} maxLength={200} />
          </div>
          <div className="space-y-1 sm:col-span-2">
            <Label htmlFor="q-supplier">On the supplier list as</Label>
            <Select value={q.supplierId ?? NONE} onValueChange={(v) => set("supplierId", v === NONE ? null : v)}>
              <SelectTrigger id="q-supplier" className="w-full"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value={NONE}>Not on the list</SelectItem>
                {(suppliers.data ?? []).map((s) => <SelectItem key={s.id} value={s.id}>{s.displayName}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1">
            <Label htmlFor="q-amount">Amount, ex-VAT</Label>
            <Input id="q-amount" inputMode="decimal" value={q.amount} onChange={(e) => set("amount", e.target.value)} />
          </div>
          <div className="space-y-1">
            <Label htmlFor="q-tax">VAT amount</Label>
            <Input id="q-tax" inputMode="decimal" value={q.taxAmount ?? ""} onChange={(e) => set("taxAmount", e.target.value || null)} placeholder="0.00" />
          </div>
          <div className="space-y-1">
            <Label htmlFor="q-currency">Currency</Label>
            <Input id="q-currency" value={q.currency} onChange={(e) => set("currency", e.target.value.toUpperCase())} maxLength={3} />
          </div>
          <div className="flex items-center gap-2 pt-5">
            <Switch id="q-rec" checked={q.recommended === true} onCheckedChange={(v) => set("recommended", v)} />
            <Label htmlFor="q-rec">Recommended</Label>
          </div>
          <div className="space-y-1">
            <Label htmlFor="q-on">Quoted on</Label>
            <Input id="q-on" type="date" value={q.quotedOn ?? ""} onChange={(e) => set("quotedOn", e.target.value || null)} />
          </div>
          <div className="space-y-1">
            <Label htmlFor="q-until">Valid until</Label>
            <Input id="q-until" type="date" value={q.validUntil ?? ""} onChange={(e) => set("validUntil", e.target.value || null)} />
          </div>
          <div className="space-y-1 sm:col-span-2">
            <Label htmlFor="q-notes">Notes</Label>
            <Textarea id="q-notes" rows={2} value={q.notes ?? ""} onChange={(e) => set("notes", e.target.value || null)} maxLength={2000} />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={add.isPending}>Cancel</Button>
          <Button onClick={() => void go()} disabled={add.isPending || !q.vendorName.trim() || !(Number(q.amount) > 0) || q.currency.length !== 3}>{add.isPending && <Loader2 className="h-4 w-4 animate-spin" />} Attach</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
