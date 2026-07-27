"use client";

/**
 * CRM Activity — the ORG-WIDE change log, "who did what, when", filterable by user
 * and timeframe.
 *
 * The per-record History (on each deal/company/contact) answers "what happened to
 * THIS record"; this answers "what has the team been doing" — the audit/oversight
 * view a manager or auditor needs. Same store (CrmActivity), read through the
 * cursor-paged org-wide feed.
 *
 * Filters live in the URL (useCrmFilters), like every other CRM list, so a filtered
 * audit view is shareable/bookmarkable and the CSV export honours exactly what's on
 * screen. Money + prose are redacted server-side for MEMBER.
 */
import { Suspense } from "react";
import {
  Activity as ActivityIcon,
  Archive,
  ArchiveRestore,
  ArrowRight,
  Download,
  Loader2,
  Mail,
  Pencil,
  Plus,
  Trophy,
  X,
  XCircle,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { OwnerFilter } from "@/crm/components/filters/owner-filter";
import { DateRangeFilter } from "@/crm/components/filters/date-range-filter";
import { CrmEmptyState } from "@/crm/components/crm-empty-state";
import { CrmListSkeleton } from "@/crm/components/crm-skeletons";
import { CrmLoadError } from "@/crm/components/crm-load-error";
import { useCrmActivityFeed } from "@/crm/hooks/use-crm-api";
import { useCrmFilters } from "@/crm/lib/use-crm-filters";
import { cn } from "@/lib/utils";
import {
  activityActionLabel,
  formatActivityChangeSummary,
  personName,
  CRM_ACTIVITY_ACTION_LABELS,
  CRM_ACTIVITY_ENTITY_LABELS,
  type CrmActivityEntityType,
  type CrmActivityFeedRow,
} from "@/crm/lib/crm-types";

const FILTER_KEYS = ["actor", "type", "action", "from", "to"];

// Compact icon per action — a lighter version of the per-record timeline's map.
const ACTION_ICON: Record<string, { icon: LucideIcon; className: string }> = {
  CREATE: { icon: Plus, className: "text-emerald-600" },
  UPDATE: { icon: Pencil, className: "text-sky-600" },
  ARCHIVE: { icon: Archive, className: "text-rose-600" },
  RESTORE: { icon: ArchiveRestore, className: "text-emerald-600" },
  STAGE_MOVE: { icon: ArrowRight, className: "text-violet-600" },
  WON: { icon: Trophy, className: "text-emerald-600" },
  LOST: { icon: XCircle, className: "text-rose-600" },
  EMAIL_SENT: { icon: Mail, className: "text-sky-600" },
  EMAIL_RECEIVED: { icon: Mail, className: "text-emerald-600" },
  PROSPECTUS_SENT: { icon: Mail, className: "text-sky-600" },
};

/** Deep link to the entity a row is about — null for TASK (no per-task page). */
function entityHref(type: CrmActivityEntityType, id: string): string | null {
  if (type === "DEAL") return `/crm/deals/${id}`;
  if (type === "COMPANY") return `/crm/companies/${id}`;
  if (type === "CONTACT") return `/crm/contacts/${id}`;
  return null;
}

function ActivityInner() {
  const { get, set, clear, anyActive } = useCrmFilters();

  const filters = {
    actorId: get("actor") || undefined,
    entityType: get("type") || undefined,
    action: get("action") || undefined,
    from: get("from") || undefined,
    to: get("to") || undefined,
  };
  const filtersActive = anyActive(FILTER_KEYS);

  const { data, isLoading, isError, refetch, fetchNextPage, hasNextPage, isFetchingNextPage } =
    useCrmActivityFeed(filters);

  const rows = data?.pages.flatMap((p) => p.activity) ?? [];

  // Export honours the current URL filters (same param names the feed reads).
  const exportHref = (() => {
    const qs = new URLSearchParams();
    if (filters.actorId) qs.set("actorId", filters.actorId);
    if (filters.entityType) qs.set("entityType", filters.entityType);
    if (filters.action) qs.set("action", filters.action);
    if (filters.from) qs.set("from", filters.from);
    if (filters.to) qs.set("to", filters.to);
    const s = qs.toString();
    return `/api/crm/activity/export${s ? `?${s}` : ""}`;
  })();

  return (
    <div className="space-y-6 p-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-muted-foreground">
          Every change across the CRM — who did what, and when.
        </p>
        <Button asChild variant="outline">
          {/* Plain link so the browser downloads it; honours the current filters. */}
          <a href={exportHref} download>
            <Download className="mr-2 h-4 w-4" />
            Export CSV
          </a>
        </Button>
      </div>

      {/* ── Filter bar ─────────────────────────────────────────────────────── */}
      <div className="flex flex-wrap items-center gap-2 rounded-lg border bg-muted/20 p-2">
        <OwnerFilter value={get("actor")} onChange={(v) => set({ actor: v })} placeholder="Any user" />

        <Select value={get("type") || "__all__"} onValueChange={(v) => set({ type: v === "__all__" ? null : v })}>
          <SelectTrigger className="w-[10rem]">
            <SelectValue placeholder="Any record" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="__all__">Any record</SelectItem>
            {(Object.keys(CRM_ACTIVITY_ENTITY_LABELS) as CrmActivityEntityType[]).map((t) => (
              <SelectItem key={t} value={t}>
                {CRM_ACTIVITY_ENTITY_LABELS[t]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <Select value={get("action") || "__all__"} onValueChange={(v) => set({ action: v === "__all__" ? null : v })}>
          <SelectTrigger className="w-[13rem]">
            <SelectValue placeholder="Any action" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="__all__">Any action</SelectItem>
            {Object.entries(CRM_ACTIVITY_ACTION_LABELS).map(([value, label]) => (
              <SelectItem key={value} value={value}>
                {label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <DateRangeFilter
          label="Date"
          from={get("from")}
          to={get("to")}
          onApply={({ from, to }) => set({ from, to })}
        />

        {filtersActive && (
          <Button variant="ghost" size="sm" onClick={() => clear(FILTER_KEYS)}>
            <X className="mr-1 h-3.5 w-3.5" />
            Clear
          </Button>
        )}
      </div>

      {isLoading ? (
        <CrmListSkeleton rows={8} />
      ) : isError ? (
        <CrmLoadError what="the activity log" onRetry={() => refetch()} />
      ) : rows.length === 0 ? (
        <CrmEmptyState
          icon={ActivityIcon}
          title={filtersActive ? "No activity matches these filters" : "No activity yet"}
          description={
            filtersActive
              ? "Try widening the date range or clearing a filter."
              : "Deal moves, edits, emails and closes across the whole CRM show up here."
          }
        />
      ) : (
        <div className="overflow-hidden rounded-xl border bg-card">
          <ul className="divide-y">
            {rows.map((row) => (
              <ActivityRow key={row.id} row={row} />
            ))}
          </ul>
          {hasNextPage && (
            <div className="border-t p-2">
              <Button
                variant="ghost"
                size="sm"
                className="w-full"
                disabled={isFetchingNextPage}
                onClick={() => fetchNextPage()}
              >
                {isFetchingNextPage ? (
                  <>
                    <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />
                    Loading…
                  </>
                ) : (
                  "Load older"
                )}
              </Button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function ActivityRow({ row }: { row: CrmActivityFeedRow }) {
  const meta = ACTION_ICON[row.action] ?? { icon: Pencil, className: "text-muted-foreground" };
  const Icon = meta.icon;
  const summary = formatActivityChangeSummary({ action: row.action, changes: row.changes });
  const href = row.entityName ? entityHref(row.entityType, row.entityId) : null;

  return (
    <li className="flex items-start gap-3 px-3 py-2.5">
      <Icon className={cn("mt-0.5 h-4 w-4 shrink-0", meta.className)} />
      <div className="min-w-0 flex-1">
        <p className="text-sm">
          <span className="font-medium">{row.actor ? personName(row.actor) : "System"}</span>
          <span className="text-muted-foreground"> {activityActionLabel(row.action).toLowerCase()} </span>
          <Badge variant="outline" className="mr-1 text-[10px]">
            {CRM_ACTIVITY_ENTITY_LABELS[row.entityType] ?? row.entityType}
          </Badge>
          {href ? (
            <a href={href} className="font-medium text-primary hover:underline">
              {row.entityName}
            </a>
          ) : (
            <span className="font-medium">{row.entityName ?? "(removed)"}</span>
          )}
        </p>
        {summary && <p className="mt-0.5 truncate text-xs text-muted-foreground">{summary}</p>}
      </div>
      <span className="shrink-0 whitespace-nowrap text-[11px] tabular-nums text-muted-foreground">
        {new Date(row.createdAt).toLocaleString()}
      </span>
    </li>
  );
}

export default function CrmActivityPage() {
  // useCrmFilters reads useSearchParams — needs a Suspense boundary.
  return (
    <Suspense fallback={<div className="p-6 text-sm text-muted-foreground">Loading…</div>}>
      <ActivityInner />
    </Suspense>
  );
}
