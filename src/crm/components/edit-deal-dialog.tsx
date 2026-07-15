"use client";

/**
 * Edit a deal's fields. Stage is NOT here (it moves on the board, with the
 * from-stage concurrency claim); won/lost is NOT here (it's the Close action).
 * This is the "fix the value / rename it / re-tag the event" dialog.
 *
 * The company field is the same find-or-create combobox as the create dialog, so
 * re-pointing a deal at "Abbott" links to the existing account rather than minting
 * a duplicate. The server diffs before→after, so sending the whole form (even
 * unchanged fields) records only what actually changed.
 */
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Loader2 } from "lucide-react";
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
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useCreateCompany, useUpdateDeal } from "@/crm/hooks/use-crm-api";
import { CompanyCombobox, type CompanySelection } from "@/crm/components/company-combobox";
import { EventCombobox } from "@/crm/components/event-combobox";
import type { CrmBoardDeal } from "@/crm/lib/crm-types";

function toDateInput(v?: string | null): string {
  if (!v) return "";
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? "" : d.toISOString().slice(0, 10);
}

export function EditDealDialog({
  deal,
  open,
  onOpenChange,
}: {
  deal: CrmBoardDeal;
  open: boolean;
  onOpenChange: (o: boolean) => void;
}) {
  const [name, setName] = useState(deal.name);
  const [company, setCompany] = useState<CompanySelection | null>(
    deal.company ? { id: deal.company.id, name: deal.company.name } : null,
  );
  const [dealValue, setDealValue] = useState(deal.dealValue != null ? String(deal.dealValue) : "");
  const [currency, setCurrency] = useState(deal.currency || "USD");
  const [eventId, setEventId] = useState<string | null>(deal.event?.id ?? null);
  const [expectedClose, setExpectedClose] = useState(toDateInput(deal.expectedClose));
  const [saving, setSaving] = useState(false);

  // Re-seed the form whenever a different deal is opened.
  useEffect(() => {
    setName(deal.name);
    setCompany(deal.company ? { id: deal.company.id, name: deal.company.name } : null);
    setDealValue(deal.dealValue != null ? String(deal.dealValue) : "");
    setCurrency(deal.currency || "USD");
    setEventId(deal.event?.id ?? null);
    setExpectedClose(toDateInput(deal.expectedClose));
  }, [deal]);

  const createCompany = useCreateCompany();
  const update = useUpdateDeal(deal.id);

  async function handleSubmit() {
    if (!name.trim()) {
      toast.error("Give the deal a name");
      return;
    }
    const parsedValue = dealValue.trim() ? Number(dealValue) : null;
    if (parsedValue !== null && !Number.isFinite(parsedValue)) {
      toast.error("Deal value must be a number");
      return;
    }

    setSaving(true);
    try {
      // Existing account → its id; a to-be-created one → find-or-create (server
      // dedups, so we never mint a duplicate).
      let companyId: string | null = null;
      if (company) {
        companyId = company.id ?? (await createCompany.mutateAsync({ name: company.name })).company.id;
      }

      await update.mutateAsync({
        name: name.trim(),
        companyId,
        eventId,
        dealValue: parsedValue,
        currency,
        expectedClose: expectedClose || null,
      });

      toast.success("Deal updated");
      onOpenChange(false);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not update the deal");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Edit deal</DialogTitle>
          <DialogDescription asChild>
            <span>Changes are recorded in the deal&apos;s history.</span>
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="edit-deal-name">
              Name <span className="text-destructive">*</span>
            </Label>
            <Input id="edit-deal-name" value={name} onChange={(e) => setName(e.target.value)} />
          </div>

          <div className="space-y-2">
            <Label>Company</Label>
            <CompanyCombobox value={company} onChange={setCompany} />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-2">
              <Label htmlFor="edit-deal-value">Value</Label>
              <Input
                id="edit-deal-value"
                inputMode="decimal"
                value={dealValue}
                onChange={(e) => setDealValue(e.target.value)}
                placeholder="40000"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="edit-deal-currency">Currency</Label>
              <Select value={currency} onValueChange={setCurrency}>
                <SelectTrigger id="edit-deal-currency" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {["USD", "AED", "EUR", "GBP", "SAR"].map((c) => (
                    <SelectItem key={c} value={c}>
                      {c}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-2">
              <Label htmlFor="edit-deal-close">Expected close</Label>
              <Input
                id="edit-deal-close"
                type="date"
                value={expectedClose}
                onChange={(e) => setExpectedClose(e.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label>Event</Label>
              <EventCombobox value={eventId} onChange={setEventId} clearLabel="No event" className="w-full" />
            </div>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={handleSubmit} disabled={saving}>
            {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
