"use client";

/**
 * Create a company. Uses the find-or-create endpoint, so submitting a name that
 * already exists LINKS rather than duplicates — the hook's toast says which
 * happened, because a UI that claims it "created Abbott" when it merely found
 * Abbott is lying.
 *
 * Fields live in the shared CrmCompanyFormFields (also the edit dialog) — one
 * form, no drift.
 */
import { useState } from "react";
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
import { useCreateCompany } from "@/crm/hooks/use-crm-api";
import {
  CrmCompanyFormFields,
  crmCompanyFormPayload,
  emptyCrmCompanyForm,
  type CrmCompanyFormState,
} from "@/crm/components/crm-company-form-fields";

export function CreateCompanyDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
}) {
  const [form, setForm] = useState<CrmCompanyFormState>(emptyCrmCompanyForm);
  const create = useCreateCompany();

  function reset() {
    setForm(emptyCrmCompanyForm());
  }

  async function handleSubmit() {
    if (!form.name.trim()) return;
    try {
      await create.mutateAsync(crmCompanyFormPayload(form));
    } catch {
      // Surfaced by the hook's onError toast; keep the dialog open for a retry.
      return;
    }
    reset();
    onOpenChange(false);
  }

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) reset(); onOpenChange(o); }}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>New company</DialogTitle>
          <DialogDescription asChild>
            <span>A sponsor, exhibitor, hospital or society.</span>
          </DialogDescription>
        </DialogHeader>

        <CrmCompanyFormFields
          value={form}
          onChange={(patch) => setForm((f) => ({ ...f, ...patch }))}
          idPrefix="c"
          nameHint={
            <p className="text-xs text-muted-foreground">
              If this account already exists, you&apos;ll be linked to it rather than creating a duplicate.
            </p>
          }
        />

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={handleSubmit} disabled={!form.name.trim() || create.isPending}>
            {create.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
