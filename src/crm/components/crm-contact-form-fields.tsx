"use client";

/**
 * The ONE CRM-contact form — shared by the create dialog and the contact page's
 * inline editor, so the field set cannot drift between the two (the
 * no-cross-caller-duplication rule applied to UI: when "add a field to the
 * contact form" is one change, it lands everywhere).
 *
 * Controlled + presentational: the parent owns a `CrmContactFormState` and gets
 * patches back; submit/cancel affordances stay with the caller.
 */
import type { ReactNode } from "react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { CountrySelect } from "@/components/ui/country-select";
import { TagInput } from "@/components/ui/tag-input";
import { useCrmCompanies, useCrmReps } from "@/crm/hooks/use-crm-api";
import {
  CONTACT_STATUS_LABELS,
  CONTACT_STATUS_VALUES,
  LIFECYCLE_LABELS,
  type CrmContactStatus,
  type CrmLifecycleStage,
} from "@/crm/lib/crm-types";

export const NO_COMPANY = "__none__";
export const NO_LIFECYCLE = "__none__";
export const NO_STATUS = "__none__";
export const NO_OWNER = "__none__";

export interface CrmContactFormState {
  firstName: string;
  lastName: string;
  email: string;
  jobTitle: string;
  phone: string;
  mobile: string;
  country: string;
  notes: string;
  /** Sentinel NO_* values mean "none picked" — mapped to null in the payload. */
  lifecycle: string;
  status: string;
  companyId: string;
  ownerId: string;
  tags: string[];
}

/** Blank form — new contacts start at status NEW (the service's default too). */
export function emptyCrmContactForm(defaults?: { companyId?: string }): CrmContactFormState {
  return {
    firstName: "", lastName: "", email: "",
    jobTitle: "", phone: "", mobile: "", country: "", notes: "",
    lifecycle: NO_LIFECYCLE, status: "NEW",
    companyId: defaults?.companyId ?? NO_COMPANY,
    // NO_OWNER on create means "the creator" — the service defaults it.
    ownerId: NO_OWNER,
    tags: [],
  };
}

/** Seed the form from an existing contact (the inline editor's Edit click). */
export function crmContactToForm(c: {
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
  owner?: { id: string } | null;
}): CrmContactFormState {
  return {
    firstName: c.firstName,
    lastName: c.lastName,
    email: c.email,
    jobTitle: c.jobTitle ?? "",
    phone: c.phone ?? "",
    mobile: c.mobile ?? "",
    country: c.country ?? "",
    notes: c.notes ?? "",
    lifecycle: c.lifecycleStage ?? NO_LIFECYCLE,
    status: c.status ?? NO_STATUS,
    companyId: c.company?.id ?? NO_COMPANY,
    ownerId: c.owner?.id ?? NO_OWNER,
    tags: c.tags ?? [],
  };
}

/** The API body for POST/PATCH — one trim/null mapping for every caller. */
export function crmContactFormPayload(f: CrmContactFormState): Record<string, unknown> {
  return {
    firstName: f.firstName.trim(),
    lastName: f.lastName.trim(),
    email: f.email.trim(),
    jobTitle: f.jobTitle.trim() || null,
    phone: f.phone.trim() || null,
    mobile: f.mobile.trim() || null,
    country: f.country.trim() || null,
    notes: f.notes.trim() || null,
    lifecycleStage: f.lifecycle === NO_LIFECYCLE ? null : f.lifecycle,
    status: f.status === NO_STATUS ? null : f.status,
    companyId: f.companyId === NO_COMPANY ? null : f.companyId,
    // null → the service defaults to the creator on create / unassigns on edit.
    ownerId: f.ownerId === NO_OWNER ? null : f.ownerId,
    tags: f.tags,
  };
}

export function crmContactFormValid(f: CrmContactFormState): boolean {
  return !!(f.firstName.trim() && f.lastName.trim() && f.email.trim());
}

