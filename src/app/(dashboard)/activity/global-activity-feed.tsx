"use client";

import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useSession } from "next-auth/react";
import { format, formatDistanceToNow, isToday, isYesterday } from "date-fns";
import { Activity, RefreshCw, SlidersHorizontal, X, ArrowRight } from "lucide-react";
import {
  auditEntityIcon,
  auditActionColor,
  describeAuditAction,
  auditActorLabel,
  auditSubjectName,
} from "@/components/activity/audit-log-display";
import { computeAuditDiffs } from "@/lib/activity-diff";
import { canViewFinance } from "@/lib/finance-visibility";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ReloadingSpinner } from "@/components/ui/reloading-spinner";
import { useEvents, useOrgUsers } from "@/hooks/use-api";

interface GlobalActivityLog {
  id: string;
  action: string;
  entityType: string;
  entityId: string;
  changes: Record<string, unknown>;
  createdAt: string;
  user: { firstName: string; lastName: string; email: string } | null;
  event: { id: string; name: string } | null;
}

const PAGE_SIZE = 50;
const MAX_LOGS = 500; // matches the API ceiling

// The Select primitive cannot hold an empty-string value (it reserves "" for
// the placeholder), so "no filter" travels as this sentinel and is stripped
// before it reaches the query string.
const ANY = "__any__";

const timeRanges = [
  { label: "All time", value: ANY },
  { label: "Last hour", value: "1h" },
  { label: "Last 24 hours", value: "24h" },
  { label: "Last 7 days", value: "7d" },
  { label: "Last 30 days", value: "30d" },
];

const actionTypes = [
  { label: "All actions", value: ANY },
  { label: "Created", value: "CREATE" },
  { label: "Updated", value: "UPDATE" },
  { label: "Deleted", value: "DELETE" },
  { label: "Email sent", value: "EMAIL_SENT" },
  { label: "Bulk update", value: "BULK_UPDATE" },
];

const entityTypes = [
  { label: "All types", value: ANY },
  { label: "Registration", value: "Registration" },
  { label: "Speaker", value: "Speaker" },
  { label: "Session", value: "Session" },
  { label: "Abstract", value: "Abstract" },
  { label: "Ticket Type", value: "TicketType" },
  { label: "Hotel", value: "Hotel" },
  { label: "User", value: "User" },
  { label: "Track", value: "Track" },
];

/** "Today" / "Yesterday" / "Mon, 12 Jul 2026" — the grouping key AND its label. */
function dayLabel(d: Date): string {
  if (isToday(d)) return "Today";
  if (isYesterday(d)) return "Yesterday";
  return format(d, "EEE, d MMM yyyy");
}

