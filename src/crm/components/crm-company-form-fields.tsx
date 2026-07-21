"use client";

/**
 * The ONE company (account) form — shared by the create dialog and the account
 * page's edit dialog, so the field set can't drift between the two (same rule
 * as crm-contact-form-fields).
 *
 * The extraction FIXED a real drift: the edit dialog had a free-text country
 * input while create used the searchable CountrySelect — the same field fed by
 * two different controls produces inconsistent country values.
 */
import type { ReactNode } from "react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { CountrySelect } from "@/components/ui/country-select";

export interface CrmCompanyFormState {
  name: string;
  industry: string;
  website: string;
  city: string;
  country: string;
  notes: string;
}

export function emptyCrmCompanyForm(): CrmCompanyFormState {
  return { name: "", industry: "", website: "", city: "", country: "", notes: "" };
}

export function crmCompanyToForm(c: {
  name: string;
  industry?: string | null;
  website?: string | null;
  city?: string | null;
  country?: string | null;
  notes?: string | null;
}): CrmCompanyFormState {
  return {
    name: c.name,
    industry: c.industry ?? "",
    website: c.website ?? "",
    city: c.city ?? "",
    country: c.country ?? "",
    notes: c.notes ?? "",
  };
}

/** The API body for POST/PATCH — one trim/null mapping for both callers. */
export function crmCompanyFormPayload(f: CrmCompanyFormState): Record<string, unknown> {
  return {
    name: f.name.trim(),
    industry: f.industry.trim() || null,
    website: f.website.trim() || null,
    city: f.city.trim() || null,
    country: f.country.trim() || null,
    notes: f.notes.trim() || null,
  };
}

export function CrmCompanyFormFields({
  value,
  onChange,
  idPrefix,
  nameHint,
}: {
  value: CrmCompanyFormState;
  onChange: (patch: Partial<CrmCompanyFormState>) => void;
  idPrefix: string;
  /** Caller-specific helper under the name input (create's find-or-create note). */
  nameHint?: ReactNode;
}) {
  const f = value;

  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <Label htmlFor={`${idPrefix}-name`}>
          Name <span className="text-destructive">*</span>
        </Label>
        <Input
          id={`${idPrefix}-name`}
          value={f.name}
          onChange={(e) => onChange({ name: e.target.value })}
          placeholder="Abbott"
        />
        {nameHint}
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-2">
          <Label htmlFor={`${idPrefix}-industry`}>Industry</Label>
          <Input
            id={`${idPrefix}-industry`}
            value={f.industry}
            onChange={(e) => onChange({ industry: e.target.value })}
            placeholder="Pharma"
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor={`${idPrefix}-website`}>Website</Label>
          <Input
            id={`${idPrefix}-website`}
            value={f.website}
            onChange={(e) => onChange({ website: e.target.value })}
            placeholder="abbott.com"
          />
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-2">
          <Label htmlFor={`${idPrefix}-city`}>City</Label>
          <Input id={`${idPrefix}-city`} value={f.city} onChange={(e) => onChange({ city: e.target.value })} />
        </div>
        <div className="space-y-2">
          <Label>Country</Label>
          <CountrySelect value={f.country} onChange={(v) => onChange({ country: v ?? "" })} />
        </div>
      </div>

      <div className="space-y-2">
        <Label htmlFor={`${idPrefix}-notes`}>Notes</Label>
        <Textarea
          id={`${idPrefix}-notes`}
          rows={3}
          value={f.notes}
          onChange={(e) => onChange({ notes: e.target.value })}
        />
      </div>
    </div>
  );
}
