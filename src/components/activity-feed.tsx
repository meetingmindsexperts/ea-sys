"use client";

import { useQuery } from "@tanstack/react-query";
import { formatDistanceToNow } from "date-fns";
import { Activity } from "lucide-react";
import { ReloadingSpinner } from "@/components/ui/reloading-spinner";
import {
  auditEntityIcon,
  auditActionColor,
  describeAuditAction,
  auditActorLabel,
} from "@/components/activity/audit-log-display";

interface ActivityLog {
  id: string;
  action: string;
  entityType: string;
  entityId: string;
  changes: Record<string, unknown>;
  createdAt: string;
  user: { firstName: string; lastName: string; email: string } | null;
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
        const Icon = auditEntityIcon(log.entityType);
        const colorCls = auditActionColor(log.action);

        return (
          <div key={log.id} className="flex items-start gap-3 py-2.5 px-1 group">
            <div className={`h-8 w-8 rounded-lg flex items-center justify-center shrink-0 ${colorCls}`}>
              <Icon className="h-4 w-4" />
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-sm text-slate-800 leading-snug">
                {describeAuditAction(log)}
              </p>
              <div className="flex items-center gap-2 mt-0.5">
                <span className="text-xs text-muted-foreground">
                  {auditActorLabel(log)}
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
