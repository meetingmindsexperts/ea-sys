"use client";

/**
 * The general actions on the ticked registrations (Nov 20, 2026; plan
 * docs/ABSTRACT_AUTHOR_REGISTRATION_PLAN.md step 3): set the payment status,
 * set the badge type, or cancel. Backed by POST registrations/bulk-update.
 *
 * It is the single registration's own change, many times. A row with money on
 * it (a payment, an invoice, a refund, a sponsor, a group) is never given a
 * new payment status or cancelled here: it is skipped and named, and decided
 * on that registration's own page.
 *
 * "Make presenters" is a preset, not a second action: Complimentary and a
 * Presenter badge, the two fields below filled in.
 */
import { useState } from "react";
import { AlertTriangle, CheckCircle2, Loader2 } from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { toast } from "sonner";
import { useBulkUpdateRegistrations, type BulkRegistrationUpdateInput, type BulkRegistrationUpdateOutcome } from "@/hooks/use-api";
import { PRESENTER_BADGE_TYPE } from "@/lib/author-facts";

/** What the dialog needs to know about a ticked registration: how to name it in the report. */
export interface BulkUpdateRegistration {
  id: string;
  label: string;
}

type PaymentChoice = "keep" | NonNullable<BulkRegistrationUpdateInput["paymentStatus"]>;
type BadgeChoice = "keep" | "set" | "clear";

const PAYMENT_CHOICES: { value: PaymentChoice; label: string }[] = [
  { value: "keep", label: "Leave as it is" },
  { value: "COMPLIMENTARY", label: "Complimentary" },
  { value: "UNPAID", label: "Unpaid" },
  { value: "UNASSIGNED", label: "Unassigned" },
];

const PART_WORDS: Record<string, string> = {
  paymentStatus: "payment status not changed",
  badgeType: "badge type not changed",
  cancel: "not cancelled",
  all: "left as it is",
};

function plural(n: number): string {
  return `${n} registration${n === 1 ? "" : "s"}`;
}

