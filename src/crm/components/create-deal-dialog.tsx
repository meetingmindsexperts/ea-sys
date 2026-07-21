"use client";

/**
 * Create a deal.
 *
 * Fields live in the shared CrmDealFormFields (also the edit dialog) — one
 * form, no drift. Only the Stage picker is create-specific (edits move stage on
 * the board), passed through the form's extraField slot.
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
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useCreateCompany, useCreateDeal } from "@/crm/hooks/use-crm-api";
import { type CompanySelection } from "@/crm/components/company-combobox";
import {
  CrmDealFormFields,
  crmDealFormPayload,
  emptyCrmDealForm,
  resolveDealCompanyId,
  validateDealForm,
  type CrmDealFormState,
} from "@/crm/components/crm-deal-form-fields";
import { defaultOpenStage, type CrmStage } from "@/crm/lib/crm-types";

export function CreateDealDialog({
  open,
  onOpenChange,
  stages,
  defaultEventId,
  defaultCompany,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  stages: CrmStage[];
  defaultEventId?: string | null;
  /** Pre-select the account — the "New deal" button on a company page. */
  defaultCompany?: CompanySelection | null;
}) {
  const [form, setForm] = useState<CrmDealFormState>(() =>
    emptyCrmDealForm({ eventId: defaultEventId, company: defaultCompany }),
  );
  const [stageId, setStageId] = useState("");
  const [saving, setSaving] = useState(false);

  const createCompany = useCreateCompany();
  const createDeal = useCreateDeal();

  // Default to the first non-terminal stage — a new deal starts at the top of the
  // funnel, never in "Won". ONE home for the rule, shared with the MCP create
  // tool (review R2-M10).
  const firstOpenStage = defaultOpenStage(stages)?.id ?? "";
  const effectiveStage = stageId || firstOpenStage;

  function reset() {
    setForm(emptyCrmDealForm({ eventId: defaultEventId, company: defaultCompany }));
    setStageId("");
  }

  async function handleSubmit() {
    const invalid = validateDealForm(form);
    if (invalid) {
      toast.error(invalid);
      return;
    }
    if (!effectiveStage) {
      toast.error("Pick a pipeline stage");
      return;
    }

    setSaving(true);
    try {
      const companyId = await resolveDealCompanyId(form.company, (b) => createCompany.mutateAsync(b));

      await createDeal.mutateAsync({
        ...crmDealFormPayload(form, companyId),
        stageId: effectiveStage,
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

        <CrmDealFormFields
          value={form}
          onChange={(patch) => setForm((f) => ({ ...f, ...patch }))}
          idPrefix="deal"
          eventHint={<p className="text-xs text-muted-foreground">Every deal is sold against a project.</p>}
          companyHint={
            <p className="text-xs text-muted-foreground">
              Pick an existing account, or type a new name to create one.
            </p>
          }
          extraField={
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
          }
        />

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
