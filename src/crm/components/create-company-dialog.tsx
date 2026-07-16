"use client";

/**
 * Create a company. Uses the find-or-create endpoint, so submitting a name that
 * already exists LINKS rather than duplicates — the hook's toast says which
 * happened, because a UI that claims it "created Abbott" when it merely found
 * Abbott is lying.
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
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { CountrySelect } from "@/components/ui/country-select";
import { useCreateCompany } from "@/crm/hooks/use-crm-api";

export function CreateCompanyDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
}) {
  const [name, setName] = useState("");
  const [industry, setIndustry] = useState("");
  const [website, setWebsite] = useState("");
  const [city, setCity] = useState("");
  const [country, setCountry] = useState<string | null>(null);
  const [notes, setNotes] = useState("");

  const create = useCreateCompany();

  function reset() {
    setName("");
    setIndustry("");
    setWebsite("");
    setCity("");
    setCountry(null);
    setNotes("");
  }

  async function handleSubmit() {
    if (!name.trim()) return;
    try {
      await create.mutateAsync({
        name: name.trim(),
        industry: industry.trim() || null,
        website: website.trim() || null,
        city: city.trim() || null,
        country: country || null,
        notes: notes.trim() || null,
      });
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

        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="c-name">
              Name <span className="text-destructive">*</span>
            </Label>
            <Input
              id="c-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Abbott"
            />
            <p className="text-xs text-muted-foreground">
              If this account already exists, you&apos;ll be linked to it rather than creating a duplicate.
            </p>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-2">
              <Label htmlFor="c-industry">Industry</Label>
              <Input
                id="c-industry"
                value={industry}
                onChange={(e) => setIndustry(e.target.value)}
                placeholder="Pharma"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="c-website">Website</Label>
              <Input
                id="c-website"
                value={website}
                onChange={(e) => setWebsite(e.target.value)}
                placeholder="abbott.com"
              />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-2">
              <Label htmlFor="c-city">City</Label>
              <Input id="c-city" value={city} onChange={(e) => setCity(e.target.value)} />
            </div>
            <div className="space-y-2">
              <Label>Country</Label>
              <CountrySelect value={country} onChange={setCountry} />
            </div>
          </div>

          <div className="space-y-2">
            <Label htmlFor="c-notes">Notes</Label>
            <Textarea id="c-notes" rows={3} value={notes} onChange={(e) => setNotes(e.target.value)} />
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={handleSubmit} disabled={!name.trim() || create.isPending}>
            {create.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
