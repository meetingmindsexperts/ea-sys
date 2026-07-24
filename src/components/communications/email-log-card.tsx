"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { format, formatDistanceToNow, isToday, isYesterday } from "date-fns";
import { Mail, AlertCircle, Loader2, Award, Eye } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { ViewEmailDialog } from "@/components/communications/view-email-dialog";
import { formatTemplateLabel } from "@/lib/email-template-slugs";

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
  hasBody: boolean;
  triggeredBy: { firstName: string; lastName: string; email: string } | null;
}

interface EmailLogCardProps {
  entityType: EmailLogEntityType;
  entityId: string;
  /** Optional override for the card heading. */
  title?: string;
}

/** "Today" / "Yesterday" / "12 Mar 2026" for a day-group heading. */
function dayLabel(date: Date): string {
  if (isToday(date)) return "Today";
  if (isYesterday(date)) return "Yesterday";
  return format(date, "d MMM yyyy");
}

/** Bucket rows (already newest-first) into contiguous day groups. */
function groupByDay(rows: EmailLogRow[]): { key: string; label: string; rows: EmailLogRow[] }[] {
  const groups: { key: string; label: string; rows: EmailLogRow[] }[] = [];
  for (const row of rows) {
    const d = new Date(row.createdAt);
    const key = format(d, "yyyy-MM-dd");
    const last = groups[groups.length - 1];
    if (last && last.key === key) last.rows.push(row);
    else groups.push({ key, label: dayLabel(d), rows: [row] });
  }
  return groups;
}

function senderInitials(u: { firstName: string; lastName: string }): string {
  return `${u.firstName.charAt(0)}${u.lastName.charAt(0)}`.toUpperCase() || "?";
}

export function EmailLogCard({ entityType, entityId, title = "Email History" }: EmailLogCardProps) {
  const [viewEmailId, setViewEmailId] = useState<string | null>(null);

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
  const groups = groupByDay(logs);

  return (
    <div className="rounded-lg border bg-card p-4">
      <div className="mb-3 flex items-center gap-2">
        <Mail className="h-4 w-4 text-muted-foreground" />
        <h3 className="text-sm font-semibold">{title}</h3>
        {logs.length > 0 && <span className="text-xs text-muted-foreground">({logs.length})</span>}
      </div>

      {isLoading && (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading…
        </div>
      )}

      {isError && (
        <div className="flex items-center gap-2 text-sm text-red-500">
          <AlertCircle className="h-3.5 w-3.5" /> Couldn&apos;t load email history.
        </div>
      )}

      {!isLoading && !isError && logs.length === 0 && (
        <p className="text-sm text-muted-foreground">No emails sent yet.</p>
      )}

      {groups.map((group) => (
        <div key={group.key} className="mb-3 last:mb-0">
          <p className="mb-1.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
            {group.label}
          </p>
          <ul className="space-y-1.5">
            {group.rows.map((log) => {
              const isCert = log.templateSlug?.startsWith("certificate");
              return (
                <li
                  key={log.id}
                  className="group flex items-start gap-3 rounded-md border border-transparent p-2 transition-colors hover:border-border hover:bg-muted/40"
                >
                  <Badge
                    variant={log.status === "SENT" ? "secondary" : "destructive"}
                    className="mt-0.5 shrink-0"
                  >
                    {log.status === "SENT" ? "Sent" : "Failed"}
                  </Badge>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-baseline gap-2">
                      <p className="truncate text-sm font-medium">{log.subject}</p>
                      <span className="shrink-0 text-xs text-muted-foreground">
                        {formatDistanceToNow(new Date(log.createdAt), { addSuffix: true })}
                      </span>
                    </div>
                    <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
                      <span className="truncate">To {log.to}</span>
                      {log.templateSlug && (
                        <span
                          className={
                            isCert
                              ? "inline-flex items-center gap-0.5 rounded-full border border-amber-300 bg-amber-50 px-1.5 py-0.5 text-[10px] font-medium text-amber-800"
                              : "inline-flex items-center rounded-full border bg-muted px-1.5 py-0.5 text-[10px] font-medium text-foreground/70"
                          }
                        >
                          {isCert && <Award className="h-2.5 w-2.5" />}
                          {formatTemplateLabel(log.templateSlug)}
                        </span>
                      )}
                      {log.triggeredBy && (
                        <span className="inline-flex items-center gap-1">
                          <span className="inline-flex h-4 w-4 items-center justify-center rounded-full bg-[#00aade]/10 text-[9px] font-semibold text-[#0090b8]">
                            {senderInitials(log.triggeredBy)}
                          </span>
                          by {log.triggeredBy.firstName} {log.triggeredBy.lastName}
                        </span>
                      )}
                    </div>
                    {log.status === "FAILED" && log.errorMessage && (
                      <p className="mt-1 text-xs text-red-500">{log.errorMessage}</p>
                    )}
                  </div>
                  {log.hasBody && (
                    <button
                      type="button"
                      onClick={() => setViewEmailId(log.id)}
                      className="mt-0.5 inline-flex shrink-0 items-center gap-1 rounded-md px-2 py-1 text-xs font-medium text-[#0090b8] opacity-0 transition-opacity hover:bg-[#00aade]/10 focus:opacity-100 group-hover:opacity-100"
                    >
                      <Eye className="h-3.5 w-3.5" /> View
                    </button>
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      ))}

      <ViewEmailDialog emailLogId={viewEmailId} onClose={() => setViewEmailId(null)} />
    </div>
  );
}
