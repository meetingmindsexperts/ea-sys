"use client";

/**
 * Set a status, a presentation type, or both, on the ticked abstracts
 * (Nov 19, 2026). Backed by POST /api/events/[id]/abstracts/bulk-update.
 *
 * It is the single abstract's status change, many times: the same
 * review-count rule, the same override, withdrawn is still final. What a
 * single change refuses, this skips and names.
 *
 * Authors are NOT emailed unless the box is ticked (owner): a committee's
 * decisions are applied first and announced later, with the organiser's own
 * templates from Communications.
 */
import { useState } from "react";
import { AlertTriangle, CheckCircle2, Loader2 } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { toast } from "sonner";
import { useBulkUpdateAbstracts, useMakePresenters, type BulkAbstractUpdateInput } from "@/hooks/use-api";
import { describeMakePresenters, makePresentersNeedsAttention } from "@/lib/make-presenters-outcome";
import { describeBulkUpdate, unfinishedIds, type BulkUpdateReport } from "@/lib/abstract-bulk-update-outcome";
import { formatAbstractSerial } from "@/lib/abstract-serial";
import { readEnabledPresentationTypes } from "@/lib/abstract-presentation-types";
import { PRESENTATION_TYPE_LABELS } from "@/app/(dashboard)/events/[eventId]/abstracts/abstract-enums";

/** What the dialog needs to know about a ticked abstract. */
export interface BulkStatusAbstract {
  id: string;
  serialId: number | null;
  status: string;
  presentationType: string | null;
}

type BulkStatus = NonNullable<BulkAbstractUpdateInput["status"]>;

/** The statuses staff set, in the order a decision usually moves, as a person reads them. */
const STATUS_CHOICES: { value: BulkStatus; label: string }[] = [
  { value: "UNDER_REVIEW", label: "Under review" },
  { value: "ACCEPTED", label: "Accepted" },
  // The word everyone reads for a rejected abstract (abstract-status-label.ts).
  { value: "REJECTED", label: "Not accepted" },
  { value: "REVISION_REQUESTED", label: "Revision requested" },
  { value: "WITHDRAWN", label: "Withdrawn" },
];
/** The author is told about these (when the box is ticked); never about a withdrawal. */
const EMAILED_STATUSES: BulkStatus[] = ["UNDER_REVIEW", "ACCEPTED", "REJECTED", "REVISION_REQUESTED"];
/** These need the event's number of scored reviews, unless overridden. */
const GATED_STATUSES: BulkStatus[] = ["ACCEPTED", "REJECTED"];
const KEEP = "keep";

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/**
 * Would the server change this abstract? The same order it uses
 * (bulkUpdateOne): a status that differs is tried first, and a withdrawn
 * abstract refuses it, type and all; only with no status to change does a
 * type alone count.
 */
function wouldChange(a: BulkStatusAbstract, status: BulkStatus | null, type: string | null): boolean {
  const wantsStatus = status !== null && a.status !== status;
  if (wantsStatus) return a.status !== "WITHDRAWN";
  return type !== null && a.presentationType !== type;
}

/** How many of the ticked abstracts the choice can touch. The review-count rule may still skip some. */
function countAffected(abstracts: BulkStatusAbstract[], status: BulkStatus | null, type: string | null): number {
  return abstracts.filter((a) => wouldChange(a, status, type)).length;
}

function applyLabel(busy: boolean, affected: number): string {
  if (busy) return "Applying...";
  return `Apply to ${plural(affected, "abstract", "abstracts")}`;
}

