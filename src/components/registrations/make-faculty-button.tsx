"use client";

/**
 * "Make Faculty" on a speaker's registration (Nov 20, 2026; plan
 * docs/ABSTRACT_AUTHOR_REGISTRATION_PLAN.md step 6). Backed by
 * POST registrations/{id}/make-faculty.
 *
 * Pressing it asks the server what the move would do (a preview that changes
 * nothing) and shows that: the fee that would no longer be owed, the invoices
 * that would be cancelled, the badge. Where the server refuses (a payment on
 * it, a sponsor, a group), its own words are shown and there is nothing to
 * confirm. A fee is waived only by a person who was shown the amount: the
 * confirm sends that amount back, and the server refuses if it has changed.
 */
import { useState } from "react";
import { AlertTriangle, GraduationCap, Loader2 } from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";
import { formatCurrency } from "@/lib/utils";

interface Plan {
  speaker: { id: string; name: string };
  fromType: string | null;
  fromRate: string | null;
  owing: { amount: number; currency: string } | null;
  invoices: { id: string; invoiceNumber: string }[];
  badge: { from: string | null; to: string | null };
  alreadyOnFaculty: boolean;
}

type Answer = { ok?: boolean; moved?: boolean; plan?: Plan; invoicesNotCancelled?: string[]; error?: string; code?: string };

async function ask(eventId: string, registrationId: string, body: Record<string, unknown>): Promise<Answer> {
  const res = await fetch(`/api/events/${eventId}/registrations/${registrationId}/make-faculty`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = (await res.json().catch(() => ({}))) as Answer;
  return res.ok ? json : { ...json, ok: false, error: json.error ?? "Something went wrong. Try again." };
}

/** What changes, one line each, in the order a person checks them. */
export function planLines(plan: Plan): string[] {
  // Already on the Faculty type: the one thing that changes is who is taken to have put them there.
  if (plan.alreadyOnFaculty) {
    return [
      "This registration is already on the Faculty type, from signing up to submit.",
      "Confirming says the organisers invited this person: they are listed with the invited speakers from now on, on Speakers, Registrations and Certificates.",
      "Nothing else changes: the registration, its badge and its barcode stay as they are.",
    ];
  }
  const from = [plan.fromType, plan.fromRate].filter(Boolean).join(", ");
  const lines = [`Registration type: ${from || "none"} becomes Faculty, Complimentary. Their delegate seat is released.`];
  if (plan.owing) lines.push(`${formatCurrency(plan.owing.amount, plan.owing.currency)} is owed now and will no longer be.`);
  if (plan.invoices.length > 0) {
    lines.push(`${plan.invoices.length === 1 ? "Invoice" : "Invoices"} ${plan.invoices.map((i) => i.invoiceNumber).join(", ")} will be cancelled (kept, not deleted).`);
  }
  if (plan.badge.to !== plan.badge.from) lines.push(`Badge type: ${plan.badge.from || "none"} becomes ${plan.badge.to}.`);
  else if (plan.badge.from) lines.push(`Badge type stays ${plan.badge.from}.`);
  lines.push("Their barcode does not change.");
  return lines;
}

function confirmLabel(plan: Plan): string {
  if (plan.alreadyOnFaculty) return "Confirm";
  return plan.owing ? `Waive ${formatCurrency(plan.owing.amount, plan.owing.currency)} and make Faculty` : "Make Faculty";
}

export function MakeFacultyButton({
  eventId,
  registrationId,
  personName,
  alreadyOnFaculty,
  onMoved,
}: {
  eventId: string;
  registrationId: string;
  personName: string;
  /** On the Faculty type already, without the organisers having put them there: the action confirms it. */
  alreadyOnFaculty: boolean;
  /** The move was made: the caller reloads the registration. */
  onMoved: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [plan, setPlan] = useState<Plan | null>(null);
  const [refusal, setRefusal] = useState<string | null>(null);

  const preview = async () => {
    setOpen(true);
    setBusy(true);
    setPlan(null);
    setRefusal(null);
    try {
      const answer = await ask(eventId, registrationId, { preview: true });
      if (answer.ok && answer.plan) setPlan(answer.plan);
      else setRefusal(answer.error ?? "This registration cannot be made Faculty.");
    } catch {
      setRefusal("Could not reach the server. Try again.");
    } finally {
      setBusy(false);
    }
  };

  const confirm = async () => {
    if (!plan) return;
    setBusy(true);
    try {
      const answer = await ask(eventId, registrationId, plan.owing ? { confirmWaive: plan.owing.amount } : {});
      if (answer.ok && answer.moved) {
        const left = answer.invoicesNotCancelled ?? [];
        if (left.length > 0) toast.warning(`Made Faculty. Could not cancel ${left.join(", ")}: cancel it from Invoices.`, { duration: 15000 });
        else toast.success(alreadyOnFaculty ? `${personName} is confirmed as invited faculty` : `${personName} is now Faculty`);
        setOpen(false);
        onMoved();
        return;
      }
      // The amount changed since it was shown: show the new one, to be confirmed again.
      if (answer.code === "CONFIRM_WAIVE" && answer.plan) {
        setPlan(answer.plan);
        toast.error("The amount owed has changed. Check it and confirm again.");
        return;
      }
      setPlan(null);
      setRefusal(answer.error ?? "This registration could not be made Faculty.");
    } catch {
      toast.error("Could not reach the server. Try again.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Button type="button" variant="outline" size="sm" onClick={preview}>
        <GraduationCap className="mr-2 h-4 w-4" />
        {alreadyOnFaculty ? "Confirm as invited faculty" : "Make Faculty"}
      </Button>
      <Dialog open={open} onOpenChange={(next) => { if (!busy) setOpen(next); }}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>{alreadyOnFaculty ? `Confirm ${personName} as invited faculty` : `Make ${personName} Faculty`}</DialogTitle>
            <DialogDescription>
              For a speaker or committee member who registered or submitted an abstract before being invited.
            </DialogDescription>
          </DialogHeader>
          {busy && !plan && !refusal && (
            <p className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" /> Checking the registration...</p>
          )}
          {refusal && (
            <p className="flex items-start gap-2 rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
              <span>{refusal}</span>
            </p>
          )}
          {plan && (
            <ul className="list-disc space-y-1.5 pl-5 text-sm">
              {planLines(plan).map((line) => <li key={line}>{line}</li>)}
            </ul>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)} disabled={busy}>{plan ? "Cancel" : "Close"}</Button>
            {plan && (
              <Button onClick={confirm} disabled={busy}>
                {busy && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                {confirmLabel(plan)}
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
