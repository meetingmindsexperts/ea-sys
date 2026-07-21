"use client";

/**
 * Add a business contact. Find-or-create by email, so entering someone who already
 * exists LINKS to them rather than minting a second row for one human.
 *
 * The fields live in the shared CrmContactFormFields (also the contact page's
 * inline editor) — one form, no drift.
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
import { useCreateCrmContact } from "@/crm/hooks/use-crm-api";
import {
  CrmContactFormFields,
  crmContactFormPayload,
  crmContactFormValid,
  emptyCrmContactForm,
  type CrmContactFormState,
} from "@/crm/components/crm-contact-form-fields";

export function CreateCrmContactDialog({
  open,
  onOpenChange,
  defaultCompanyId,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  /** Pre-select the account — the "Add contact" button on a company page. */
  defaultCompanyId?: string;
}) {
  const [form, setForm] = useState<CrmContactFormState>(() => emptyCrmContactForm({ companyId: defaultCompanyId }));
  const create = useCreateCrmContact();

  function reset() {
    setForm(emptyCrmContactForm({ companyId: defaultCompanyId }));
  }

  async function handleSubmit() {
    if (!crmContactFormValid(form)) return;
    await create.mutateAsync(crmContactFormPayload(form));
    reset();
    onOpenChange(false);
  }

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) reset(); onOpenChange(o); }}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>New CRM contact</DialogTitle>
          <DialogDescription asChild>
            <span>
              A rep, exhibitor sales manager or procurement officer — not a doctor.
              HCPs belong in the event contact store.
            </span>
          </DialogDescription>
        </DialogHeader>

        <CrmContactFormFields
          value={form}
          onChange={(patch) => setForm((f) => ({ ...f, ...patch }))}
          idPrefix="cc"
          showNotes={false}
          emailHint={
            <p className="text-xs text-muted-foreground">
              If this person already exists, you&apos;ll be linked to them — no duplicate.
            </p>
          }
        />

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={handleSubmit} disabled={!crmContactFormValid(form) || create.isPending}>
            {create.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
