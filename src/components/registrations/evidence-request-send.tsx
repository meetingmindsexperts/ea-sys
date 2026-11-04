"use client";

/**
 * Request ID and document (src/lib/evidence-request.ts, Nov 4, 2026): the
 * confirm dialog on the Registrations list. Each chosen person gets their own
 * link to add what their registration type requires and their registration
 * does not hold yet. Who is skipped, and why, is decided server-side
 * (evidence-request-service) and reported back here.
 */
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { useSendEvidenceRequests } from "@/hooks/use-api";
import { MAX_LINK_EXPIRY_DAYS, MIN_LINK_EXPIRY_DAYS, parseLinkExpiryInput } from "@/lib/link-expiry";
import {
  DEFAULT_EVIDENCE_REQUEST_EXPIRY_DAYS,
  EVIDENCE_REQUEST_SKIP_LABELS,
  type EvidenceRequestSkipReason,
} from "@/lib/evidence-request";

/** "already provided everything (3), cancelled (1)" */
function skipSummary(details: { reason: EvidenceRequestSkipReason }[]): string {
  const counts = new Map<string, number>();
  for (const d of details) {
    const label = EVIDENCE_REQUEST_SKIP_LABELS[d.reason] ?? d.reason;
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  return [...counts].map(([label, n]) => `${label} (${n})`).join(", ");
}

export function SendEvidenceRequestDialog({
  eventId,
  open,
  onOpenChange,
  registrationIds,
  onSent,
}: {
  eventId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  registrationIds: string[];
  onSent?: () => void;
}) {
  const send = useSendEvidenceRequests(eventId);
  const [expiryDays, setExpiryDays] = useState(String(DEFAULT_EVIDENCE_REQUEST_EXPIRY_DAYS));
  const parsedDays = parseLinkExpiryInput(expiryDays);

  // Start from the default every time the dialog opens.
  const [wasOpen, setWasOpen] = useState(open);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) setExpiryDays(String(DEFAULT_EVIDENCE_REQUEST_EXPIRY_DAYS));
  }

  const count = registrationIds.length;

  const submit = async () => {
    if (parsedDays === null) {
      toast.error(`Enter how many days the links stay valid: a whole number from ${MIN_LINK_EXPIRY_DAYS} to ${MAX_LINK_EXPIRY_DAYS}.`);
      return;
    }
    try {
      const result = await send.mutateAsync({ registrationIds, expiryDays: parsedDays });
      onOpenChange(false);
      onSent?.();
      toast.success(`Sent ${result.sent} request${result.sent === 1 ? "" : "s"}.`);
      if (result.skipped > 0) {
        toast.warning(`Skipped ${result.skipped}: ${skipSummary(result.skippedDetails ?? [])}.`, { duration: 10_000 });
      }
      if (result.errors.length > 0) {
        console.error("evidence-request: delivery errors", result.errors);
        toast.error(`${result.errors.length} could not be delivered: ${result.errors.slice(0, 3).join("; ")}`);
      }
    } catch (err) {
      console.error("evidence-request: send failed", err);
      toast.error(err instanceof Error ? err.message : "Send failed");
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Request ID and document</DialogTitle>
          <DialogDescription>
            Each person gets an email with their own link to add what their registration type requires and we do
            not have yet: a student ID, its expiry date, a member ID or a supporting document. People whose type asks
            for none of these, or who already provided everything, are skipped, and you are told why.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <p className="text-sm text-muted-foreground">
            Sending to <span className="font-medium text-foreground">{count} registrant{count === 1 ? "" : "s"}</span>.
            The email can be edited under Email Templates (ID and Document Request).
          </p>
          <div className="space-y-2">
            <Label htmlFor="evidence-request-expiry">Link valid for (days)</Label>
            <Input
              id="evidence-request-expiry"
              type="text"
              inputMode="numeric"
              pattern="[0-9]*"
              maxLength={3}
              className="w-32"
              value={expiryDays}
              onChange={(e) => setExpiryDays(e.target.value.replace(/\D/g, ""))}
              aria-invalid={parsedDays === null}
            />
            <p className="text-xs text-muted-foreground">
              Each link works once, and stops working after this many days. Whole numbers from {MIN_LINK_EXPIRY_DAYS} to {MAX_LINK_EXPIRY_DAYS}.
            </p>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={send.isPending}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={send.isPending || count === 0 || parsedDays === null}>
            {send.isPending ? "Sending..." : `Send to ${count}`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
