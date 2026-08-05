"use client";

/**
 * Grant-registration dialog (owner decision Aug 5, 2026) — session-proposal
 * signups no longer auto-mint a comp registration, so the organizer grants
 * per person from the proposal detail sheet / the speaker page:
 *
 *   • Complimentary — the comp Faculty companion (badge / barcode / check-in),
 *     the historical one-click grant.
 *   • Payable — a real registration on a chosen registration type (+ pricing
 *     tier when the type has tiers), minted from the details the person
 *     already provided. The registration service then emails them the
 *     confirmation + quote PDF with a Pay Now link automatically.
 *
 * POSTs to /api/events/[eventId]/speakers/[speakerId]/grant-companion with
 * `{ mode, ticketTypeId?, pricingTierId? }`; calls `onGranted` with the API
 * response so the host page can update its local state + invalidate queries.
 */

import { useState } from "react";
import { toast } from "sonner";
import { Loader2, BadgeCheck, CreditCard } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useTickets } from "@/hooks/use-api";
import { cn } from "@/lib/utils";

export interface GrantResult {
  outcome: string;
  registrationId: string;
  /** REAL row state from the route (review H1) — hosts must not fabricate. */
  status?: string | null;
  paymentStatus?: string | null;
}

interface PricingTierRow {
  id: string;
  name: string;
  price: number | string | null;
  isActive: boolean;
}

interface TicketTypeRow {
  id: string;
  name: string;
  price: number | string | null;
  isFaculty?: boolean;
  isActive?: boolean;
  pricingTiers?: PricingTierRow[];
}

interface GrantRegistrationDialogProps {
  eventId: string;
  speakerId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onGranted: (result: GrantResult) => void;
  /** Copy tweak when the person's previous registration was revoked. */
  regrant?: boolean;
}

