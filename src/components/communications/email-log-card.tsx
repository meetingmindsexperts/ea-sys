"use client";

import { useQuery } from "@tanstack/react-query";
import { formatDistanceToNow } from "date-fns";
import { Mail, AlertCircle, Loader2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";

type EmailLogEntityType = "REGISTRATION" | "SPEAKER" | "CONTACT" | "USER" | "OTHER";

interface EmailLogRow {
  id: string;
  to: string;
  cc: string | null;
  subject: string;
  templateSlug: string | null;
  provider: string;
  providerMessageId: string | null;
  status: "SENT" | "FAILED";
  errorMessage: string | null;
  createdAt: string;
  triggeredBy: { firstName: string; lastName: string; email: string } | null;
}

interface EmailLogCardProps {
  entityType: EmailLogEntityType;
  entityId: string;
  /** Optional override for the card heading. */
  title?: string;
}

export function EmailLogCard({ entityType, entityId, title = "Email History" }: EmailLogCardProps) {
  const { data, isLoading, isError } = useQuery<{ logs: EmailLogRow[] }>({
    queryKey: ["email-logs", entityType, entityId],
    queryFn: async () => {
      const params = new URLSearchParams({ entityType, entityId });
      const res = await fetch(`/api/email-logs?${params.toString()}`);
      if (!res.ok) throw new Error(`Failed to load email history (${res.status})`);
      return res.json();
    },
    staleTime: 30_000,
  });

  const logs = data?.logs ?? [];

  return (
    <div className="rounded-lg border border-slate-200 bg-white p-4">
      <div className="flex items-center gap-2 mb-3">
        <Mail className="h-4 w-4 text-slate-500" />
        <h3 className="text-sm font-semibold text-slate-800">{title}</h3>
        {logs.length > 0 && (
          <span className="text-xs text-slate-400">({logs.length})</span>
        )}
      </div>

      {isLoading && (
        <div className="flex items-center gap-2 text-sm text-slate-400">
          <Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading…
        </div>
      )}

      {isError && (
        <div className="flex items-center gap-2 text-sm text-red-500">
          <AlertCircle className="h-3.5 w-3.5" /> Couldn&apos;t load email history.
        </div>
      )}

      {!isLoading && !isError && logs.length === 0 && (
        <p className="text-sm text-slate-400">No emails sent yet.</p>
      )}

      {logs.length > 0 && (
        <ul className="divide-y divide-slate-100">
          {logs.map((log) => (
            <li key={log.id} className="py-2.5 flex items-start gap-3">
              <Badge
                variant={log.status === "SENT" ? "secondary" : "destructive"}
                className="shrink-0 mt-0.5"
              >
                {log.status === "SENT" ? "Sent" : "Failed"}
              </Badge>
              <div className="min-w-0 flex-1">
                <div className="flex items-baseline gap-2">
                  <p className="text-sm font-medium text-slate-800 truncate">
                    {log.subject}
                  </p>
                  <span className="text-xs text-slate-400 shrink-0">
                    {formatDistanceToNow(new Date(log.createdAt), { addSuffix: true })}
                  </span>
                </div>
                <p className="text-xs text-slate-500 truncate">
                  To {log.to}
                  {log.triggeredBy && (
                    <> · by {log.triggeredBy.firstName} {log.triggeredBy.lastName}</>
                  )}
                  {log.templateSlug && <> · {log.templateSlug}</>}
                </p>
                {log.status === "FAILED" && log.errorMessage && (
                  <p className="text-xs text-red-500 mt-1">{log.errorMessage}</p>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
