"use client";

/**
 * Add a business contact. Find-or-create by email, so entering someone who already
 * exists LINKS to them rather than minting a second row for one human.
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
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { CountrySelect } from "@/components/ui/country-select";
import { useCreateCrmContact, useCrmCompanies } from "@/crm/hooks/use-crm-api";
import { LIFECYCLE_LABELS, type CrmLifecycleStage } from "@/crm/lib/crm-types";

const NO_COMPANY = "__none__";
const NO_STAGE = "__none__";

export function CreateCrmContactDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
}) {
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [email, setEmail] = useState("");
  const [jobTitle, setJobTitle] = useState("");
  const [phone, setPhone] = useState("");
  const [country, setCountry] = useState("");
  const [companyId, setCompanyId] = useState(NO_COMPANY);
  const [stage, setStage] = useState(NO_STAGE);

  const { data: companies = [] } = useCrmCompanies();
  const create = useCreateCrmContact();

  function reset() {
    setFirstName(""); setLastName(""); setEmail("");
    setJobTitle(""); setPhone(""); setCountry("");
    setCompanyId(NO_COMPANY); setStage(NO_STAGE);
  }

  async function handleSubmit() {
    if (!firstName.trim() || !lastName.trim() || !email.trim()) return;
    await create.mutateAsync({
      firstName: firstName.trim(),
      lastName: lastName.trim(),
      email: email.trim(),
      jobTitle: jobTitle.trim() || null,
      phone: phone.trim() || null,
      country: country.trim() || null,
      companyId: companyId === NO_COMPANY ? null : companyId,
      lifecycleStage: stage === NO_STAGE ? null : (stage as CrmLifecycleStage),
    });
    reset();
    onOpenChange(false);
  }

  const valid = firstName.trim() && lastName.trim() && email.trim();

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

        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-2">
              <Label htmlFor="cc-first">
                First name <span className="text-destructive">*</span>
              </Label>
              <Input id="cc-first" value={firstName} onChange={(e) => setFirstName(e.target.value)} />
            </div>
            <div className="space-y-2">
              <Label htmlFor="cc-last">
                Last name <span className="text-destructive">*</span>
              </Label>
              <Input id="cc-last" value={lastName} onChange={(e) => setLastName(e.target.value)} />
            </div>
          </div>

          <div className="space-y-2">
            <Label htmlFor="cc-email">
              Email <span className="text-destructive">*</span>
            </Label>
            <Input
              id="cc-email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="s.khan@abbott.com"
            />
            <p className="text-xs text-muted-foreground">
              If this person already exists, you&apos;ll be linked to them — no duplicate.
            </p>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-2">
              <Label htmlFor="cc-job">Job title</Label>
              <Input
                id="cc-job"
                value={jobTitle}
                onChange={(e) => setJobTitle(e.target.value)}
                placeholder="Regional Medical Affairs Lead"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="cc-phone">Phone</Label>
              <Input id="cc-phone" value={phone} onChange={(e) => setPhone(e.target.value)} />
            </div>
          </div>

          <div className="space-y-2">
            <Label>Country</Label>
            <CountrySelect value={country} onChange={setCountry} />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-2">
              <Label>Company</Label>
              <Select value={companyId} onValueChange={setCompanyId}>
                <SelectTrigger className="w-full">
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
              <Label>Lifecycle</Label>
              <Select value={stage} onValueChange={setStage}>
                <SelectTrigger className="w-full">
                  <SelectValue placeholder="—" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={NO_STAGE}>—</SelectItem>
                  {(Object.keys(LIFECYCLE_LABELS) as CrmLifecycleStage[]).map((s) => (
                    <SelectItem key={s} value={s}>
                      {LIFECYCLE_LABELS[s]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={handleSubmit} disabled={!valid || create.isPending}>
            {create.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
