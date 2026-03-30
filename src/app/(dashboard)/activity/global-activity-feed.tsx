"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { formatDistanceToNow } from "date-fns";
import {
  UserPlus,
  Activity,
  Tag,
  Mic,
  Calendar,
  Building2,
  Ticket,
  FileText,
  Users,
  RefreshCw,
} from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
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

const entityIcons: Record<string, typeof Activity> = {
  Registration: UserPlus,
  Speaker: Mic,
  Session: Calendar,
  Hotel: Building2,
  TicketType: Ticket,
  Abstract: FileText,
  User: Users,
  Track: Tag,
};

const actionColors: Record<string, string> = {
  CREATE: "bg-green-100 text-green-700",
  UPDATE: "bg-blue-100 text-blue-700",
  DELETE: "bg-red-100 text-red-700",
  EMAIL_SENT: "bg-violet-100 text-violet-700",
  BULK_UPDATE: "bg-amber-100 text-amber-700",
};

const timeRanges = [
  { label: "All time", value: "" },
  { label: "Last hour", value: "1h" },
  { label: "Last 24 hours", value: "24h" },
  { label: "Last 7 days", value: "7d" },
  { label: "Last 30 days", value: "30d" },
];

const actionTypes = [
  { label: "All actions", value: "" },
  { label: "Created", value: "CREATE" },
  { label: "Updated", value: "UPDATE" },
  { label: "Deleted", value: "DELETE" },
  { label: "Email sent", value: "EMAIL_SENT" },
  { label: "Bulk update", value: "BULK_UPDATE" },
];

const entityTypes = [
  { label: "All types", value: "" },
  { label: "Registration", value: "Registration" },
  { label: "Speaker", value: "Speaker" },
  { label: "Session", value: "Session" },
  { label: "Abstract", value: "Abstract" },
  { label: "Ticket Type", value: "TicketType" },
  { label: "Hotel", value: "Hotel" },
  { label: "User", value: "User" },
  { label: "Track", value: "Track" },
];

function getActivityDescription(log: GlobalActivityLog): string {
  const changes = log.changes || {};
  const source = changes.source as string | undefined;

  if (log.entityType === "Registration" && log.action === "CREATE") {
    const attendee = changes.attendee as
      | { firstName?: string; lastName?: string; email?: string }
      | undefined;
    const ticketType = (changes.ticketType as string) || "";
    const name = attendee
      ? `${attendee.firstName || ""} ${attendee.lastName || ""}`.trim()
      : "";
    const confirmId =
      (changes.confirmationNumber as string) || log.entityId;
    const shortId =
      confirmId.length > 12
        ? `${confirmId.slice(0, 4)}...${confirmId.slice(-4)}`
        : confirmId;

    if (source === "public_registration") {
      return `${name || "Someone"} registered${ticketType ? ` as ${ticketType}` : ""} (${shortId})`;
    }
    return `Registration created for ${name || "attendee"}${ticketType ? ` — ${ticketType}` : ""} (${shortId})`;
  }

  if (log.action === "EMAIL_SENT") {
    const recipient = changes.recipient as string | undefined;
    return `Email sent to ${recipient || "recipient"}`;
  }

  if (log.action === "DELETE") return `${log.entityType} deleted`;
  if (log.action === "UPDATE") return `${log.entityType} updated`;
  if (log.action === "BULK_UPDATE")
    return `Bulk update on ${log.entityType}`;

  return `${log.action} ${log.entityType}`;
}

function getActorLabel(log: GlobalActivityLog): string {
  if (log.user) {
    return (
      `${log.user.firstName} ${log.user.lastName}`.trim() || log.user.email
    );
  }
  const source = (log.changes as Record<string, unknown>)?.source;
  if (source === "public_registration") return "Public Registration";
  return "System";
}

