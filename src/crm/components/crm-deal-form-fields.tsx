"use client";

/**
 * The ONE deal form — shared by the create and edit dialogs, so the field set,
 * the currency list, the find-or-create company step and the validation cannot
 * drift between the two (same rule as crm-contact-form-fields).
 *
 * Stage is deliberately NOT here: only create picks a stage (edits move on the
 * board with the concurrency claim), so the create dialog passes its Stage
 * select through the `extraField` slot.
 */
import type { ReactNode } from "react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { CompanyCombobox, type CompanySelection } from "@/crm/components/company-combobox";
import { EventCombobox } from "@/crm/components/event-combobox";
import { DEAL_CURRENCIES, type CrmBoardDeal } from "@/crm/lib/crm-types";

export interface CrmDealFormState {
  name: string;
  company: CompanySelection | null;
  /** Raw input text — parsed by validateDealForm/dealFormPayload. */
  dealValue: string;
  currency: string;
  eventId: string | null;
  /** yyyy-mm-dd (date input) or "". */
  expectedClose: string;
}

export function emptyCrmDealForm(defaults?: {
  eventId?: string | null;
  company?: CompanySelection | null;
}): CrmDealFormState {
  return {
    name: "",
    company: defaults?.company ?? null,
    dealValue: "",
    currency: "USD",
    eventId: defaults?.eventId ?? null,
    expectedClose: "",
  };
}

function toDateInput(v?: string | null): string {
  if (!v) return "";
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? "" : d.toISOString().slice(0, 10);
}

export function crmDealToForm(deal: CrmBoardDeal): CrmDealFormState {
  return {
    name: deal.name,
    company: deal.company ? { id: deal.company.id, name: deal.company.name } : null,
    dealValue: deal.dealValue != null ? String(deal.dealValue) : "",
    currency: deal.currency || "USD",
    eventId: deal.event?.id ?? null,
    expectedClose: toDateInput(deal.expectedClose),
  };
}

/** First failing rule as a toast-ready message, or null when the form is sound. */
export function validateDealForm(f: CrmDealFormState): string | null {
  if (!f.name.trim()) return "Give the deal a name";
  if (!f.eventId) return "Select the event (project) this deal is for";
  const v = f.dealValue.trim();
  if (v && !Number.isFinite(Number(v))) return "Deal value must be a number";
  return null;
}

/**
 * The API body for POST/PATCH (minus companyId — resolve it first with
 * resolveDealCompanyId, since a typed-but-not-yet-existing company needs the
 * find-or-create round trip).
 */
export function crmDealFormPayload(f: CrmDealFormState, companyId: string | null): Record<string, unknown> {
  return {
    name: f.name.trim(),
    companyId,
    eventId: f.eventId,
    dealValue: f.dealValue.trim() ? Number(f.dealValue) : null,
    currency: f.currency,
    expectedClose: f.expectedClose || null,
  };
}

/**
 * The picker gives either an existing account (id) or a to-be-created one
 * (id null + name). Find-or-create the latter so the deal always hangs off a
 * real company row rather than a free-text string; the server dedups, so a
 * typed name that already exists LINKS.
 */
export async function resolveDealCompanyId(
  company: CompanySelection | null,
  createCompany: (body: { name: string }) => Promise<{ company: { id: string } }>,
): Promise<string | null> {
  if (!company) return null;
  return company.id ?? (await createCompany({ name: company.name })).company.id;
}

export function CrmDealFormFields({
  value,
  onChange,
  idPrefix,
  eventHint,
  companyHint,
  extraField,
}: {
  value: CrmDealFormState;
  onChange: (patch: Partial<CrmDealFormState>) => void;
  idPrefix: string;
  /** Caller-specific helper under the event picker. */
  eventHint?: ReactNode;
  /** Caller-specific helper under the company picker. */
  companyHint?: ReactNode;
  /** Create-only extras (the Stage select) — rendered beside Expected close. */
  extraField?: ReactNode;
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
          placeholder="Abbott — BRIDGES 2026 Gold"
        />
      </div>

      <div className="space-y-2">
        <Label>
          Event (project) <span className="text-destructive">*</span>
        </Label>
        <EventCombobox
          value={f.eventId}
          onChange={(eventId) => onChange({ eventId })}
          allowClear={false}
          placeholder="Select an event…"
          className="w-full"
        />
        {eventHint}
      </div>

      <div className="space-y-2">
        <Label>Company</Label>
        <CompanyCombobox value={f.company} onChange={(company) => onChange({ company })} />
        {companyHint}
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-2">
          <Label htmlFor={`${idPrefix}-value`}>Value</Label>
          <Input
            id={`${idPrefix}-value`}
            inputMode="decimal"
            value={f.dealValue}
            onChange={(e) => onChange({ dealValue: e.target.value })}
            placeholder="40000"
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor={`${idPrefix}-currency`}>Currency</Label>
          <Select value={f.currency} onValueChange={(currency) => onChange({ currency })}>
            <SelectTrigger id={`${idPrefix}-currency`} className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {DEAL_CURRENCIES.map((c) => (
                <SelectItem key={c} value={c}>
                  {c}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3">
        {extraField}
        <div className="space-y-2">
          <Label htmlFor={`${idPrefix}-close`}>Expected close</Label>
          <Input
            id={`${idPrefix}-close`}
            type="date"
            value={f.expectedClose}
            onChange={(e) => onChange({ expectedClose: e.target.value })}
          />
        </div>
      </div>
    </div>
  );
}
