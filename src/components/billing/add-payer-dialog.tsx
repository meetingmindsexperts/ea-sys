"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from "@/components/ui/select";
import { toast } from "sonner";
import { useCreateAndAttachBillingAccount } from "@/hooks/use-api";

type PayerType = "INSTITUTION" | "COMPANY" | "OTHER";

const BLANK = {
  name: "",
  type: "INSTITUTION" as PayerType,
  contactName: "",
  email: "",
  phone: "",
  address: "",
  city: "",
  country: "",
  taxNumber: "",
};

interface AddPayerDialogProps {
  eventId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Called with the created-or-reused payer so the caller can select it. */
  onCreated: (payer: { id: string; name: string }) => void;
}

/**
 * Inline "add a payer" from within an event (the Charge-to picker). Creates the
 * payer at the ORG level (exact-name reuse; near-duplicate flagged for review)
 * AND auto-attaches it to this event — no trip to Settings → Billing. The org
 * record is the consolidated source of truth; full details can be edited there.
 */
export function AddPayerDialog({ eventId, open, onOpenChange, onCreated }: AddPayerDialogProps) {
  const create = useCreateAndAttachBillingAccount(eventId);
  const [form, setForm] = useState(BLANK);
  // Reset to blank each time the dialog opens (render-time sync, no effect).
  const [wasOpen, setWasOpen] = useState(false);
  if (open && !wasOpen) {
    setWasOpen(true);
    setForm(BLANK);
  } else if (!open && wasOpen) {
    setWasOpen(false);
  }

  const set = (k: keyof typeof BLANK, v: string) => setForm((f) => ({ ...f, [k]: v }));

  const handleSubmit = async () => {
    const name = form.name.trim();
    if (!name) {
      toast.error("Payer name is required");
      return;
    }
    try {
      const res = await create.mutateAsync({
        name,
        type: form.type,
        contactName: form.contactName || null,
        email: form.email || null,
        phone: form.phone || null,
        address: form.address || null,
        city: form.city || null,
        country: form.country || null,
        taxNumber: form.taxNumber || null,
      });
      toast.success(
        res.reused
          ? `Using existing payer "${res.billingAccount.name}"`
          : res.needsReview
            ? `Added "${res.billingAccount.name}" — flagged as a possible duplicate to review in Settings → Billing`
            : `Added payer "${res.billingAccount.name}"`,
      );
      onCreated(res.billingAccount);
      onOpenChange(false);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to add payer");
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Add a payer</DialogTitle>
          <DialogDescription>
            Charge this registration to an institution, company, or grant. The payer is saved to your
            organization and reused across events — an existing payer with the same name is reused.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="payer-name">Payer name *</Label>
            <Input id="payer-name" value={form.name} onChange={(e) => set("name", e.target.value)} placeholder="e.g. Cleveland Clinic" autoFocus />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label>Type</Label>
              <Select value={form.type} onValueChange={(v) => set("type", v)}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="INSTITUTION">Institution</SelectItem>
                  <SelectItem value="COMPANY">Company</SelectItem>
                  <SelectItem value="OTHER">Other</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="payer-tax">Tax / VAT number</Label>
              <Input id="payer-tax" value={form.taxNumber} onChange={(e) => set("taxNumber", e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="payer-contact">Contact name</Label>
              <Input id="payer-contact" value={form.contactName} onChange={(e) => set("contactName", e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="payer-email">Email</Label>
              <Input id="payer-email" type="email" value={form.email} onChange={(e) => set("email", e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="payer-phone">Phone</Label>
              <Input id="payer-phone" value={form.phone} onChange={(e) => set("phone", e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="payer-city">City</Label>
              <Input id="payer-city" value={form.city} onChange={(e) => set("city", e.target.value)} />
            </div>
            <div className="space-y-1.5 col-span-2">
              <Label htmlFor="payer-address">Address</Label>
              <Input id="payer-address" value={form.address} onChange={(e) => set("address", e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="payer-country">Country</Label>
              <Input id="payer-country" value={form.country} onChange={(e) => set("country", e.target.value)} />
            </div>
          </div>
          <p className="text-xs text-muted-foreground">You can complete or edit these details later in Settings → Billing.</p>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={create.isPending}>Cancel</Button>
          <Button onClick={handleSubmit} disabled={create.isPending}>
            {create.isPending ? "Adding…" : "Add payer"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