export function GlobalActivityFeed() {
  const [eventId, setEventId] = useState("");
  const [userId, setUserId] = useState("");
  const [action, setAction] = useState("");
  const [entityType, setEntityType] = useState("");
  const [timeRange, setTimeRange] = useState("");

  const params = new URLSearchParams();
  params.set("limit", "50");
  if (eventId) params.set("eventId", eventId);
  if (userId) params.set("userId", userId);
  if (action) params.set("action", action);
  if (entityType) params.set("entityType", entityType);
  if (timeRange) params.set("timeRange", timeRange);

  const { data: logs = [], isLoading, isFetching, refetch } = useQuery<GlobalActivityLog[]>({
    queryKey: ["global-activity", eventId, userId, action, entityType, timeRange],
    queryFn: async () => {
      const res = await fetch(`/api/activity?${params.toString()}`);
      if (!res.ok) throw new Error("Failed to fetch");
      return res.json();
    },
    refetchInterval: 30_000,
  });

  const { data: events = [] } = useEvents();
  const { data: orgUsers = [] } = useOrgUsers();

  const hasFilters = eventId || userId || action || entityType || timeRange;

  return (
    <div className="space-y-4">
      {/* Filters */}
      <Card>
        <CardContent className="p-4">
          <div className="flex items-center gap-3 flex-wrap">
            <select
              value={eventId}
              onChange={(e) => setEventId(e.target.value)}
              aria-label="Filter by event"
              className="h-9 rounded-md border border-input bg-background px-3 text-sm"
            >
              <option value="">All events</option>
              {events.map((ev: { id: string; name: string }) => (
                <option key={ev.id} value={ev.id}>{ev.name}</option>
              ))}
            </select>

            <select
              value={userId}
              onChange={(e) => setUserId(e.target.value)}
              aria-label="Filter by user"
              className="h-9 rounded-md border border-input bg-background px-3 text-sm"
            >
              <option value="">All users</option>
              {orgUsers.map((u: { id: string; firstName: string; lastName: string; email: string }) => (
                <option key={u.id} value={u.id}>
                  {`${u.firstName} ${u.lastName}`.trim() || u.email}
                </option>
              ))}
            </select>

            <select
              value={action}
              onChange={(e) => setAction(e.target.value)}
              aria-label="Filter by action"
              className="h-9 rounded-md border border-input bg-background px-3 text-sm"
            >
              {actionTypes.map((a) => (
                <option key={a.value} value={a.value}>{a.label}</option>
              ))}
            </select>

            <select
              value={entityType}
              onChange={(e) => setEntityType(e.target.value)}
              aria-label="Filter by type"
              className="h-9 rounded-md border border-input bg-background px-3 text-sm"
            >
              {entityTypes.map((e) => (
                <option key={e.value} value={e.value}>{e.label}</option>
              ))}
            </select>

            <select
              value={timeRange}
              onChange={(e) => setTimeRange(e.target.value)}
              aria-label="Filter by time range"
              className="h-9 rounded-md border border-input bg-background px-3 text-sm"
            >
              {timeRanges.map((t) => (
                <option key={t.value} value={t.value}>{t.label}</option>
              ))}
            </select>

            <div className="flex items-center gap-2 ml-auto">
              {hasFilters && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => { setEventId(""); setUserId(""); setAction(""); setEntityType(""); setTimeRange(""); }}
                >
                  Clear
                </Button>
              )}
              <Button
                variant="ghost"
                size="icon"
                className="h-9 w-9"
                onClick={() => refetch()}
                disabled={isFetching}
              >
                <RefreshCw className={`h-4 w-4 ${isFetching ? "animate-spin" : ""}`} />
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Results */}
      {isLoading ? (
        <div className="flex justify-center py-12">
          <ReloadingSpinner />
        </div>
      ) : logs.length === 0 ? (
        <Card>
          <CardContent className="py-12">
            <div className="text-center">
              <Activity className="h-10 w-10 text-slate-300 mx-auto mb-3" />
              <p className="text-sm text-muted-foreground">
                {hasFilters ? "No activity matching your filters." : "No activity recorded yet."}
              </p>
            </div>
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardContent className="p-5">
            <div className="flex items-center justify-between mb-3">
              <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-widest">
                {logs.length} {logs.length === 1 ? "entry" : "entries"}
              </h3>
              {isFetching && <RefreshCw className="h-3 w-3 animate-spin text-muted-foreground" />}
            </div>
            <div className="space-y-1">
              {logs.map((log) => {
                const Icon = entityIcons[log.entityType] || Activity;
                const colorCls =
                  actionColors[log.action] || "bg-slate-100 text-slate-600";

                return (
                  <div
                    key={log.id}
                    className="flex items-start gap-3 py-2.5 px-1 group"
                  >
                    <div
                      className={`h-8 w-8 rounded-lg flex items-center justify-center shrink-0 ${colorCls}`}
                    >
                      <Icon className="h-4 w-4" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm text-slate-800 leading-snug">
                        {getActivityDescription(log)}
                      </p>
                      <div className="flex items-center gap-2 mt-0.5 flex-wrap">
                        {log.event && (
                          <Badge
                            variant="secondary"
                            className="text-[10px] px-1.5 py-0 h-4 font-medium"
                          >
                            {log.event.name}
                          </Badge>
                        )}
                        <span className="text-xs text-muted-foreground">
                          {getActorLabel(log)}
                        </span>
                        <span className="text-xs text-slate-300">&middot;</span>
                        <span className="text-xs text-muted-foreground">
                          {formatDistanceToNow(new Date(log.createdAt), {
                            addSuffix: true,
                          })}
                        </span>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
