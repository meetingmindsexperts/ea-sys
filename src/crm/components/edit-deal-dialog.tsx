"use client";

/**
 * Edit a deal's fields. Stage is NOT here (it moves on the board, with the
 * from-stage concurrency claim); won/lost is NOT here (it's the Close action).
 * This is the "fix the value / rename it / re-tag the event" dialog.
 *
 * Fields live in the shared CrmDealFormFields (also the create dialog) — one
 * form, one currency list, one find-or-create company step. The server diffs
 * before→after, so sending the whole form records only what actually changed.
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
import { useCreateCompany, useUpdateDeal } from "@/crm/hooks/use-crm-api";
import {
  CrmDealFormFields,
  crmDealFormPayload,
  crmDealToForm,
  resolveDealCompanyId,
  validateDealForm,
  type CrmDealFormState,
} from "@/crm/components/crm-deal-form-fields";
import type { CrmBoardDeal } from "@/crm/lib/crm-types";

export function EditDealDialog({
  deal,
  open,
  onOpenChange,
}: {
  deal: CrmBoardDeal;
  open: boolean;
  onOpenChange: (o: boolean) => void;
}) {
  const [form, setForm] = useState<CrmDealFormState>(() => crmDealToForm(deal));
  const [saving, setSaving] = useState(false);

  // Re-seed the form whenever a different deal is opened.
  useEffect(() => {
    setForm(crmDealToForm(deal));
  }, [deal]);

  const createCompany = useCreateCompany();
  const update = useUpdateDeal(deal.id);

  async function handleSubmit() {
    const invalid = validateDealForm(form);
    if (invalid) {
      toast.error(invalid);
      return;
    }

    setSaving(true);
    try {
      const companyId = await resolveDealCompanyId(form.company, (b) => createCompany.mutateAsync(b));

      await update.mutateAsync(crmDealFormPayload(form, companyId));

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

        <CrmDealFormFields
          value={form}
          onChange={(patch) => setForm((f) => ({ ...f, ...patch }))}
          idPrefix="edit-deal"
        />

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
