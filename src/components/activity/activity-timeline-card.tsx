"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { formatDistanceToNow } from "date-fns";
import {
  Activity,
  Mail,
  Award,
  AlertCircle,
  Banknote,
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
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type { ActivitySource, ActivityItem, ActivityFeed } from "@/lib/activity-feed-types";

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
  // Speaker reimbursement (actions remapped in activity-feed.ts)
  REIMBURSEMENT_SUBMITTED: "Reimbursement form submitted",
  REIMBURSEMENT_REOPENED: "Reimbursement form reopened for edits",
  REIMBURSEMENT_DOCUMENT_ADDED: "Reimbursement document added (after submission)",
  REIMBURSEMENT_INVITED: "Reimbursement form invite created",
  REIMBURSEMENT_LINK_SENT: "Reimbursement link emailed",
  REIMBURSEMENT_DELETED: "Reimbursement form deleted",
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
      if (item.action?.startsWith("REIMBURSEMENT_")) return Banknote;
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
  const { data, isLoading, isError } = useQuery<ActivityFeed>({
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

  // "View email" — the stored audit copy of a sent email's final HTML
  // (certificate deliveries opt in via EmailLogContext.storeBody). Item ids
  // are `email:{emailLogId}`; the body is fetched on open, never in the feed.
  const [viewEmailId, setViewEmailId] = useState<string | null>(null);
  const emailBodyQuery = useQuery<{ subject: string; to: string; htmlBody: string }>({
    queryKey: ["email-log-body", viewEmailId],
    queryFn: async () => {
      const res = await fetch(`/api/email-logs/${viewEmailId}/body`);
      if (!res.ok) {
        const data = (await res.json().catch(() => null)) as { error?: string } | null;
        throw new Error(data?.error ?? `Failed to load the email (${res.status})`);
      }
      return res.json();
    },
    enabled: !!viewEmailId,
    staleTime: 5 * 60_000,
  });

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
                    {item.kind === "email" && item.hasBody && (
                      <button
                        type="button"
                        onClick={() => setViewEmailId(item.id.replace(/^email:/, ""))}
                        className="shrink-0 inline-flex items-center gap-0.5 text-xs font-medium text-cyan-700 hover:underline"
                        title="Open the stored copy of exactly what was sent"
                      >
                        <Mail className="h-3 w-3" /> View email
                      </button>
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
                  {item.kind === "audit" && item.diffs && item.diffs.length > 0 && (
                    <ul className="mt-1.5 space-y-0.5">
                      {item.diffs.map((d, di) => (
                        <li key={di} className="text-xs text-slate-600">
                          <span className="font-medium text-slate-700">{d.field}:</span>{" "}
                          <span className="text-slate-400 line-through">{d.before}</span>
                          <span className="mx-1 text-slate-400">→</span>
                          <span className="text-slate-700">{d.after}</span>
                        </li>
                      ))}
                    </ul>
                  )}
                  {item.kind === "email" && item.status !== "SENT" && item.errorMessage && (
                    <p className="text-xs text-red-500 mt-1">{item.errorMessage}</p>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}

      {/* Sent-email viewer — the stored audit copy, rendered sandboxed. */}
      <Dialog open={!!viewEmailId} onOpenChange={(open) => !open && setViewEmailId(null)}>
        <DialogContent className="sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Mail className="h-4 w-4" />
              Sent email
            </DialogTitle>
            <DialogDescription>
              {emailBodyQuery.data
                ? `To ${emailBodyQuery.data.to} — “${emailBodyQuery.data.subject}”`
                : "The stored copy of exactly what was sent."}
            </DialogDescription>
          </DialogHeader>
          {emailBodyQuery.isLoading && (
            <div className="flex items-center gap-2 p-4 text-sm text-slate-500">
              <Loader2 className="h-4 w-4 animate-spin" /> Loading the stored email…
            </div>
          )}
          {emailBodyQuery.isError && (
            <p className="rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-700">
              {emailBodyQuery.error instanceof Error
                ? emailBodyQuery.error.message
                : "Failed to load the email"}
            </p>
          )}
          {emailBodyQuery.data && (
            <iframe
              title="Sent email"
              sandbox=""
              srcDoc={emailBodyQuery.data.htmlBody}
              className="h-[28rem] w-full rounded-md border border-slate-200 bg-white"
            />
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