export function GlobalActivityFeed() {
  const { data: session } = useSession();
  // The page is ADMIN/SUPER_ADMIN-only and both are finance roles, so this is
  // effectively always true — but it is derived rather than hardcoded, so the
  // day someone widens the page's RBAC, the money in the diffs does not follow
  // them through by accident.
  const showFinance = canViewFinance(session?.user?.role);

  const [eventId, setEventId] = useState(ANY);
  const [userId, setUserId] = useState(ANY);
  const [action, setAction] = useState(ANY);
  const [entityType, setEntityType] = useState(ANY);
  const [timeRange, setTimeRange] = useState(ANY);
  const [limit, setLimit] = useState(PAGE_SIZE);

  const set = (v: string) => (v === ANY ? "" : v);

  const params = new URLSearchParams();
  params.set("limit", String(limit));
  if (set(eventId)) params.set("eventId", eventId);
  if (set(userId)) params.set("userId", userId);
  if (set(action)) params.set("action", action);
  if (set(entityType)) params.set("entityType", entityType);
  if (set(timeRange)) params.set("timeRange", timeRange);

  const { data: logs = [], isLoading, isFetching, refetch } = useQuery<GlobalActivityLog[]>({
    queryKey: ["global-activity", eventId, userId, action, entityType, timeRange, limit],
    queryFn: async () => {
      const res = await fetch(`/api/activity?${params.toString()}`);
      if (!res.ok) throw new Error("Failed to fetch");
      return res.json();
    },
    refetchInterval: 30_000,
    placeholderData: (prev) => prev, // keep the list on screen while Load more fetches
  });

  const { data: events = [] } = useEvents();
  const { data: orgUsers = [] } = useOrgUsers();

  const activeFilters = [eventId, userId, action, entityType, timeRange].filter(
    (v) => v !== ANY,
  ).length;

  const clearAll = () => {
    setEventId(ANY);
    setUserId(ANY);
    setAction(ANY);
    setEntityType(ANY);
    setTimeRange(ANY);
    setLimit(PAGE_SIZE);
  };

  // Group into days. The API already returns newest-first, so a single pass
  // preserves order without sorting.
  const days = useMemo(() => {
    const out: Array<{ label: string; logs: GlobalActivityLog[] }> = [];
    for (const log of logs) {
      const label = dayLabel(new Date(log.createdAt));
      const last = out[out.length - 1];
      if (last && last.label === label) last.logs.push(log);
      else out.push({ label, logs: [log] });
    }
    return out;
  }, [logs]);

  // A full page means there is probably more behind it.
  const canLoadMore = logs.length >= limit && limit < MAX_LOGS;

  return (
    <div className="space-y-4">
      {/* ── Filters ──────────────────────────────────────────────────────── */}
      <Card>
        <CardContent className="p-3 sm:p-4">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="hidden sm:inline-flex items-center gap-1.5 text-xs font-medium text-muted-foreground pr-1">
              <SlidersHorizontal className="h-3.5 w-3.5" />
              Filter
            </span>

            <Select value={eventId} onValueChange={setEventId}>
              <SelectTrigger className="h-9 w-[190px]" aria-label="Filter by event">
                <SelectValue placeholder="All events" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ANY}>All events</SelectItem>
                {events.map((ev: { id: string; name: string }) => (
                  <SelectItem key={ev.id} value={ev.id}>
                    {ev.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>

            <Select value={userId} onValueChange={setUserId}>
              <SelectTrigger className="h-9 w-[160px]" aria-label="Filter by user">
                <SelectValue placeholder="All users" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ANY}>All users</SelectItem>
                {orgUsers.map(
                  (u: { id: string; firstName: string; lastName: string; email: string }) => (
                    <SelectItem key={u.id} value={u.id}>
                      {`${u.firstName} ${u.lastName}`.trim() || u.email}
                    </SelectItem>
                  ),
                )}
              </SelectContent>
            </Select>

            <Select value={action} onValueChange={setAction}>
              <SelectTrigger className="h-9 w-[145px]" aria-label="Filter by action">
                <SelectValue placeholder="All actions" />
              </SelectTrigger>
              <SelectContent>
                {actionTypes.map((a) => (
                  <SelectItem key={a.value} value={a.value}>
                    {a.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>

            <Select value={entityType} onValueChange={setEntityType}>
              <SelectTrigger className="h-9 w-[150px]" aria-label="Filter by type">
                <SelectValue placeholder="All types" />
              </SelectTrigger>
              <SelectContent>
                {entityTypes.map((e) => (
                  <SelectItem key={e.value} value={e.value}>
                    {e.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>

            <Select value={timeRange} onValueChange={setTimeRange}>
              <SelectTrigger className="h-9 w-[150px]" aria-label="Filter by time range">
                <SelectValue placeholder="All time" />
              </SelectTrigger>
              <SelectContent>
                {timeRanges.map((t) => (
                  <SelectItem key={t.value} value={t.value}>
                    {t.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>

            <div className="flex items-center gap-1.5 ml-auto">
              {activeFilters > 0 && (
                <Button variant="ghost" size="sm" onClick={clearAll} className="h-9 gap-1.5">
                  <X className="h-3.5 w-3.5" />
                  Clear
                  <Badge variant="secondary" className="ml-0.5 h-5 px-1.5 text-[10px]">
                    {activeFilters}
                  </Badge>
                </Button>
              )}
              <Button
                variant="ghost"
                size="icon"
                className="h-9 w-9"
                onClick={() => refetch()}
                disabled={isFetching}
                aria-label="Refresh activity"
              >
                <RefreshCw className={`h-4 w-4 ${isFetching ? "animate-spin" : ""}`} />
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* ── Results ──────────────────────────────────────────────────────── */}
      {isLoading ? (
        <div className="flex justify-center py-16">
          <ReloadingSpinner />
        </div>
      ) : logs.length === 0 ? (
        <Card>
          <CardContent className="py-16">
            <div className="text-center">
              <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-muted">
                <Activity className="h-6 w-6 text-muted-foreground" />
              </div>
              <p className="text-sm font-medium">
                {activeFilters > 0 ? "No activity matches these filters" : "No activity recorded yet"}
              </p>
              <p className="mt-1 text-sm text-muted-foreground">
                {activeFilters > 0
                  ? "Try widening the time range or clearing a filter."
                  : "Actions across your events will appear here as they happen."}
              </p>
              {activeFilters > 0 && (
                <Button variant="outline" size="sm" onClick={clearAll} className="mt-4">
                  Clear filters
                </Button>
              )}
            </div>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-5">
          {days.map((day) => (
            <div key={day.label}>
              {/* Day heading — the single biggest scanning aid: without it the
                  feed is one undifferentiated wall of rows. */}
              <div className="flex items-center gap-3 px-1 pb-2">
                <h3 className="text-xs font-semibold uppercase tracking-widest text-muted-foreground">
                  {day.label}
                </h3>
                <div className="h-px flex-1 bg-border" />
                <span className="text-xs text-muted-foreground">
                  {day.logs.length} {day.logs.length === 1 ? "entry" : "entries"}
                </span>
              </div>

              <Card>
                <CardContent className="p-0">
                  <ul className="divide-y divide-border/60">
                    {day.logs.map((log) => {
                      const Icon = auditEntityIcon(log.entityType);
                      const colorCls = auditActionColor(log.action);
                      const subject = auditSubjectName(log);
                      const diffs = computeAuditDiffs(log.changes, showFinance);
                      const at = new Date(log.createdAt);

                      return (
                        <li
                          key={log.id}
                          className="flex items-start gap-3 px-4 py-3 transition-colors hover:bg-muted/40"
                        >
                          <div
                            className={`mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg ${colorCls}`}
                          >
                            <Icon className="h-4 w-4" />
                          </div>

                          <div className="min-w-0 flex-1">
                            <div className="flex items-baseline justify-between gap-3">
                              <p className="text-sm leading-snug">
                                <span className="font-medium">{describeAuditAction(log)}</span>
                                {/* WHO the row is about — "Speaker updated" alone
                                    is unreadable at 50 rows. */}
                                {subject && (
                                  <span className="text-muted-foreground"> — {subject}</span>
                                )}
                              </p>
                              <time
                                dateTime={at.toISOString()}
                                title={format(at, "d MMM yyyy, HH:mm:ss")}
                                className="shrink-0 whitespace-nowrap text-xs text-muted-foreground"
                              >
                                {formatDistanceToNow(at, { addSuffix: true })}
                              </time>
                            </div>

                            {/* WHAT changed. An UPDATE row without this is just a
                                claim that something happened. */}
                            {diffs.length > 0 && (
                              <div className="mt-1.5 flex flex-wrap gap-1.5">
                                {diffs.slice(0, 4).map((d) => (
                                  <span
                                    key={d.field}
                                    className="inline-flex items-center gap-1 rounded border bg-muted/50 px-1.5 py-0.5 text-[11px] leading-none"
                                    title={`${d.field}: ${d.before} → ${d.after}`}
                                  >
                                    <span className="font-medium text-foreground">{d.field}</span>
                                    <span className="max-w-[90px] truncate text-muted-foreground line-through">
                                      {d.before}
                                    </span>
                                    <ArrowRight className="h-2.5 w-2.5 shrink-0 text-muted-foreground" />
                                    <span className="max-w-[90px] truncate text-foreground">
                                      {d.after}
                                    </span>
                                  </span>
                                ))}
                                {diffs.length > 4 && (
                                  <span className="self-center text-[11px] text-muted-foreground">
                                    +{diffs.length - 4} more
                                  </span>
                                )}
                              </div>
                            )}

                            <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1">
                              {log.event && (
                                <Badge
                                  variant="secondary"
                                  className="h-4 px-1.5 py-0 text-[10px] font-medium"
                                >
                                  {log.event.name}
                                </Badge>
                              )}
                              <span className="text-xs text-muted-foreground">
                                {auditActorLabel(log)}
                              </span>
                            </div>
                          </div>
                        </li>
                      );
                    })}
                  </ul>
                </CardContent>
              </Card>
            </div>
          ))}

          <div className="flex justify-center pt-1">
            {canLoadMore ? (
              <Button
                variant="outline"
                size="sm"
                onClick={() => setLimit((n) => Math.min(n + PAGE_SIZE, MAX_LOGS))}
                disabled={isFetching}
              >
                {isFetching ? "Loading…" : "Load more"}
              </Button>
            ) : (
              <p className="text-xs text-muted-foreground">
                {logs.length >= MAX_LOGS
                  ? `Showing the most recent ${MAX_LOGS} entries — narrow the filters to see further back.`
                  : `End of activity — ${logs.length} ${logs.length === 1 ? "entry" : "entries"}.`}
              </p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
