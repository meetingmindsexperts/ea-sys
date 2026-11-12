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
import { TagInput } from "@/components/ui/tag-input";
import { CompanyCombobox, type CompanySelection } from "@/crm/components/company-combobox";
import { EventCombobox } from "@/crm/components/event-combobox";
import { ProjectCombobox } from "@/crm/components/project-combobox";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useCrmDealTypes } from "@/crm/hooks/use-crm-api";
import {
  CRM_DEAL_PIPELINES,
  CRM_DEAL_PIPELINE_LABELS,
  DEAL_CURRENCIES,
  type CrmBoardDeal,
  type CrmDealPipeline,
} from "@/crm/lib/crm-types";

export type DealTargetKind = "event" | "project";

/** Sentinel for the "no category" Select option (Radix forbids an empty value). */
const NO_PIPELINE = "__none__";
/** Sentinel for the "no deal type" Select option. */
const NO_DEAL_TYPE = "__none__";

export interface CrmDealFormState {
  name: string;
  company: CompanySelection | null;
  /** Raw input text — parsed by validateDealForm/dealFormPayload. */
  dealValue: string;
  currency: string;
  /**
   * What the deal is for: an event or a corporate project, never both and
   * never neither (deal-attribution.ts). The side not chosen keeps what was
   * picked, so switching back and forth loses nothing; only the chosen side is sent.
   */
  target: DealTargetKind;
  eventId: string | null;
  projectId: string | null;
  /** The stored project's name, shown when it is no longer in the picker's list (archived). */
  projectName: string | null;
  /** yyyy-mm-dd (date input) or "". */
  expectedClose: string;
  /** "" = unclassified. */
  pipeline: CrmDealPipeline | "";
  /** Org-configurable deal type id, or null. */
  dealTypeId: string | null;
  tags: string[];
}

export function emptyCrmDealForm(defaults?: {
  eventId?: string | null;
  /** Start the deal on this corporate project (the "New deal" button on a project's page). */
  project?: { id: string; name: string } | null;
  company?: CompanySelection | null;
}): CrmDealFormState {
  return {
    name: "",
    company: defaults?.company ?? null,
    dealValue: "",
    currency: "USD",
    target: defaults?.project ? "project" : "event",
    eventId: defaults?.eventId ?? null,
    projectId: defaults?.project?.id ?? null,
    projectName: defaults?.project?.name ?? null,
    expectedClose: "",
    // A deal for a corporate project starts in the Corporate category.
    pipeline: defaults?.project ? "CORPORATE" : "",
    dealTypeId: null,
    tags: [],
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
    target: deal.project ? "project" : "event",
    eventId: deal.event?.id ?? null,
    projectId: deal.project?.id ?? null,
    projectName: deal.project?.name ?? null,
    expectedClose: toDateInput(deal.expectedClose),
    pipeline: deal.pipeline ?? "",
    dealTypeId: deal.dealTypeId ?? deal.dealType?.id ?? null,
    tags: deal.tags ?? [],
  };
}

