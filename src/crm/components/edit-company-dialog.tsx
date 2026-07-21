"use client";

/**
 * Edit an account's fields. `needsReview` (the fuzzy-duplicate flag) is dismissed
 * elsewhere (the banner's "It's distinct" button) — this is the plain field editor.
 *
 * Fields live in the shared CrmCompanyFormFields (also the create dialog) — the
 * extraction fixed a drift where this dialog's country was a free-text input.
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
import { useUpdateCompany } from "@/crm/hooks/use-crm-api";
import {
  CrmCompanyFormFields,
  crmCompanyFormPayload,
  crmCompanyToForm,
  type CrmCompanyFormState,
} from "@/crm/components/crm-company-form-fields";

export interface EditableCompany {
  id: string;
  name: string;
  industry?: string | null;
  website?: string | null;
  country?: string | null;
  city?: string | null;
  notes?: string | null;
}

export function EditCompanyDialog({
  company,
  open,
  onOpenChange,
}: {
  company: EditableCompany;
  open: boolean;
  onOpenChange: (o: boolean) => void;
}) {
  const [form, setForm] = useState<CrmCompanyFormState>(() => crmCompanyToForm(company));
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setForm(crmCompanyToForm(company));
  }, [company]);

  const update = useUpdateCompany(company.id);

  async function handleSubmit() {
    if (!form.name.trim()) {
      toast.error("Give the account a name");
      return;
    }
    setSaving(true);
    try {
      await update.mutateAsync(crmCompanyFormPayload(form));
      toast.success("Account updated");
      onOpenChange(false);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not update the account");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Edit account</DialogTitle>
          <DialogDescription asChild>
            <span>Changes are recorded in the account&apos;s history.</span>
          </DialogDescription>
        </DialogHeader>

        <CrmCompanyFormFields
          value={form}
          onChange={(patch) => setForm((f) => ({ ...f, ...patch }))}
          idPrefix="edit-company"
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
