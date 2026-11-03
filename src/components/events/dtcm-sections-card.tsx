"use client";

/**
 * Event Settings → Registration, under the DET performance code: which DET
 * section and price type each registration type buys (docs/DTCM_ETICKET_PLAN.md
 * step 2). Reads the performance live from DET; the server checks the mapping
 * against DET's map again before saving, so this only offers valid pairs.
 */
import { useState } from "react";
import { AlertTriangle, Loader2, RefreshCw, Save } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useDtcmEventSections, useSaveDtcmEventSections, type DtcmEventSectionsResponse } from "@/hooks/use-api";
import { sectionHeadroom, sectionOptions, type DtcmSectionMapping } from "@/lib/dtcm-eticket/sections";
import type { DetEnvironment, DetPerformanceSummary } from "@/lib/dtcm-eticket/types";

const ENV_LABEL: Record<DetEnvironment, string> = { staging: "Sandbox (UAT)", production: "Production" };
/** Radix Select cannot hold an empty value. */
const UNMAPPED = "__unmapped";

export function DtcmSectionsCard({ eventId, performanceCode }: { eventId: string; performanceCode: string }) {
  const { data, isLoading, isFetching, refetch, error } = useDtcmEventSections(eventId, performanceCode);

  if (isLoading) {
    return (
      <Shell>
        <p className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" /> Reading the performance from DET...
        </p>
      </Shell>
    );
  }
  if (error || !data) {
    return (
      <Shell>
        <p className="text-sm text-red-600">{error instanceof Error ? error.message : "Could not load DET sections."}</p>
      </Shell>
    );
  }
  if (!data.det) return null;
  if (data.det.error) {
    return (
      <Shell>
        <p className="flex items-start gap-2 text-sm text-red-600">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          {data.det.error.message}
        </p>
        <Button type="button" variant="outline" size="sm" className="mt-3" onClick={() => refetch()} disabled={isFetching}>
          <RefreshCw className={isFetching ? "mr-2 h-4 w-4 animate-spin" : "mr-2 h-4 w-4"} /> Try again
        </Button>
      </Shell>
    );
  }

  // Keyed so a save (new checkedAt) restarts the draft from what was stored.
  return (
    <MappingEditor
      key={data.mapping.checkedAt ?? "unsaved"}
      eventId={eventId}
      data={data}
      performance={data.det.performance}
      environment={data.det.environment}
      refreshing={isFetching}
      onRefresh={() => refetch()}
    />
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="space-y-2 rounded-lg border border-slate-200 p-4">
      <p className="text-sm font-medium">DET sections</p>
      {children}
    </div>
  );
}

