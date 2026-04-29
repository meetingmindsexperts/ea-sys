"use client";

import { useState } from "react";
import { toast } from "sonner";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { PhotoUpload } from "@/components/ui/photo-upload";
import { Loader2, Banknote, CreditCard, Wallet } from "lucide-react";

type PaymentMethod = "bank_transfer" | "card_onsite" | "cash";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  eventId: string;
  registrationId: string;
  // Pre-fill amount + currency from the registration's ticket. Editable
  // in case the organizer is recording a partial payment or different
  // currency than the ticket default.
  defaultAmount?: number;
  defaultCurrency?: string;
  onRecorded?: () => void;
}

/**
 * Record a manual (offline) payment for a registration. Three methods:
 *   - bank_transfer  — capture bank reference + uploaded receipt photo
 *   - card_onsite    — capture last4 + brand of a swiped card
 *   - cash           — capture who received the cash
 *
 * Submits to `POST /api/events/[id]/registrations/[id]/payments`. On
 * success the API creates a Payment row, flips registration to PAID,
 * generates the post-payment Invoice, and emails it to the registrant.
 */
export function RecordPaymentDialog({
  open,
  onOpenChange,
  eventId,
  registrationId,
  defaultAmount,
  defaultCurrency,
  onRecorded,
}: Props) {
  const [method, setMethod] = useState<PaymentMethod>("bank_transfer");
  const [amount, setAmount] = useState<string>(
    defaultAmount != null ? String(defaultAmount) : "",
  );
  const [currency, setCurrency] = useState<string>(defaultCurrency ?? "USD");
  const [paidAt, setPaidAt] = useState<string>(today());
  const [bankReference, setBankReference] = useState("");
  const [proofUrl, setProofUrl] = useState<string | null>(null);
  const [cardBrand, setCardBrand] = useState("");
  const [cardLast4, setCardLast4] = useState("");
  const [cashReceivedBy, setCashReceivedBy] = useState("");
  const [notes, setNotes] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Reset state whenever the dialog (re-)opens so a previous attempt's
  // values don't leak across registrations.
  const handleOpenChange = (next: boolean) => {
    if (!next) {
      // Defer reset to next tick so the closing animation doesn't flash
      // empty fields before the dialog is gone.
      setTimeout(() => {
        setMethod("bank_transfer");
        setAmount(defaultAmount != null ? String(defaultAmount) : "");
        setCurrency(defaultCurrency ?? "USD");
        setPaidAt(today());
        setBankReference("");
        setProofUrl(null);
        setCardBrand("");
        setCardLast4("");
        setCashReceivedBy("");
        setNotes("");
        setError(null);
      }, 200);
    }
    onOpenChange(next);
  };

  const handleSubmit = async () => {
    setError(null);

    const amountNum = Number(amount);
    if (!Number.isFinite(amountNum) || amountNum <= 0) {
      setError("Amount must be a positive number.");
      return;
    }
    if (method === "card_onsite" && !/^\d{4}$/.test(cardLast4)) {
      setError("Card last 4 must be 4 digits.");
      return;
    }
    if (method === "cash" && !cashReceivedBy.trim()) {
      setError("Please record who received the cash.");
      return;
    }

    setSubmitting(true);
    try {
      const res = await fetch(
        `/api/events/${eventId}/registrations/${registrationId}/payments`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            method,
            amount: amountNum,
            currency: currency.toUpperCase(),
            paidAt,
            ...(method === "bank_transfer"
              ? {
                  bankReference: bankReference.trim() || undefined,
                  proofUrl: proofUrl ?? undefined,
                }
              : {}),
            ...(method === "card_onsite"
              ? {
                  cardBrand: cardBrand.trim() || undefined,
                  cardLast4,
                }
              : {}),
            ...(method === "cash"
              ? { cashReceivedBy: cashReceivedBy.trim() }
              : {}),
            notes: notes.trim() || undefined,
          }),
        },
      );

      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        // Surface field-level Zod errors when present so the user knows
        // exactly which field is broken.
        const fieldErrors = data?.details?.fieldErrors as
          | Record<string, string[] | undefined>
          | undefined;
        const detailMsg = fieldErrors
          ? Object.entries(fieldErrors)
              .filter(([, v]) => Array.isArray(v) && v.length > 0)
              .map(([k, v]) => `${k}: ${(v as string[]).join(", ")}`)
              .join("; ")
          : "";
        const message = detailMsg
          ? `${data.error ?? "Failed to record payment"} — ${detailMsg}`
          : data.error || "Failed to record payment";
        console.error("[record-payment] server rejected", {
          status: res.status,
          error: data.error,
          fieldErrors,
        });
        setError(message);
        return;
      }

      toast.success(
        "Payment recorded. Invoice will be emailed to the registrant.",
      );
      onRecorded?.();
      handleOpenChange(false);
    } catch (err) {
      console.error("[record-payment] network error", err);
      setError(err instanceof Error ? err.message : "Network error");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Record Manual Payment</DialogTitle>
          <DialogDescription>
            For onsite, bank transfer, or cash payments. Creates a Payment
            record, marks the registration as PAID, and emails the
            registrant the Invoice PDF.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-2">
          <div className="space-y-2">
            <Label htmlFor="method">Method *</Label>
            <Select value={method} onValueChange={(v) => setMethod(v as PaymentMethod)}>
              <SelectTrigger id="method">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="bank_transfer">
                  <span className="flex items-center gap-2">
                    <Banknote className="h-4 w-4" /> Bank Transfer
                  </span>
                </SelectItem>
                <SelectItem value="card_onsite">
                  <span className="flex items-center gap-2">
                    <CreditCard className="h-4 w-4" /> Card (onsite terminal)
                  </span>
                </SelectItem>
                <SelectItem value="cash">
                  <span className="flex items-center gap-2">
                    <Wallet className="h-4 w-4" /> Cash
                  </span>
                </SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div className="grid grid-cols-3 gap-3">
            <div className="space-y-2 col-span-2">
              <Label htmlFor="amount">Amount *</Label>
              <Input
                id="amount"
                type="number"
                step="0.01"
                min="0"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="currency">Currency</Label>
              <Input
                id="currency"
                maxLength={3}
                value={currency}
                onChange={(e) => setCurrency(e.target.value.toUpperCase())}
              />
            </div>
          </div>

          <div className="space-y-2">
            <Label htmlFor="paidAt">Date received</Label>
            <Input
              id="paidAt"
              type="date"
              value={paidAt}
              onChange={(e) => setPaidAt(e.target.value)}
            />
          </div>

          {method === "bank_transfer" && (
            <>
              <div className="space-y-2">
                <Label htmlFor="bankReference">
                  Bank reference / transaction ID
                </Label>
                <Input
                  id="bankReference"
                  value={bankReference}
                  onChange={(e) => setBankReference(e.target.value)}
                  placeholder="e.g. TRX-123456 or SWIFT message ref"
                />
              </div>
              <div className="space-y-2">
                <Label>Proof of transfer (photo of receipt or SWIFT copy)</Label>
                <PhotoUpload value={proofUrl} onChange={setProofUrl} />
                <p className="text-xs text-muted-foreground">
                  JPEG / PNG / WebP up to 500KB. The PDF transfer copy can
                  be photographed with your phone.
                </p>
              </div>
            </>
          )}

          {method === "card_onsite" && (
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-2">
                <Label htmlFor="cardBrand">Card brand</Label>
                <Input
                  id="cardBrand"
                  value={cardBrand}
                  onChange={(e) => setCardBrand(e.target.value)}
                  placeholder="Visa / Mastercard / Amex"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="cardLast4">Last 4 digits *</Label>
                <Input
                  id="cardLast4"
                  inputMode="numeric"
                  pattern="[0-9]{4}"
                  maxLength={4}
                  value={cardLast4}
                  onChange={(e) =>
                    setCardLast4(e.target.value.replace(/\D/g, "").slice(0, 4))
                  }
                  placeholder="4242"
                />
                <p className="text-xs text-muted-foreground">
                  Only the last 4 — never the full card number.
                </p>
              </div>
            </div>
          )}

          {method === "cash" && (
            <div className="space-y-2">
              <Label htmlFor="cashReceivedBy">Received by *</Label>
              <Input
                id="cashReceivedBy"
                value={cashReceivedBy}
                onChange={(e) => setCashReceivedBy(e.target.value)}
                placeholder="Cashier / organizer name"
              />
            </div>
          )}

          <div className="space-y-2">
            <Label htmlFor="notes">Notes</Label>
            <Textarea
              id="notes"
              rows={2}
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="Anything else worth recording for reconciliation"
            />
          </div>

          {error && (
            <div className="rounded-md bg-red-50 border border-red-200 px-3 py-2 text-sm text-red-700">
              {error}
            </div>
          )}
        </div>

        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => handleOpenChange(false)}
            disabled={submitting}
          >
            Cancel
          </Button>
          <Button onClick={handleSubmit} disabled={submitting}>
            {submitting ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Recording…
              </>
            ) : (
              "Record Payment"
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}
