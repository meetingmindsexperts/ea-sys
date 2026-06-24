"use client";

import { useQuery } from "@tanstack/react-query";
import { formatDistanceToNow } from "date-fns";
import {
  Activity,
  Mail,
  AlertCircle,
  Loader2,
  Plus,
  Pencil,
  Trash2,
  FileSignature,
  Users,
  LogIn,
  Link2,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";

type ActivitySource = "speaker" | "registration";

interface ActivityItem {
  id: string;
  source: ActivitySource;
  kind: "audit" | "email";
  at: string;
  action?: string;
  actor?: string | null;
  ipAddress?: string | null;
  subject?: string;
  to?: string;
  status?: string;
  templateSlug?: string | null;
  errorMessage?: string | null;
}

interface ActivityResponse {
  items: ActivityItem[];
  linkedRegistration: { id: string; linkedBy: "pointer" | "email" } | null;
}

interface Props {
  eventId: string;
  speakerId: string;
  title?: string;
}

const AUDIT_LABELS: Record<string, string> = {
  CREATE: "Created",
  UPDATE: "Updated",
  DELETE: "Deleted",
  EMAIL_SENT: "Email sent",
  SPEAKER_AGREEMENT_ACCEPTED: "Agreement accepted",
  SPEAKER_AGREEMENT_REVOKED: "Agreement revoked",
  PANELIST_SYNC: "Synced as Zoom panelist",
  CHECK_IN: "Checked in",
};

function auditLabel(action: string | undefined): string {
  if (!action) return "Activity";
  return AUDIT_LABELS[action] ?? action.replace(/_/g, " ").toLowerCase();
}

function iconFor(item: ActivityItem) {
  if (item.kind === "email") return Mail;
  switch (item.action) {
    case "CREATE":
      return Plus;
    case "UPDATE":
      return Pencil;
    case "DELETE":
      return Trash2;
    case "SPEAKER_AGREEMENT_ACCEPTED":
    case "SPEAKER_AGREEMENT_REVOKED":
      return FileSignature;
    case "PANELIST_SYNC":
      return Users;
    case "CHECK_IN":
      return LogIn;
    case "EMAIL_SENT":
      return Mail;
    default:
      return Activity;
  }
}

export function SpeakerActivityCard({ eventId, speakerId, title = "Activity" }: Props) {
  const { data, isLoading, isError } = useQuery<ActivityResponse>({
    queryKey: ["speaker-activity", eventId, speakerId],
    queryFn: async () => {
      const res = await fetch(`/api/events/${eventId}/speakers/${speakerId}/activity`);
      if (!res.ok) throw new Error(`Failed to load activity (${res.status})`);
      return res.json();
    },
    staleTime: 30_000,
  });

  const items = data?.items ?? [];
  const linked = data?.linkedRegistration ?? null;

  return (
    <div className="rounded-lg border border-slate-200 bg-white p-4">
      <div className="flex items-center gap-2 mb-1">
        <Activity className="h-4 w-4 text-slate-500" />
        <h3 className="text-sm font-semibold text-slate-800">{title}</h3>
        {items.length > 0 && <span className="text-xs text-slate-400">({items.length})</span>}
      </div>

      {linked && (
        <p className="mb-3 flex items-center gap-1 text-xs text-amber-700">
          <Link2 className="h-3 w-3 shrink-0" />
          Includes activity from a linked registration
          {linked.linkedBy === "email" ? " (matched by email)" : ""}.
        </p>
      )}

      {isLoading && (
        <div className="flex items-center gap-2 text-sm text-slate-400">
          <Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading…
        </div>
      )}

      {isError && (
        <div className="flex items-center gap-2 text-sm text-red-500">
          <AlertCircle className="h-3.5 w-3.5" /> Couldn&apos;t load activity.
        </div>
      )}

      {!isLoading && !isError && items.length === 0 && (
        <p className="text-sm text-slate-400">No activity yet.</p>
      )}

      {items.length > 0 && (
        <ul className="divide-y divide-slate-100">
          {items.map((item) => {
            const Icon = iconFor(item);
            const fromReg = item.source === "registration";
            return (
              <li key={item.id} className="py-2.5 flex items-start gap-3">
                <Icon className="h-4 w-4 mt-0.5 shrink-0 text-slate-400" />
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                    <p className="text-sm font-medium text-slate-800 truncate">
                      {item.kind === "email" ? item.subject || "Email" : auditLabel(item.action)}
                    </p>
                    {item.kind === "email" && (
                      <Badge
                        variant={item.status === "SENT" ? "secondary" : "destructive"}
                        className="shrink-0"
                      >
                        {item.status === "SENT" ? "Sent" : "Failed"}
                      </Badge>
                    )}
                    {fromReg && (
                      <span className="shrink-0 inline-flex items-center gap-0.5 rounded-full border border-amber-300 bg-amber-50 px-1.5 py-0.5 text-[10px] font-medium text-amber-800">
                        From registration
                      </span>
                    )}
                    <span className="text-xs text-slate-400 shrink-0">
                      {formatDistanceToNow(new Date(item.at), { addSuffix: true })}
                    </span>
                  </div>
                  <p className="text-xs text-slate-500 truncate">
                    {item.kind === "email" ? (
                      <>To {item.to}</>
                    ) : (
                      <>
                        {item.actor ? `by ${item.actor}` : "automated / self-service"}
                        {item.ipAddress ? ` · ${item.ipAddress}` : ""}
                      </>
                    )}
                  </p>
                  {item.kind === "email" && item.status !== "SENT" && item.errorMessage && (
                    <p className="text-xs text-red-500 mt-1">{item.errorMessage}</p>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
