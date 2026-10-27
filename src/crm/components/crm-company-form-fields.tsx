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
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { CountrySelect } from "@/components/ui/country-select";
import { TagInput } from "@/components/ui/tag-input";
import { useCrmReps } from "@/crm/hooks/use-crm-api";
import { NO_OWNER } from "@/crm/components/crm-contact-form-fields";

export interface CrmCompanyFormState {
  name: string;
  industry: string;
  website: string;
  phone: string;
  city: string;
  country: string;
  notes: string;
  tags: string[];
  /**
   * Edit only (Oct 27, 2026). Undefined on create, where the field is not shown
   * and not sent; NO_OWNER means "unassigned".
   */
  ownerId?: string;
}

export function emptyCrmCompanyForm(): CrmCompanyFormState {
  return { name: "", industry: "", website: "", phone: "", city: "", country: "", notes: "", tags: [] };
}

export function crmCompanyToForm(c: {
  name: string;
  industry?: string | null;
  website?: string | null;
  phone?: string | null;
  city?: string | null;
  country?: string | null;
  notes?: string | null;
  tags?: string[];
  owner?: { id: string } | null;
}): CrmCompanyFormState {
  return {
    name: c.name,
    industry: c.industry ?? "",
    website: c.website ?? "",
    phone: c.phone ?? "",
    city: c.city ?? "",
    country: c.country ?? "",
    notes: c.notes ?? "",
    tags: c.tags ?? [],
    ownerId: c.owner?.id ?? NO_OWNER,
  };
}

/** The API body for POST/PATCH — one trim/null mapping for both callers. */
export function crmCompanyFormPayload(f: CrmCompanyFormState): Record<string, unknown> {
  return {
    name: f.name.trim(),
    industry: f.industry.trim() || null,
    website: f.website.trim() || null,
    phone: f.phone.trim() || null,
    city: f.city.trim() || null,
    country: f.country.trim() || null,
    notes: f.notes.trim() || null,
    tags: f.tags,
    ...(f.ownerId === undefined ? {} : { ownerId: f.ownerId === NO_OWNER ? null : f.ownerId }),
  };
}

export function CrmCompanyFormFields({
  value,
  onChange,
  idPrefix,
  nameHint,
  currentOwner = null,
}: {
  value: CrmCompanyFormState;
  onChange: (patch: Partial<CrmCompanyFormState>) => void;
  idPrefix: string;
  /** Caller-specific helper under the name input (create's find-or-create note). */
  nameHint?: ReactNode;
  /**
   * The account's owner as saved. The picker lists reps only, so an owner who
   * holds CRM rights some other way (a custom role) is added so the field never
   * renders blank.
   */
  currentOwner?: { id: string; firstName: string | null; lastName: string | null } | null;
}) {
  const f = value;
  const { data: reps = [] } = useCrmReps();
  const ownerOptions =
    currentOwner && !reps.some((u) => u.id === currentOwner.id) ? [...reps, currentOwner] : reps;

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
          <Label htmlFor={`${idPrefix}-phone`}>Phone</Label>
          <Input
            id={`${idPrefix}-phone`}
            value={f.phone}
            onChange={(e) => onChange({ phone: e.target.value })}
            placeholder="+971 4 000 0000"
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor={`${idPrefix}-city`}>City</Label>
          <Input id={`${idPrefix}-city`} value={f.city} onChange={(e) => onChange({ city: e.target.value })} />
        </div>
      </div>

      <div className="space-y-2">
        <Label>Country</Label>
        <CountrySelect value={f.country} onChange={(v) => onChange({ country: v ?? "" })} />
      </div>

      {f.ownerId !== undefined && (
        <div className="space-y-2">
          <Label htmlFor={`${idPrefix}-owner`}>Owner</Label>
          <Select value={f.ownerId} onValueChange={(v) => onChange({ ownerId: v })}>
            <SelectTrigger id={`${idPrefix}-owner`} className="w-full">
              <SelectValue placeholder="Unassigned" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={NO_OWNER}>Unassigned</SelectItem>
              {ownerOptions.map((u) => (
                <SelectItem key={u.id} value={u.id}>
                  {u.firstName} {u.lastName}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      )}

      <div className="space-y-2">
        <Label>Tags</Label>
        <TagInput value={f.tags} onChange={(tags) => onChange({ tags })} placeholder="Add tag…" />
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