function Report({ outcome, labelOf }: { outcome: BulkRegistrationUpdateOutcome; labelOf: (id: string) => string }) {
  const clean = outcome.skipped.length === 0 && !outcome.interrupted;
  const Icon = clean ? CheckCircle2 : AlertTriangle;
  return (
    <div className="space-y-3" aria-live="polite">
      <p className="flex items-center gap-2 text-sm font-medium">
        <Icon className={`h-4 w-4 ${clean ? "text-green-600" : "text-amber-600"}`} />
        {plural(outcome.changed.length)} changed
        {outcome.unchanged.length > 0 ? `, ${outcome.unchanged.length} already as chosen` : ""}
        {outcome.skipped.length > 0 ? `, ${outcome.skipped.length} not done` : ""}.
      </p>
      {outcome.interrupted && (
        <p className="text-sm text-amber-700">
          {outcome.interrupted}: {plural(outcome.remaining.length)} not reached. They stay ticked, so you can run it again.
        </p>
      )}
      {outcome.skipped.length > 0 && (
        <ul className="max-h-56 space-y-1.5 overflow-y-auto rounded-md border bg-muted/30 p-3 text-sm text-muted-foreground">
          {outcome.skipped.map((s) => (
            <li key={`${s.registrationId}-${s.part}`} className="break-words">
              <span className="font-medium text-foreground">{labelOf(s.registrationId)}</span>: {PART_WORDS[s.part] ?? "not done"}. {s.message}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function Body({
  eventId,
  registrations,
  canCancel,
  onFinished,
  onClose,
  onBusy,
}: {
  eventId: string;
  registrations: BulkUpdateRegistration[];
  canCancel: boolean;
  /** The change ran: these ids stay ticked (not done, or not reached). */
  onFinished: (stillTicked: string[]) => void;
  onClose: () => void;
  onBusy: (busy: boolean) => void;
}) {
  const update = useBulkUpdateRegistrations(eventId);
  const [payment, setPayment] = useState<PaymentChoice>("keep");
  const [badge, setBadge] = useState<BadgeChoice>("keep");
  const [badgeText, setBadgeText] = useState("");
  const [cancelConfirmed, setCancelConfirmed] = useState(false);
  const [outcome, setOutcome] = useState<BulkRegistrationUpdateOutcome | null>(null);

  const busy = update.isPending;
  const ids = registrations.map((r) => r.id);
  const labelOf = (id: string) => registrations.find((r) => r.id === id)?.label ?? id;
  const badgeReady = badge !== "set" || badgeText.trim() !== "";
  const nothingChosen = payment === "keep" && badge === "keep";

  const run = async (input: Omit<BulkRegistrationUpdateInput, "registrationIds">) => {
    onBusy(true);
    try {
      const result = await update.mutateAsync({ registrationIds: ids, ...input });
      setOutcome(result);
      onFinished([...new Set([...result.skipped.map((s) => s.registrationId), ...result.remaining])]);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "The change could not be made");
    } finally {
      onBusy(false);
    }
  };

  const apply = () => {
    const badgeType = badge === "clear" ? "" : badgeText.trim();
    return run({
      ...(payment !== "keep" && { paymentStatus: payment }),
      ...(badge !== "keep" && { badgeType }),
    });
  };

  if (outcome) {
    return (
      <>
        <Report outcome={outcome} labelOf={labelOf} />
        <DialogFooter>
          <Button onClick={onClose}>Close</Button>
        </DialogFooter>
      </>
    );
  }

  return (
    <>
      <div className="space-y-5">
        <div className="flex items-center justify-between gap-3 rounded-md border bg-muted/30 p-3">
          <p className="text-sm text-muted-foreground">
            For accepted abstract authors: Complimentary, with a Presenter badge.
          </p>
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={busy}
            onClick={() => { setPayment("COMPLIMENTARY"); setBadge("set"); setBadgeText(PRESENTER_BADGE_TYPE); }}
          >
            Make presenters
          </Button>
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="bulk-payment">Payment status</Label>
          <Select value={payment} onValueChange={(v) => setPayment(v as PaymentChoice)} disabled={busy}>
            <SelectTrigger id="bulk-payment"><SelectValue /></SelectTrigger>
            <SelectContent>
              {PAYMENT_CHOICES.map((c) => <SelectItem key={c.value} value={c.value}>{c.label}</SelectItem>)}
            </SelectContent>
          </Select>
          <p className="text-xs text-muted-foreground">
            A registration with a payment, an invoice or a refund on it, a sponsor-paid one and a group member are
            left as they are and listed afterwards. No price is changed.
          </p>
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="bulk-badge">Badge type</Label>
          <Select value={badge} onValueChange={(v) => setBadge(v as BadgeChoice)} disabled={busy}>
            <SelectTrigger id="bulk-badge"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="keep">Leave as it is</SelectItem>
              <SelectItem value="set">Set to...</SelectItem>
              <SelectItem value="clear">Clear</SelectItem>
            </SelectContent>
          </Select>
          {badge === "set" && (
            <Input
              aria-label="Badge type to set"
              value={badgeText}
              maxLength={60}
              placeholder="e.g. Presenter"
              onChange={(e) => setBadgeText(e.target.value)}
              disabled={busy}
            />
          )}
          <p className="text-xs text-muted-foreground">A badge already printed is not reprinted by this.</p>
        </div>

        {canCancel && (
          <div className="space-y-2 border-t pt-4">
            <Label className="flex items-start gap-2 text-sm font-normal">
              <Checkbox className="mt-0.5" checked={cancelConfirmed} onCheckedChange={(v) => setCancelConfirmed(v === true)} disabled={busy} />
              <span>
                Cancel these registrations instead. Each seat is released. One with a payment on it is not
                cancelled here: cancel it on its own page, where the refund is decided.
              </span>
            </Label>
          </div>
        )}
      </div>
      <DialogFooter>
        <Button variant="outline" onClick={onClose} disabled={busy}>Close</Button>
        {cancelConfirmed ? (
          <Button variant="destructive" onClick={() => run({ cancel: true })} disabled={busy}>
            {busy && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            Cancel {plural(ids.length)}
          </Button>
        ) : (
          <Button onClick={apply} disabled={busy || nothingChosen || !badgeReady}>
            {busy && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            Apply to {plural(ids.length)}
          </Button>
        )}
      </DialogFooter>
    </>
  );
}

export function BulkRegistrationUpdateDialog({
  eventId,
  open,
  onOpenChange,
  registrations,
  canCancel,
  onFinished,
}: {
  eventId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  registrations: BulkUpdateRegistration[];
  canCancel: boolean;
  onFinished: (stillTicked: string[]) => void;
}) {
  const [busy, setBusy] = useState(false);
  // What was ticked when the dialog opened: the report names rows that the page has since unticked.
  const [frozen, setFrozen] = useState<BulkUpdateRegistration[] | null>(null);
  const shown = frozen ?? registrations;
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        // A request is in flight: closing would lose its report.
        if (busy) return;
        if (!next) setFrozen(null);
        onOpenChange(next);
      }}
    >
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Payment status, badge or cancel</DialogTitle>
          <DialogDescription>{plural(shown.length)} ticked.</DialogDescription>
        </DialogHeader>
        {open && (
          <Body
            eventId={eventId}
            registrations={shown}
            canCancel={canCancel}
            onFinished={(still) => { setFrozen(shown); onFinished(still); }}
            onClose={() => { setFrozen(null); onOpenChange(false); }}
            onBusy={setBusy}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}