function Report({ report }: { report: BulkUpdateReport }) {
  const Icon = report.level === "success" ? CheckCircle2 : AlertTriangle;
  return (
    <div className="space-y-3" aria-live="polite">
      <p className="flex items-center gap-2 text-sm font-medium">
        <Icon className={`h-4 w-4 ${report.level === "success" ? "text-green-600" : "text-amber-600"}`} />
        {report.headline}
      </p>
      {report.lines.length > 0 && (
        <ul className="space-y-1.5 rounded-md border bg-muted/30 p-3 text-sm text-muted-foreground">
          {report.lines.map((line) => (
            <li key={line} className="break-words">{line}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

function BulkStatusBody({
  eventId,
  eventSettings,
  abstracts,
  canMakePresenters,
  onFinished,
  onClose,
  onBusy,
}: {
  eventId: string;
  eventSettings: unknown;
  abstracts: BulkStatusAbstract[];
  /** May this person make the accepted authors' registrations Complimentary (registrations.bulk)? */
  canMakePresenters: boolean;
  /** The change ran: these ids stay ticked (skipped or not reached); the rest are done. */
  onFinished: (stillTicked: string[]) => void;
  onClose: () => void;
  /** A request is in flight: the dialog must not close under it. */
  onBusy: (busy: boolean) => void;
}) {
  const update = useBulkUpdateAbstracts(eventId);
  const makePresenters = useMakePresenters(eventId);
  // Owner, Nov 20, 2026: offered when accepting, never done silently.
  const [presentersTicked, setPresentersTicked] = useState(false);
  const [status, setStatus] = useState<BulkStatus | null>(null);
  const [type, setType] = useState<string | null>(null);
  const [notifyAuthors, setNotifyAuthors] = useState(false);
  const [forceStatus, setForceStatus] = useState(false);
  const [withdrawConfirmed, setWithdrawConfirmed] = useState(false);
  const [report, setReport] = useState<BulkUpdateReport | null>(null);

  const typeChoices = readEnabledPresentationTypes(eventSettings);
  const affected = countAffected(abstracts, status, type);
  const withdrawn = abstracts.filter((a) => a.status === "WITHDRAWN").length;
  // The ones a Withdrawn would really withdraw: not those already withdrawn
  // that a type chosen beside it would also touch.
  const toWithdraw = abstracts.length - withdrawn;
  const emails = status !== null && EMAILED_STATUSES.includes(status);
  const gated = status !== null && GATED_STATUSES.includes(status);
  const withdrawing = status === "WITHDRAWN";
  // Busy through BOTH calls: the registrations are changed after the statuses,
  // and a second press or a close in between ran it twice or lost its report.
  const busy = update.isPending || makePresenters.isPending;
  const nothingChosen = status === null && type === null;
  const alreadyAsChosen = abstracts.filter((a) => (status === null || a.status === status) && (type === null || a.presentationType === type)).length;
  const offersPresenters = canMakePresenters && status === "ACCEPTED";
  // The review-count rule is the server's to judge: without the override, some may be skipped.
  const mayBeFewer = gated && !forceStatus && affected > 0;
  const blocked = nothingChosen || affected === 0 || (withdrawing && !withdrawConfirmed);

  const numberOf = (id: string) => formatAbstractSerial(abstracts.find((a) => a.id === id)?.serialId ?? null);

  const apply = async () => {
    onBusy(true);
    try {
      const totals = await update.mutateAsync({
        abstractIds: abstracts.map((a) => a.id),
        ...(status !== null && { status }),
        ...(type !== null && { presentationType: type }),
        ...(emails && notifyAuthors && { notifyAuthors: true }),
        ...(gated && forceStatus && { forceStatus: true }),
      });
      const described = describeBulkUpdate(totals, numberOf);
      // The accepted ones, whether this change accepted them or they already were.
      const acceptedNow = [...totals.changed, ...totals.unchanged];
      if (offersPresenters && presentersTicked && acceptedNow.length > 0) {
        try {
          const outcome = await makePresenters.mutateAsync(acceptedNow);
          described.lines.push(...describeMakePresenters(outcome, numberOf));
          if (makePresentersNeedsAttention(outcome)) described.level = "warning";
        } catch (error) {
          // The statuses are set; only the registrations were not touched. Say so, with the way to do it.
          described.level = "warning";
          described.lines.push(
            `The registrations may not have been changed (${error instanceof Error ? error.message : "it failed"}). Check on Registrations: filter Abstract accepted, tick them, Payment, badge or cancel. Running it again there is safe.`,
          );
        }
      }
      setReport(described);
      onFinished(unfinishedIds(totals));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to update the abstracts");
    } finally {
      onBusy(false);
    }
  };

  if (report) {
    return (
      <>
        <Report report={report} />
        <DialogFooter>
          <Button onClick={onClose}>Done</Button>
        </DialogFooter>
      </>
    );
  }

  return (
    <>
      <div className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor="bulk-abstract-status">Status</Label>
            <Select
              value={status ?? KEEP}
              onValueChange={(value) => {
                setStatus(value === KEEP ? null : (value as BulkStatus));
                setWithdrawConfirmed(false);
              }}
              disabled={busy}
            >
              <SelectTrigger id="bulk-abstract-status" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={KEEP}>Keep each one&apos;s status</SelectItem>
                {STATUS_CHOICES.map((choice) => (
                  <SelectItem key={choice.value} value={choice.value}>
                    {choice.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <Label htmlFor="bulk-abstract-type">Presentation type</Label>
            <Select value={type ?? KEEP} onValueChange={(value) => setType(value === KEEP ? null : value)} disabled={busy}>
              <SelectTrigger id="bulk-abstract-type" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={KEEP}>Keep each one&apos;s type</SelectItem>
                {typeChoices.map((choice) => (
                  <SelectItem key={choice} value={choice}>
                    {PRESENTATION_TYPE_LABELS[choice]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>

        {emails && (
          <label htmlFor="bulk-abstract-notify" className="flex cursor-pointer items-start gap-2.5 rounded-md border p-3">
            <Checkbox id="bulk-abstract-notify" className="mt-0.5" checked={notifyAuthors} onCheckedChange={(c) => setNotifyAuthors(c === true)} disabled={busy} />
            <span className="text-sm">
              <span className="font-medium">Email the authors their decision now</span>
              <span className="block text-xs text-muted-foreground">
                Left unticked, nothing is sent: announce the decisions when you are ready, from Communications, with
                your own template. Ticked, each author gets the event&apos;s decision email as their abstract changes.
              </span>
            </span>
          </label>
        )}

        {offersPresenters && (
          <label htmlFor="bulk-abstract-presenters" className="flex cursor-pointer items-start gap-2.5 rounded-md border p-3">
            <Checkbox id="bulk-abstract-presenters" className="mt-0.5" checked={presentersTicked} onCheckedChange={(c) => setPresentersTicked(c === true)} disabled={busy} />
            <span className="text-sm">
              <span className="font-medium">Also make the authors&apos; registrations Complimentary, with a Presenter badge</span>
              <span className="block text-xs text-muted-foreground">
                Left unticked, their registrations stay as they are: do it later from Registrations, filter Abstract
                accepted. Ticked, it covers every ticked abstract that is accepted, the ones accepted earlier
                included; the author&apos;s own portal shows Complimentary at once, before any announcement. Invited
                faculty and a registration with a payment on it are left as they are and named.
              </span>
            </span>
          </label>
        )}

        {gated && (
          <label htmlFor="bulk-abstract-force" className="flex cursor-pointer items-start gap-2.5 rounded-md border p-3">
            <Checkbox id="bulk-abstract-force" className="mt-0.5" checked={forceStatus} onCheckedChange={(c) => setForceStatus(c === true)} disabled={busy} />
            <span className="text-sm">
              <span className="font-medium">Decide even without the required reviews</span>
              <span className="block text-xs text-muted-foreground">
                Left unticked, an abstract that does not yet have the event&apos;s number of scored reviews is skipped
                and named. Ticked, it is decided anyway and recorded as an override.
              </span>
            </span>
          </label>
        )}

        {withdrawing && (
          <label htmlFor="bulk-abstract-withdraw" className="flex cursor-pointer items-start gap-2.5 rounded-md border border-red-200 bg-red-50 p-3">
            <Checkbox id="bulk-abstract-withdraw" className="mt-0.5" checked={withdrawConfirmed} onCheckedChange={(c) => setWithdrawConfirmed(c === true)} disabled={busy} />
            <span className="text-sm text-red-900">
              <span className="font-medium">Withdraw {plural(toWithdraw, "abstract", "abstracts")}: this cannot be undone</span>
              <span className="block text-xs">
                A withdrawn abstract can never be given another status. The authors are not emailed.
              </span>
            </span>
          </label>
        )}

        <div className="rounded-md border p-3 text-sm">
          <p className="font-medium">
            {nothingChosen ? "Choose a status, a type, or both." : `${mayBeFewer ? "Up to " : ""}${plural(affected, "abstract", "abstracts")} of the ${abstracts.length} ticked will change.`}
          </p>
          {mayBeFewer && (
            <p className="text-muted-foreground">Any that do not yet have the required reviews are skipped and named.</p>
          )}
          {!nothingChosen && alreadyAsChosen > 0 && (
            <p className="text-muted-foreground">{plural(alreadyAsChosen, "is", "are")} already as chosen.</p>
          )}
          {status !== null && !withdrawing && withdrawn > 0 && (
            <p className="text-amber-700">{plural(withdrawn, "ticked abstract is", "ticked abstracts are")} withdrawn and will be skipped: withdrawn is final.</p>
          )}
        </div>
      </div>

      <DialogFooter>
        <Button variant="outline" onClick={onClose} disabled={busy}>
          Cancel
        </Button>
        <Button onClick={apply} disabled={busy || blocked} variant={withdrawing ? "destructive" : "default"}>
          {busy && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
          {applyLabel(busy, affected)}
        </Button>
      </DialogFooter>
    </>
  );
}

export function BulkStatusDialog({
  eventId,
  eventSettings,
  abstracts,
  canMakePresenters,
  open,
  onOpenChange,
  onFinished,
}: {
  eventId: string;
  /** The event's settings JSON: which presentation types it offers. */
  eventSettings: unknown;
  abstracts: BulkStatusAbstract[];
  canMakePresenters: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onFinished: (stillTicked: string[]) => void;
}) {
  const [busy, setBusy] = useState(false);
  // The ticked rows as they were when the dialog opened: the page narrows its
  // selection when the change finishes, and the result must keep naming them.
  const [snapshot, setSnapshot] = useState<BulkStatusAbstract[]>(abstracts);
  const [prevOpen, setPrevOpen] = useState(open);
  if (open !== prevOpen) {
    setPrevOpen(open);
    if (open) setSnapshot(abstracts);
  }

  return (
    <Dialog open={open} onOpenChange={(next) => (busy ? undefined : onOpenChange(next))}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Set status or type</DialogTitle>
          <DialogDescription>
            For the {plural(snapshot.length, "abstract", "abstracts")} you ticked. Each change follows the same rules as changing one abstract.
          </DialogDescription>
        </DialogHeader>
        {/* Mounted only while open, so every opening starts from a clean form. */}
        {open && (
          <BulkStatusBody
            eventId={eventId}
            eventSettings={eventSettings}
            abstracts={snapshot}
            canMakePresenters={canMakePresenters}
            onFinished={onFinished}
            onClose={() => onOpenChange(false)}
            onBusy={setBusy}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}
