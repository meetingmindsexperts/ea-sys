"use client";

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
} from "lucide-react";
import { ReloadingSpinner } from "@/components/ui/reloading-spinner";

interface ActivityLog {
  id: string;
  action: string;
  entityType: string;
  entityId: string;
  changes: Record<string, unknown>;
  createdAt: string;
  user: { firstName: string; lastName: string; email: string } | null;
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

function getActivityDescription(log: ActivityLog): string {
  const changes = log.changes || {};
  const source = changes.source as string | undefined;

  if (log.entityType === "Registration" && log.action === "CREATE") {
    const attendee = changes.attendee as { firstName?: string; lastName?: string; email?: string } | undefined;
    const ticketType = (changes.ticketType as string) || "";
    const name = attendee ? `${attendee.firstName || ""} ${attendee.lastName || ""}`.trim() : "";
    const confirmId = (changes.confirmationNumber as string) || log.entityId;
    const shortId = confirmId.length > 12 ? `${confirmId.slice(0, 4)}...${confirmId.slice(-4)}` : confirmId;

    if (source === "public_registration") {
      return `${name || "Someone"} registered${ticketType ? ` as ${ticketType}` : ""} (${shortId})`;
    }
    return `Registration created for ${name || "attendee"}${ticketType ? ` — ${ticketType}` : ""} (${shortId})`;
  }

  if (log.action === "EMAIL_SENT") {
    const recipient = changes.recipient as string | undefined;
    return `Email sent to ${recipient || "recipient"}`;
  }

  if (log.action === "DELETE") {
    return `${log.entityType} deleted`;
  }

  if (log.action === "UPDATE") {
    return `${log.entityType} updated`;
  }

  if (log.action === "BULK_UPDATE") {
    return `Bulk update on ${log.entityType}`;
  }

  return `${log.action} ${log.entityType}`;
}

function getActorLabel(log: ActivityLog): string {
  if (log.user) {
    return `${log.user.firstName} ${log.user.lastName}`.trim() || log.user.email;
  }
  const source = (log.changes as Record<string, unknown>)?.source;
  if (source === "public_registration") return "Public Registration";
  return "System";
}

export function ActivityFeed({ eventId }: { eventId: string }) {
  const { data: logs = [], isLoading } = useQuery<ActivityLog[]>({
    queryKey: ["activity", eventId],
    queryFn: async () => {
      const res = await fetch(`/api/events/${eventId}/activity?limit=15`);
      if (!res.ok) throw new Error("Failed to fetch");
      return res.json();
    },
    refetchInterval: 30_000,
  });

  if (isLoading) {
    return (
      <div className="flex justify-center py-8">
        <ReloadingSpinner />
      </div>
    );
  }

  if (logs.length === 0) {
    return (
      <div className="text-center py-8">
        <Activity className="h-8 w-8 text-slate-300 mx-auto mb-2" />
        <p className="text-sm text-muted-foreground">No activity yet</p>
      </div>
    );
  }

  return (
    <div className="space-y-1">
      {logs.map((log) => {
        const Icon = entityIcons[log.entityType] || Activity;
        const colorCls = actionColors[log.action] || "bg-slate-100 text-slate-600";

        return (
          <div key={log.id} className="flex items-start gap-3 py-2.5 px-1 group">
            <div className={`h-8 w-8 rounded-lg flex items-center justify-center shrink-0 ${colorCls}`}>
              <Icon className="h-4 w-4" />
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-sm text-slate-800 leading-snug">
                {getActivityDescription(log)}
              </p>
              <div className="flex items-center gap-2 mt-0.5">
                <span className="text-xs text-muted-foreground">
                  {getActorLabel(log)}
                </span>
                <span className="text-xs text-slate-300">·</span>
                <span className="text-xs text-muted-foreground">
                  {formatDistanceToNow(new Date(log.createdAt), { addSuffix: true })}
                </span>
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}