export function GrantRegistrationDialog({
  eventId,
  speakerId,
  open,
  onOpenChange,
  onGranted,
  regrant,
}: GrantRegistrationDialogProps) {
  const [mode, setMode] = useState<"comp" | "payable">("comp");
  const [ticketTypeId, setTicketTypeId] = useState("");
  const [pricingTierId, setPricingTierId] = useState("");
  const [submitting, setSubmitting] = useState(false);

  // Re-seed on every closed→open transition (review M8; the React-19
  // store-info-from-previous-render pattern, as in bulk-email-dialog): a
  // reopened dialog must NOT come pre-set to the previous grant's
  // payable+type — one Enter would mint a payable registration the
  // organizer meant as comp.
  const [prevOpen, setPrevOpen] = useState(open);
  if (open !== prevOpen) {
    setPrevOpen(open);
    if (open) {
      setMode("comp");
      setTicketTypeId("");
      setPricingTierId("");
    }
  }

  const { data: ticketTypes = [] } = useTickets(eventId) as { data: TicketTypeRow[] };
  // Faculty types are the comp mechanism — never a payable choice.
  const payableTypes = ticketTypes.filter((t) => !t.isFaculty);
  const selectedType = payableTypes.find((t) => t.id === ticketTypeId);
  const tiers = selectedType?.pricingTiers ?? [];

  const priceLabel = (price: number | string | null, hasTiers: boolean) => {
    const n = price == null ? null : Number(price);
    // Mirror the Add Registration rule: no misleading "- $0" when the real
    // price lives on the tiers (or the type is free).
    if (hasTiers || n == null || n === 0) return "";
    return ` — $${n}`;
  };

  const handleSubmit = async () => {
    if (mode === "payable" && !ticketTypeId) {
      toast.error("Pick a registration type");
      return;
    }
    setSubmitting(true);
    try {
      const res = await fetch(`/api/events/${eventId}/speakers/${speakerId}/grant-companion`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(
          mode === "payable"
            ? { mode, ticketTypeId, pricingTierId: pricingTierId || undefined }
            : { mode: "comp" },
        ),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        console.error("[grant-registration] failed:", res.status, data.error);
        toast.error(data.error || "Failed to grant registration");
        return;
      }
      // Honest toasts (review M2/M4/M6): branch on what ACTUALLY happened —
      // a "payable" grant on a free type creates COMPLIMENTARY and sends no
      // email; a linked existing registration gets no payment request either.
      if (data.outcome === "payable-created") {
        toast.success(
          data.paymentStatus === "COMPLIMENTARY"
            ? "Registration created as complimentary (the type is free) — no payment email sent"
            : "Registration created — payment request emailed with the quote and Pay Now link",
        );
      } else if (data.outcome === "linked-by-email" || data.outcome === "linked-existing") {
        toast.success(
          mode === "payable"
            ? "This person already had a registration — it was linked instead; NO payment request was sent"
            : "Linked this person's existing registration",
        );
      } else if (data.outcome === "already-linked") {
        // Reachable when another organizer granted concurrently (button
        // visibility is client state) — nothing was created; say so.
        toast.success("This person already has a linked registration — nothing changed");
      } else {
        toast.success("Complimentary registration granted");
      }
      onGranted(data as GrantResult);
      onOpenChange(false);
    } catch (err) {
      console.error("[grant-registration] failed:", err);
      toast.error("Failed to grant registration");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{regrant ? "Re-grant registration" : "Grant registration"}</DialogTitle>
          <DialogDescription>
            Uses the details this person already provided — no re-registration needed.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <button
            type="button"
            onClick={() => setMode("comp")}
            className={cn(
              "w-full rounded-lg border p-3 text-left flex items-start gap-3 transition-colors",
              mode === "comp" ? "border-primary bg-primary/5" : "hover:bg-muted/50",
            )}
          >
            <BadgeCheck className="h-4 w-4 mt-0.5 text-primary shrink-0" />
            <span>
              <span className="block text-sm font-medium">Complimentary (Faculty)</span>
              <span className="block text-xs text-muted-foreground">
                Comp registration — badge, entry barcode, check-in. No payment.
              </span>
            </span>
          </button>

          <button
            type="button"
            onClick={() => setMode("payable")}
            className={cn(
              "w-full rounded-lg border p-3 text-left flex items-start gap-3 transition-colors",
              mode === "payable" ? "border-primary bg-primary/5" : "hover:bg-muted/50",
            )}
          >
            <CreditCard className="h-4 w-4 mt-0.5 text-primary shrink-0" />
            <span>
              <span className="block text-sm font-medium">Payable</span>
              <span className="block text-xs text-muted-foreground">
                Real registration on a type you pick — they&apos;re emailed the quote and a Pay Now
                link automatically.
              </span>
            </span>
          </button>

          {mode === "payable" && (
            <div className="space-y-3 pl-1">
              <div className="space-y-1.5">
                <Label>Registration type *</Label>
                <Select
                  value={ticketTypeId}
                  onValueChange={(v) => {
                    setTicketTypeId(v);
                    setPricingTierId("");
                  }}
                >
                  <SelectTrigger className="w-full">
                    <SelectValue placeholder="Pick a registration type" />
                  </SelectTrigger>
                  <SelectContent>
                    {payableTypes.map((t) => (
                      <SelectItem key={t.id} value={t.id}>
                        {t.name}
                        {priceLabel(t.price, (t.pricingTiers?.length ?? 0) > 0)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              {tiers.length > 0 && (
                <div className="space-y-1.5">
                  <Label>Pricing tier *</Label>
                  <Select value={pricingTierId} onValueChange={setPricingTierId}>
                    <SelectTrigger className="w-full">
                      <SelectValue placeholder="Pick a pricing tier" />
                    </SelectTrigger>
                    <SelectContent>
                      {tiers.map((tier) => (
                        <SelectItem key={tier.id} value={tier.id}>
                          {tier.name}
                          {tier.isActive ? "" : " (inactive)"}
                          {tier.price != null ? ` — $${Number(tier.price)}` : ""}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              )}
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={submitting}>
            Cancel
          </Button>
          <Button
            onClick={handleSubmit}
            disabled={submitting || (mode === "payable" && (!ticketTypeId || (tiers.length > 0 && !pricingTierId)))}
          >
            {submitting && <Loader2 className="h-4 w-4 mr-1 animate-spin" />}
            {mode === "payable" ? "Create & request payment" : "Grant complimentary"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
