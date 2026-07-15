"use client";

/**
 * Edit an account's fields. `needsReview` (the fuzzy-duplicate flag) is dismissed
 * elsewhere (the banner's "It's distinct" button) — this is the plain field editor.
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
import { useUpdateCompany } from "@/crm/hooks/use-crm-api";

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
  const [name, setName] = useState(company.name);
  const [industry, setIndustry] = useState(company.industry ?? "");
  const [website, setWebsite] = useState(company.website ?? "");
  const [country, setCountry] = useState(company.country ?? "");
  const [city, setCity] = useState(company.city ?? "");
  const [notes, setNotes] = useState(company.notes ?? "");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setName(company.name);
    setIndustry(company.industry ?? "");
    setWebsite(company.website ?? "");
    setCountry(company.country ?? "");
    setCity(company.city ?? "");
    setNotes(company.notes ?? "");
  }, [company]);

  const update = useUpdateCompany(company.id);

  async function handleSubmit() {
    if (!name.trim()) {
      toast.error("Give the account a name");
      return;
    }
    setSaving(true);
    try {
      await update.mutateAsync({
        name: name.trim(),
        industry: industry.trim() || null,
        website: website.trim() || null,
        country: country.trim() || null,
        city: city.trim() || null,
        notes: notes.trim() || null,
      });
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

        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="edit-company-name">
              Name <span className="text-destructive">*</span>
            </Label>
            <Input id="edit-company-name" value={name} onChange={(e) => setName(e.target.value)} />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-2">
              <Label htmlFor="edit-company-industry">Industry</Label>
              <Input
                id="edit-company-industry"
                value={industry}
                onChange={(e) => setIndustry(e.target.value)}
                placeholder="Pharma"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="edit-company-website">Website</Label>
              <Input
                id="edit-company-website"
                value={website}
                onChange={(e) => setWebsite(e.target.value)}
                placeholder="abbott.com"
              />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-2">
              <Label htmlFor="edit-company-city">City</Label>
              <Input id="edit-company-city" value={city} onChange={(e) => setCity(e.target.value)} />
            </div>
            <div className="space-y-2">
              <Label htmlFor="edit-company-country">Country</Label>
              <Input id="edit-company-country" value={country} onChange={(e) => setCountry(e.target.value)} />
            </div>
          </div>

          <div className="space-y-2">
            <Label htmlFor="edit-company-notes">Notes</Label>
            <Textarea
              id="edit-company-notes"
              rows={3}
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
            />
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