export function CrmContactFormFields({
  value,
  onChange,
  idPrefix,
  emailHint,
  showNotes = true,
  ownerNoneLabel = "Unassigned",
}: {
  value: CrmContactFormState;
  onChange: (patch: Partial<CrmContactFormState>) => void;
  /** Keeps label/input ids unique when two forms are ever mounted at once. */
  idPrefix: string;
  /** Caller-specific helper under the email input (create's find-or-create note). */
  emailHint?: ReactNode;
  showNotes?: boolean;
  /** What "no owner picked" means here — create says "Me (default)", edit says "Unassigned". */
  ownerNoneLabel?: string;
}) {
  const { data: companies = [] } = useCrmCompanies();
  const { data: reps = [] } = useCrmReps();
  const f = value;

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-2">
          <Label htmlFor={`${idPrefix}-first`}>
            First name <span className="text-destructive">*</span>
          </Label>
          <Input id={`${idPrefix}-first`} value={f.firstName} onChange={(e) => onChange({ firstName: e.target.value })} />
        </div>
        <div className="space-y-2">
          <Label htmlFor={`${idPrefix}-last`}>
            Last name <span className="text-destructive">*</span>
          </Label>
          <Input id={`${idPrefix}-last`} value={f.lastName} onChange={(e) => onChange({ lastName: e.target.value })} />
        </div>
      </div>

      <div className="space-y-2">
        <Label htmlFor={`${idPrefix}-email`}>
          Email <span className="text-destructive">*</span>
        </Label>
        <Input
          id={`${idPrefix}-email`}
          type="email"
          value={f.email}
          onChange={(e) => onChange({ email: e.target.value })}
          placeholder="s.khan@abbott.com"
        />
        {emailHint}
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-2">
          <Label htmlFor={`${idPrefix}-job`}>Job title</Label>
          <Input
            id={`${idPrefix}-job`}
            value={f.jobTitle}
            onChange={(e) => onChange({ jobTitle: e.target.value })}
            placeholder="Regional Medical Affairs Lead"
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor={`${idPrefix}-phone`}>Phone</Label>
          <Input id={`${idPrefix}-phone`} value={f.phone} onChange={(e) => onChange({ phone: e.target.value })} />
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-2">
          <Label htmlFor={`${idPrefix}-mobile`}>Mobile</Label>
          <Input
            id={`${idPrefix}-mobile`}
            value={f.mobile}
            onChange={(e) => onChange({ mobile: e.target.value })}
            placeholder="+971 50 …"
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor={`${idPrefix}-status`}>Status</Label>
          <Select value={f.status} onValueChange={(v) => onChange({ status: v })}>
            <SelectTrigger id={`${idPrefix}-status`} className="w-full">
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
          <Label htmlFor={`${idPrefix}-company`}>Company</Label>
          <Select value={f.companyId} onValueChange={(v) => onChange({ companyId: v })}>
            <SelectTrigger id={`${idPrefix}-company`} className="w-full">
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
          <Label htmlFor={`${idPrefix}-lifecycle`}>Lifecycle</Label>
          <Select value={f.lifecycle} onValueChange={(v) => onChange({ lifecycle: v })}>
            <SelectTrigger id={`${idPrefix}-lifecycle`} className="w-full">
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

      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-2">
          <Label htmlFor={`${idPrefix}-owner`}>Owner</Label>
          <Select value={f.ownerId} onValueChange={(v) => onChange({ ownerId: v })}>
            <SelectTrigger id={`${idPrefix}-owner`} className="w-full">
              <SelectValue placeholder={ownerNoneLabel} />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={NO_OWNER}>{ownerNoneLabel}</SelectItem>
              {reps.map((u) => (
                <SelectItem key={u.id} value={u.id}>
                  {u.firstName} {u.lastName}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-2">
          <Label>Country</Label>
          <CountrySelect value={f.country} onChange={(v) => onChange({ country: v })} />
        </div>
      </div>

      <div className="space-y-2">
        <Label>Tags</Label>
        <TagInput value={f.tags} onChange={(tags) => onChange({ tags })} placeholder="Add tag…" />
      </div>

      {showNotes && (
        <div className="space-y-2">
          <Label htmlFor={`${idPrefix}-notes`}>Notes</Label>
          <Textarea id={`${idPrefix}-notes`} rows={3} value={f.notes} onChange={(e) => onChange({ notes: e.target.value })} />
        </div>
      )}
    </div>
  );
}
