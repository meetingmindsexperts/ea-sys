"use client";

/**
 * Create a deal.
 *
 * The company field is a free-text combobox on purpose: it POSTs to the
 * find-or-create endpoint, so typing "Abbott" when Abbott already exists LINKS to
 * the existing account rather than minting a second one. The toast then tells you
 * which happened ("Linked to the existing account…" vs "Created…"), because a UI
 * that says "Created Abbott" when it merely found Abbott is lying to you.
 */
import { useState } from "react";
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
import { useCreateCompany, useCreateDeal } from "@/crm/hooks/use-crm-api";
import { CompanyCombobox, type CompanySelection } from "@/crm/components/company-combobox";
import { EventCombobox } from "@/crm/components/event-combobox";
import type { CrmStage } from "@/crm/lib/crm-types";

export function CreateDealDialog({
  open,
  onOpenChange,
  stages,
  defaultEventId,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  stages: CrmStage[];
  defaultEventId?: string | null;
}) {
  const [name, setName] = useState("");
  const [company, setCompany] = useState<CompanySelection | null>(null);
  const [dealValue, setDealValue] = useState("");
  const [currency, setCurrency] = useState("USD");
  const [stageId, setStageId] = useState("");
  const [eventId, setEventId] = useState<string | null>(defaultEventId ?? null);
  const [expectedClose, setExpectedClose] = useState("");
  const [saving, setSaving] = useState(false);

  const createCompany = useCreateCompany();
  const createDeal = useCreateDeal();

  // Default to the first non-terminal stage — a new deal starts at the top of the
  // funnel, never in "Won".
  const firstOpenStage = stages.find((s) => !s.isTerminal)?.id ?? stages[0]?.id ?? "";
  const effectiveStage = stageId || firstOpenStage;

  function reset() {
    setName("");
    setCompany(null);
    setDealValue("");
    setCurrency("USD");
    setStageId("");
    setEventId(defaultEventId ?? null);
    setExpectedClose("");
  }

  async function handleSubmit() {
    if (!name.trim()) {
      toast.error("Give the deal a name");
      return;
    }
    if (!eventId) {
      toast.error("Select the event (project) this deal is for");
      return;
    }
    if (!effectiveStage) {
      toast.error("Pick a pipeline stage");
      return;
    }

    setSaving(true);
    try {
      // The picker gives us either an existing account (id) or a to-be-created one
      // (id null + name). Find-or-create the latter so the deal always hangs off a
      // real company row rather than a free-text string (the thing this module
      // exists to fix); the server dedups, so a typed name that already exists links.
      let companyId: string | null = null;
      if (company) {
        companyId = company.id ?? (await createCompany.mutateAsync({ name: company.name })).company.id;
      }

      const parsedValue = dealValue.trim() ? Number(dealValue) : null;
      if (parsedValue !== null && !Number.isFinite(parsedValue)) {
        toast.error("Deal value must be a number");
        setSaving(false);
        return;
      }

      await createDeal.mutateAsync({
        name: name.trim(),
        stageId: effectiveStage,
        companyId,
        eventId,
        dealValue: parsedValue,
        currency,
        expectedClose: expectedClose || null,
      });

      toast.success("Deal created");
      reset();
      onOpenChange(false);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not create the deal");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) reset(); onOpenChange(o); }}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>New deal</DialogTitle>
          <DialogDescription asChild>
            <span>Track a sponsorship or exhibitor opportunity against an event.</span>
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="deal-name">
              Name <span className="text-destructive">*</span>
            </Label>
            <Input
              id="deal-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Abbott — BRIDGES 2026 Gold"
            />
          </div>

          <div className="space-y-2">
            <Label>
              Event (project) <span className="text-destructive">*</span>
            </Label>
            <EventCombobox
              value={eventId}
              onChange={setEventId}
              allowClear={false}
              placeholder="Select an event…"
              className="w-full"
            />
            <p className="text-xs text-muted-foreground">Every deal is sold against a project.</p>
          </div>

          <div className="space-y-2">
            <Label>Company</Label>
            <CompanyCombobox value={company} onChange={setCompany} />
            <p className="text-xs text-muted-foreground">
              Pick an existing account, or type a new name to create one.
            </p>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-2">
              <Label htmlFor="deal-value">Value</Label>
              <Input
                id="deal-value"
                inputMode="decimal"
                value={dealValue}
                onChange={(e) => setDealValue(e.target.value)}
                placeholder="40000"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="deal-currency">Currency</Label>
              <Select value={currency} onValueChange={setCurrency}>
                <SelectTrigger id="deal-currency" className="w-full">
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
              <Label htmlFor="deal-stage">Stage</Label>
              <Select value={effectiveStage} onValueChange={setStageId}>
                <SelectTrigger id="deal-stage" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {stages.map((s) => (
                    <SelectItem key={s.id} value={s.id}>
                      {s.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label htmlFor="deal-close">Expected close</Label>
              <Input
                id="deal-close"
                type="date"
                value={expectedClose}
                onChange={(e) => setExpectedClose(e.target.value)}
              />
            </div>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={handleSubmit} disabled={saving}>
            {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            Create deal
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
