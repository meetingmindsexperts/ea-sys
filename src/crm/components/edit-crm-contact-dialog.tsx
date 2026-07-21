"use client";

/**
 * Edit a CRM contact (a rep / procurement / marketing person — NOT an HCP).
 *
 * Company is a picker over existing accounts (contacts hang off accounts we already
 * know). Email is editable — the service keeps the dedup key in lockstep, so a
 * rename can't sneak a duplicate through.
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
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { CountrySelect } from "@/components/ui/country-select";
import { TagInput } from "@/components/ui/tag-input";
import { useCrmCompanies, useUpdateCrmContact } from "@/crm/hooks/use-crm-api";
import {
  CONTACT_STATUS_LABELS,
  CONTACT_STATUS_VALUES,
  LIFECYCLE_LABELS,
  type CrmContactStatus,
  type CrmLifecycleStage,
} from "@/crm/lib/crm-types";

const NO_COMPANY = "__none__";
const NO_LIFECYCLE = "__none__";
const NO_STATUS = "__none__";

export interface EditableCrmContact {
  id: string;
  firstName: string;
  lastName: string;
  email: string;
  jobTitle?: string | null;
  phone?: string | null;
  mobile?: string | null;
  country?: string | null;
  notes?: string | null;
  lifecycleStage?: CrmLifecycleStage | null;
  status?: CrmContactStatus | null;
  tags?: string[];
  company?: { id: string; name: string } | null;
}

export function EditCrmContactDialog({
  contact,
  open,
  onOpenChange,
}: {
  contact: EditableCrmContact;
  open: boolean;
  onOpenChange: (o: boolean) => void;
}) {
  const [firstName, setFirstName] = useState(contact.firstName);
  const [lastName, setLastName] = useState(contact.lastName);
  const [email, setEmail] = useState(contact.email);
  const [jobTitle, setJobTitle] = useState(contact.jobTitle ?? "");
  const [phone, setPhone] = useState(contact.phone ?? "");
  const [mobile, setMobile] = useState(contact.mobile ?? "");
  const [country, setCountry] = useState(contact.country ?? "");
  const [notes, setNotes] = useState(contact.notes ?? "");
  const [lifecycle, setLifecycle] = useState<string>(contact.lifecycleStage ?? NO_LIFECYCLE);
  const [status, setStatus] = useState<string>(contact.status ?? NO_STATUS);
  const [tags, setTags] = useState<string[]>(contact.tags ?? []);
  const [companyId, setCompanyId] = useState<string>(contact.company?.id ?? NO_COMPANY);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setFirstName(contact.firstName);
    setLastName(contact.lastName);
    setEmail(contact.email);
    setJobTitle(contact.jobTitle ?? "");
    setPhone(contact.phone ?? "");
    setMobile(contact.mobile ?? "");
    setCountry(contact.country ?? "");
    setNotes(contact.notes ?? "");
    setLifecycle(contact.lifecycleStage ?? NO_LIFECYCLE);
    setStatus(contact.status ?? NO_STATUS);
    setTags(contact.tags ?? []);
    setCompanyId(contact.company?.id ?? NO_COMPANY);
  }, [contact]);

  const { data: companies = [] } = useCrmCompanies();
  const update = useUpdateCrmContact(contact.id);

  async function handleSubmit() {
    if (!firstName.trim() || !lastName.trim()) {
      toast.error("First and last name are required");
      return;
    }
    if (!email.trim()) {
      toast.error("Email is required");
      return;
    }
    setSaving(true);
    try {
      await update.mutateAsync({
        firstName: firstName.trim(),
        lastName: lastName.trim(),
        email: email.trim(),
        jobTitle: jobTitle.trim() || null,
        phone: phone.trim() || null,
        mobile: mobile.trim() || null,
        country: country.trim() || null,
        notes: notes.trim() || null,
        lifecycleStage: lifecycle === NO_LIFECYCLE ? null : lifecycle,
        status: status === NO_STATUS ? null : status,
        tags,
        companyId: companyId === NO_COMPANY ? null : companyId,
      });
      toast.success("Contact updated");
      onOpenChange(false);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not update the contact");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Edit contact</DialogTitle>
          <DialogDescription asChild>
            <span>Changes are recorded in the contact&apos;s history.</span>
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-2">
              <Label htmlFor="edit-contact-first">
                First name <span className="text-destructive">*</span>
              </Label>
              <Input id="edit-contact-first" value={firstName} onChange={(e) => setFirstName(e.target.value)} />
            </div>
            <div className="space-y-2">
              <Label htmlFor="edit-contact-last">
                Last name <span className="text-destructive">*</span>
              </Label>
              <Input id="edit-contact-last" value={lastName} onChange={(e) => setLastName(e.target.value)} />
            </div>
          </div>

          <div className="space-y-2">
            <Label htmlFor="edit-contact-email">
              Email <span className="text-destructive">*</span>
            </Label>
            <Input id="edit-contact-email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-2">
              <Label htmlFor="edit-contact-job">Job title</Label>
              <Input id="edit-contact-job" value={jobTitle} onChange={(e) => setJobTitle(e.target.value)} />
            </div>
            <div className="space-y-2">
              <Label htmlFor="edit-contact-phone">Phone</Label>
              <Input id="edit-contact-phone" value={phone} onChange={(e) => setPhone(e.target.value)} />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-2">
              <Label htmlFor="edit-contact-mobile">Mobile</Label>
              <Input id="edit-contact-mobile" value={mobile} onChange={(e) => setMobile(e.target.value)} placeholder="+971 50 …" />
            </div>
            <div className="space-y-2">
              <Label htmlFor="edit-contact-status">Status</Label>
              <Select value={status} onValueChange={setStatus}>
                <SelectTrigger id="edit-contact-status" className="w-full">
                  <SelectValue placeholder="None" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={NO_STATUS}>None</SelectItem>
                  {CONTACT_STATUS_VALUES.map((s) => (
                    <SelectItem key={s} value={s}>
                      {CONTACT_STATUS_LABELS[s]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-2">
              <Label htmlFor="edit-contact-company">Company</Label>
              <Select value={companyId} onValueChange={setCompanyId}>
                <SelectTrigger id="edit-contact-company" className="w-full">
                  <SelectValue placeholder="No company" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={NO_COMPANY}>No company</SelectItem>
                  {companies.map((c) => (
                    <SelectItem key={c.id} value={c.id}>
                      {c.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label htmlFor="edit-contact-lifecycle">Lifecycle</Label>
              <Select value={lifecycle} onValueChange={setLifecycle}>
                <SelectTrigger id="edit-contact-lifecycle" className="w-full">
                  <SelectValue placeholder="None" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={NO_LIFECYCLE}>None</SelectItem>
                  {(Object.keys(LIFECYCLE_LABELS) as CrmLifecycleStage[]).map((s) => (
                    <SelectItem key={s} value={s}>
                      {LIFECYCLE_LABELS[s]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="space-y-2">
            <Label>Country</Label>
            <CountrySelect value={country} onChange={setCountry} />
          </div>

          <div className="space-y-2">
            <Label>Tags</Label>
            <TagInput value={tags} onChange={setTags} placeholder="Add tag…" />
          </div>

          <div className="space-y-2">
            <Label htmlFor="edit-contact-notes">Notes</Label>
            <Textarea id="edit-contact-notes" rows={3} value={notes} onChange={(e) => setNotes(e.target.value)} />
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