function MappingEditor({
  eventId,
  data,
  performance,
  environment,
  refreshing,
  onRefresh,
}: {
  eventId: string;
  data: DtcmEventSectionsResponse;
  performance: DetPerformanceSummary;
  environment: DetEnvironment;
  refreshing: boolean;
  onRefresh: () => void;
}) {
  const save = useSaveDtcmEventSections(eventId);
  const [draft, setDraft] = useState<Record<string, DtcmSectionMapping>>(data.mapping.sections);
  const options = sectionOptions(performance);
  const dirty = JSON.stringify(draft) !== JSON.stringify(data.mapping.sections);

  const setArea = (ticketTypeId: string, area: string) => {
    const next = { ...draft };
    if (area === UNMAPPED) {
      delete next[ticketTypeId];
      setDraft(next);
      return;
    }
    // A new section keeps the price type only if that section sells it.
    // Otherwise prefer its zero-priced type: the permit is paid for in seats,
    // so production purchases are 0 and a priced type is rarely what is meant.
    const allowed = options.find((s) => s.code === area)?.priceTypes ?? [];
    const keep = allowed.some((p) => p.code === draft[ticketTypeId]?.priceTypeCode);
    const fallback = allowed.find((p) => p.price === 0) ?? allowed[0];
    next[ticketTypeId] = { area, priceTypeCode: keep ? draft[ticketTypeId].priceTypeCode : (fallback?.code ?? "") };
    setDraft(next);
  };

  const setPriceType = (ticketTypeId: string, priceTypeCode: string) =>
    setDraft({ ...draft, [ticketTypeId]: { ...draft[ticketTypeId], priceTypeCode } });

  const handleSave = async () => {
    const sections = Object.fromEntries(data.ticketTypes.map((t) => [t.id, draft[t.id] ?? null]));
    try {
      await save.mutateAsync(sections);
      toast.success("DET sections saved and checked with DET");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to save DET sections");
    }
  };

  const unmapped = data.ticketTypes.filter((t) => t.isActive && !draft[t.id]);
  const warnings = staleWarnings(data, environment);

  return (
    <div className="space-y-4 rounded-lg border border-slate-200 p-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <p className="text-sm font-medium">DET sections</p>
          <p className="text-xs text-muted-foreground">
            {performance.name} <span className="font-mono">({performance.performanceCode})</span>
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Badge
            variant="outline"
            className={environment === "production" ? "bg-green-50 text-green-700 border-green-200" : "bg-amber-50 text-amber-700 border-amber-200"}
          >
            {ENV_LABEL[environment]}
          </Badge>
          <Button type="button" variant="ghost" size="sm" onClick={onRefresh} disabled={refreshing} aria-label="Read again from DET">
            <RefreshCw className={refreshing ? "h-4 w-4 animate-spin" : "h-4 w-4"} />
          </Button>
        </div>
      </div>

      <p className="text-xs text-muted-foreground">
        Choose the DET section and price type each registration type&apos;s DTCM barcode is issued in. Saving checks the
        choices with DET.
      </p>

      {warnings.map((w) => (
        <p key={w} className="flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 p-2 text-xs text-amber-800">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          {w}
        </p>
      ))}

      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="text-left text-xs text-muted-foreground">
            <tr>
              <th className="py-1.5 pr-3 font-medium">Registration type</th>
              <th className="py-1.5 pr-3 text-right font-medium">In person</th>
              <th className="py-1.5 pr-3 font-medium">Section</th>
              <th className="py-1.5 font-medium">Price type</th>
            </tr>
          </thead>
          <tbody>
            {data.ticketTypes.map((t) => {
              const m = draft[t.id];
              const priceTypes = options.find((s) => s.code === m?.area)?.priceTypes ?? [];
              return (
                <tr key={t.id} className="border-t align-middle">
                  <td className="py-2 pr-3">
                    <span className={t.isActive ? "" : "text-muted-foreground"}>{t.name}</span>
                    {t.isFaculty && <Badge variant="outline" className="ml-2 text-[10px]">Faculty</Badge>}
                    {!t.isActive && <span className="ml-2 text-xs text-muted-foreground">(inactive)</span>}
                  </td>
                  <td className="py-2 pr-3 text-right tabular-nums">{t.registrations}</td>
                  <td className="py-2 pr-3">
                    <Select value={m?.area ?? UNMAPPED} onValueChange={(v) => setArea(t.id, v)}>
                      <SelectTrigger className="h-8 w-48" aria-label={`DET section for ${t.name}`}>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value={UNMAPPED}>Not mapped</SelectItem>
                        {options.map((s) => (
                          <SelectItem key={s.code} value={s.code}>
                            {s.code} · {s.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </td>
                  <td className="py-2">
                    {m && (
                      <Select value={m.priceTypeCode} onValueChange={(v) => setPriceType(t.id, v)}>
                        <SelectTrigger className="h-8 w-48" aria-label={`DET price type for ${t.name}`}>
                          <SelectValue placeholder="Choose" />
                        </SelectTrigger>
                        <SelectContent>
                          {priceTypes.map((p) => (
                            <SelectItem key={p.code} value={p.code}>
                              {p.code} · {p.name ?? "Price type"} ({p.price ?? "?"})
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {unmapped.length > 0 && (
        <p className="text-xs text-amber-700">
          Not mapped: {unmapped.map((t) => t.name).join(", ")}. Their registrations will not get a DTCM barcode from DET.
        </p>
      )}

      <SectionUsage data={data} draft={draft} performance={performance} />

      <div className="flex items-center gap-3">
        <Button type="button" onClick={handleSave} disabled={!dirty || save.isPending}>
          {save.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Save className="mr-2 h-4 w-4" />}
          Save DET sections
        </Button>
        {data.mapping.checkedAt && (
          <span className="text-xs text-muted-foreground">
            Last checked with DET {ENV_LABEL[data.mapping.environment ?? environment]}:{" "}
            {new Date(data.mapping.checkedAt).toLocaleString()}
          </span>
        )}
      </div>
    </div>
  );
}

/** Each section with what EA-SYS has mapped into it, so an over-full section shows before the event. */
function SectionUsage({
  data,
  draft,
  performance,
}: {
  data: DtcmEventSectionsResponse;
  draft: Record<string, DtcmSectionMapping>;
  performance: DetPerformanceSummary;
}) {
  const demand = new Map<string, number>();
  for (const t of data.ticketTypes) {
    const area = draft[t.id]?.area;
    if (area) demand.set(area, (demand.get(area) ?? 0) + t.registrations);
  }
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-xs">
        <thead className="text-left text-muted-foreground">
          <tr>
            <th className="py-1 pr-3 font-medium">Section</th>
            <th className="py-1 pr-3 font-medium">Name</th>
            <th className="py-1 pr-3 text-right font-medium">Capacity</th>
            <th className="py-1 pr-3 text-right font-medium">Holds</th>
            <th className="py-1 text-right font-medium">Mapped registrations</th>
          </tr>
        </thead>
        <tbody>
          {performance.sections.map((s) => {
            const used = demand.get(s.code) ?? 0;
            const headroom = sectionHeadroom(s);
            const over = headroom !== null && used > headroom;
            return (
              <tr key={s.code} className="border-t">
                <td className="py-1 pr-3 font-mono">{s.code}</td>
                <td className="py-1 pr-3">{s.name}</td>
                <td className="py-1 pr-3 text-right tabular-nums">{s.capacity ?? "-"}</td>
                <td className="py-1 pr-3 text-right tabular-nums">{s.holds ?? "-"}</td>
                <td className={over ? "py-1 text-right font-medium tabular-nums text-red-600" : "py-1 text-right tabular-nums"}>
                  {used}
                  {over && " (over capacity)"}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/** Why the saved mapping may no longer describe what DTCM would use. */
function staleWarnings(data: DtcmEventSectionsResponse, environment: DetEnvironment): string[] {
  const out: string[] = [];
  const m = data.mapping;
  if (!m.checkedAt) return out;
  if (m.environment && m.environment !== environment) {
    out.push(
      `This mapping was checked against DET ${ENV_LABEL[m.environment]}, but DTCM now uses ${ENV_LABEL[environment]}. Check each row and save again.`,
    );
  }
  if (m.performanceCode && m.performanceCode !== data.performanceCode) {
    out.push(`This mapping was saved for performance ${m.performanceCode}, not ${data.performanceCode}. Check each row and save again.`);
  }
  return out;
}
