"use client";

import { useQuery } from "@tanstack/react-query";
import { formatDistanceToNow } from "date-fns";
import {
  Activity,
  Mail,
  Award,
  AlertCircle,
  Loader2,
  Plus,
  Pencil,
  Trash2,
  FileSignature,
  Users,
  LogIn,
  Link2,
  ExternalLink,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";

type ActivitySource = "speaker" | "registration";

interface ActivityItem {
  id: string;
  source: ActivitySource;
  kind: "audit" | "email" | "certificate";
  at: string;
  action?: string;
  actor?: string | null;
  ipAddress?: string | null;
  subject?: string;
  to?: string;
  status?: string;
  templateSlug?: string | null;
  errorMessage?: string | null;
  serial?: string;
  certType?: string;
  pdfUrl?: string | null;
  revoked?: boolean;
}

interface ActivityResponse {
  items: ActivityItem[];
  linked: { type: ActivitySource; id: string; linkedBy: "pointer" | "email" } | null;
}

interface Props {
  /** Full activity API URL for this entity. */
  endpoint: string;
  /** Which entity this card is anchored on — drives the "From X" cross-badge. */
  anchor: ActivitySource;
  /** React Query key suffix so speaker + registration caches don't collide. */
  queryKey: (string | undefined)[];
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

const CERT_LABELS: Record<string, string> = {
  ATTENDANCE: "Certificate of Attendance",
  APPRECIATION: "Certificate of Appreciation",
};

function auditLabel(action: string | undefined): string {
  if (!action) return "Activity";
  return AUDIT_LABELS[action] ?? action.replace(/_/g, " ").toLowerCase();
}

function iconFor(item: ActivityItem) {
  if (item.kind === "certificate") return Award;
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

function primaryText(item: ActivityItem): string {
  if (item.kind === "email") return item.subject || "Email";
  if (item.kind === "certificate") {
    const label = CERT_LABELS[item.certType ?? ""] ?? "Certificate";
    return item.revoked ? `${label} revoked` : `${label} issued`;
  }
  return auditLabel(item.action);
}

export function ActivityTimelineCard({ endpoint, anchor, queryKey, title = "Activity" }: Props) {
  const { data, isLoading, isError } = useQuery<ActivityResponse>({
    queryKey: ["activity", ...queryKey],
    queryFn: async () => {
      const res = await fetch(endpoint);
      if (!res.ok) throw new Error(`Failed to load activity (${res.status})`);
      return res.json();
    },
    staleTime: 30_000,
  });

  const items = data?.items ?? [];
  const linked = data?.linked ?? null;

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
          Includes activity from a linked {linked.type}
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
            const crossSource = item.source !== anchor;
            const canOpen = item.kind === "certificate" && !!item.pdfUrl && !item.revoked;
            return (
              <li key={item.id} className="py-2.5 flex items-start gap-3">
                <Icon
                  className={
                    item.kind === "certificate" && !item.revoked
                      ? "h-4 w-4 mt-0.5 shrink-0 text-amber-500"
                      : "h-4 w-4 mt-0.5 shrink-0 text-slate-400"
                  }
                />
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                    <p className="text-sm font-medium text-slate-800 truncate">{primaryText(item)}</p>
                    {item.kind === "email" && (
                      <Badge
                        variant={item.status === "SENT" ? "secondary" : "destructive"}
                        className="shrink-0"
                      >
                        {item.status === "SENT" ? "Sent" : "Failed"}
                      </Badge>
                    )}
                    {item.kind === "certificate" && item.revoked && (
                      <Badge variant="destructive" className="shrink-0">
                        Revoked
                      </Badge>
                    )}
                    {crossSource && (
                      <span className="shrink-0 inline-flex items-center gap-0.5 rounded-full border border-amber-300 bg-amber-50 px-1.5 py-0.5 text-[10px] font-medium text-amber-800">
                        From {item.source}
                      </span>
                    )}
                    {canOpen && (
                      <a
                        href={item.pdfUrl!}
                        target="_blank"
                        rel="noreferrer"
                        className="shrink-0 inline-flex items-center gap-0.5 text-xs font-medium text-cyan-700 hover:underline"
                      >
                        <ExternalLink className="h-3 w-3" /> Open
                      </a>
                    )}
                    <span className="text-xs text-slate-400 shrink-0">
                      {formatDistanceToNow(new Date(item.at), { addSuffix: true })}
                    </span>
                  </div>
                  <p className="text-xs text-slate-500 truncate">
                    {item.kind === "email" ? (
                      <>To {item.to}</>
                    ) : item.kind === "certificate" ? (
                      <>
                        {item.serial}
                        {item.pdfUrl ? "" : " · PDF not yet rendered"}
                      </>
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