/** First failing rule as a toast-ready message, or null when the form is sound. */
export function validateDealForm(f: CrmDealFormState): string | null {
  if (!f.name.trim()) return "Give the deal a name";
  if (f.target === "event" && !f.eventId) return "Select the event this deal is for";
  if (f.target === "project" && !f.projectId) return "Select the corporate project this deal is for";
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
    // Exactly one side is sent as an id, the other as null: on an edit that
    // moves the deal across, the service clears the side it left.
    eventId: f.target === "event" ? f.eventId : null,
    projectId: f.target === "project" ? f.projectId : null,
    dealValue: f.dealValue.trim() ? Number(f.dealValue) : null,
    currency: f.currency,
    expectedClose: f.expectedClose || null,
    pipeline: f.pipeline || null,
    dealTypeId: f.dealTypeId,
    tags: f.tags,
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
  columns = 1,
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
  /**
   * 1 = the stacked layout (the narrow create dialog); 2 = a responsive
   * two-column grid for the wide inline edit form, so the right half of the
   * card isn't wasted. Not viewport-`sm:`-driven by default because the create
   * dialog is narrow on a wide screen — the caller opts in.
   */
  columns?: 1 | 2;
}) {
  const f = value;
  // The org's deal types (admin-editable list, seeded on first load).
  const { data: dealTypes = [] } = useCrmDealTypes();
  const two = columns === 2;

  // Each field is built once, then arranged by the layout below — so the field
  // set can't drift between the one-column and two-column renders.
  const nameField = (
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
  );

  // Choosing "a corporate project" on an uncategorised deal also files it under Corporate.
  function chooseTarget(target: DealTargetKind) {
    onChange({ target, ...(target === "project" && !f.pipeline ? { pipeline: "CORPORATE" as const } : {}) });
  }

  const eventField = (
    <div className="space-y-2">
      <Label>
        This deal is for <span className="text-destructive">*</span>
      </Label>
      <Tabs value={f.target} onValueChange={(v) => chooseTarget(v as DealTargetKind)}>
        <TabsList className="w-full">
          <TabsTrigger value="event" className="flex-1">
            An event
          </TabsTrigger>
          <TabsTrigger value="project" className="flex-1">
            A corporate project
          </TabsTrigger>
        </TabsList>
      </Tabs>
      {f.target === "event" ? (
        <EventCombobox
          value={f.eventId}
          onChange={(eventId) => onChange({ eventId })}
          allowClear={false}
          placeholder="Select an event…"
          className="w-full"
        />
      ) : (
        <ProjectCombobox
          value={f.projectId}
          onChange={(projectId) => onChange({ projectId, projectName: null })}
          allowClear={false}
          allowCreate
          fallbackName={f.projectName}
          placeholder="Select or create a corporate project…"
          className="w-full"
        />
      )}
      {f.target === "event" ? (
        eventHint
      ) : (
        <p className="text-xs text-muted-foreground">
          For work that is not an event in the system: a client&rsquo;s own meeting, an advisory board.
        </p>
      )}
    </div>
  );

  const companyField = (
    <div className="space-y-2">
      <Label>Account</Label>
      <CompanyCombobox value={f.company} onChange={(company) => onChange({ company })} />
      {companyHint}
    </div>
  );

  const pipelineField = (
    <div className="space-y-2">
      <Label htmlFor={`${idPrefix}-pipeline`}>Pipeline</Label>
      <Select
        value={f.pipeline || NO_PIPELINE}
        onValueChange={(v) => onChange({ pipeline: v === NO_PIPELINE ? "" : (v as CrmDealPipeline) })}
      >
        <SelectTrigger id={`${idPrefix}-pipeline`} className="w-full">
          <SelectValue placeholder="Uncategorised" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={NO_PIPELINE}>Uncategorised</SelectItem>
          {CRM_DEAL_PIPELINES.map((p) => (
            <SelectItem key={p} value={p}>
              {CRM_DEAL_PIPELINE_LABELS[p]}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );

  const dealTypeField = (
    <div className="space-y-2">
      <Label htmlFor={`${idPrefix}-dealtype`}>Deal type</Label>
      <Select
        value={f.dealTypeId ?? NO_DEAL_TYPE}
        onValueChange={(v) => onChange({ dealTypeId: v === NO_DEAL_TYPE ? null : v })}
      >
        <SelectTrigger id={`${idPrefix}-dealtype`} className="w-full">
          <SelectValue placeholder="No deal type" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={NO_DEAL_TYPE}>No deal type</SelectItem>
          {dealTypes.map((t) => (
            <SelectItem key={t.id} value={t.id}>
              {t.name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );

  const valueField = (
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
  );

  const currencyField = (
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
  );

  const closeField = (
    <div className="space-y-2">
      <Label htmlFor={`${idPrefix}-close`}>Expected close</Label>
      <Input
        id={`${idPrefix}-close`}
        type="date"
        value={f.expectedClose}
        onChange={(e) => onChange({ expectedClose: e.target.value })}
      />
    </div>
  );

  const tagsField = (
    <div className="space-y-2">
      <Label>Tags</Label>
      <TagInput value={f.tags} onChange={(tags) => onChange({ tags })} placeholder="Add tag…" />
    </div>
  );

  if (two) {
    // Wide inline edit: two columns that collapse to one on a narrow viewport.
    // Name + Tags span the full width; the compact fields pair up. `extraField`
    // (Stage) is create-only, so in edit it's absent and the grid auto-flows.
    return (
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div className="sm:col-span-2">{nameField}</div>
        {eventField}
        {companyField}
        {pipelineField}
        {dealTypeField}
        {valueField}
        {currencyField}
        {extraField}
        {closeField}
        <div className="sm:col-span-2">{tagsField}</div>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {nameField}
      {eventField}
      {companyField}
      {pipelineField}
      {dealTypeField}
      <div className="grid grid-cols-2 gap-3">
        {valueField}
        {currencyField}
      </div>
      <div className="grid grid-cols-2 gap-3">
        {extraField}
        {closeField}
      </div>
      {tagsField}
    </div>
  );
}
