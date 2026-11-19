"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { format, formatDistanceToNow } from "date-fns";
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
  Paperclip,
  RotateCcw,
  Printer,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { ViewEmailDialog } from "@/components/communications/view-email-dialog";
import { EmailCopies } from "@/components/communications/email-copies";
import { EmailOutcomeBadge } from "@/components/communications/email-outcome-badge";
import { bouncingAddresses, emailOutcome, type EmailOutcomeInput } from "@/lib/email-outcome";
import type { ActivitySource, ActivityItem, ActivityFeed } from "@/lib/activity-feed-types";

interface Props {
  /** Full activity API URL for this entity. */
  endpoint: string;
  /** Which entity this card is anchored on — drives the "From X" cross-badge. */
  anchor: ActivitySource;
  /** React Query key suffix so speaker + registration caches don't collide. */
  queryKey: (string | undefined)[];
  title?: string;
  /**
   * The person's address(es) as they are now. The bounce warning is shown for
   * these only. Required, so a new mount cannot lose the warning by leaving it out.
   */
  currentEmails: (string | null | undefined)[];
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
  // A badge print run that included this registration (activity-feed.ts): the first, then any later ones.
  BADGE_PRINTED: "Badge printed",
  BADGE_REPRINTED: "Badge reprinted",
  // An organizer cleared a submitted survey (registrations/[id]/survey).
  SURVEY_RESET: "Survey reset",
  // Speaker reimbursement (actions remapped in activity-feed.ts)
  REIMBURSEMENT_SUBMITTED: "Reimbursement form submitted",
  REIMBURSEMENT_REOPENED: "Reimbursement form reopened for edits",
  REIMBURSEMENT_DOCUMENT_ADDED: "Reimbursement document added (after submission)",
  REIMBURSEMENT_INVITED: "Reimbursement form invite created",
  REIMBURSEMENT_LINK_SENT: "Reimbursement link emailed",
  REIMBURSEMENT_DELETED: "Reimbursement form deleted",
  // Organiser set / cleared the honorarium (speaker-honorarium route).
  HONORARIUM_SET: "Honorarium / speaker fee set",
  // Organiser chose which reimbursement types this speaker may claim.
  REIMBURSEMENT_TYPES_SET: "Reimbursement types set",
};

const CERT_LABELS: Record<string, string> = {
  ATTENDANCE: "Certificate of Attendance",
  APPRECIATION: "Certificate of Appreciation",
};

function auditLabel(action: string | undefined): string {
  if (!action) return "Activity";
  return AUDIT_LABELS[action] ?? action.replace(/_/g, " ").toLowerCase();
}

function itemSubline(item: ActivityItem) {
  if (item.kind === "email") return <>To {item.to}</>;
  if (item.kind === "certificate") {
    return (
      <>
        {item.serial}
        {item.pdfUrl ? "" : " · PDF not yet rendered"}
      </>
    );
  }
  return (
    <>
      {item.actor ? `by ${item.actor}` : "automated / self-service"}
      {item.ipAddress ? ` · ${item.ipAddress}` : ""}
    </>
  );
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
    case "BADGE_PRINTED":
    case "BADGE_REPRINTED":
      return Printer;
    case "SURVEY_RESET":
      return RotateCcw;
    case "EMAIL_SENT":
      return Mail;
    case "HONORARIUM_SET":
    case "REIMBURSEMENT_TYPES_SET":
      return Banknote;
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

/** A timeline email item in the shape the shared outcome reading takes. */
function emailRow(item: ActivityItem): EmailOutcomeInput {
  return {
    status: item.status === "FAILED" ? "FAILED" : "SENT",
    deliveryStatus: item.deliveryStatus ?? null,
    bounceType: item.bounceType ?? null,
    bounceSubType: item.bounceSubType ?? null,
    deliveryDetail: item.deliveryDetail ?? null,
    errorMessage: item.errorMessage ?? null,
  };
}

export function ActivityTimelineCard({ endpoint, anchor, queryKey, title = "Activity", currentEmails }: Props) {
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
  // Addresses whose newest reported email was a permanent bounce (src/lib/email-outcome.ts).
  const bouncing = bouncingAddresses(
    items.filter((item) => item.kind === "email" && !!item.to).map((item) => ({ ...emailRow(item), to: item.to as string, createdAt: item.at, deliveryAt: item.deliveryAt })),
    currentEmails,
  );

  // "View email" — the stored audit copy of a sent email's final HTML (every
  // send since July 16, 2026; older rows opt-in). Item ids are
  // `email:{emailLogId}`; the body is fetched on open by ViewEmailDialog.
  const [viewEmailId, setViewEmailId] = useState<string | null>(null);

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

      {bouncing.map((b) => (
        <div
          key={b.address}
          role="alert"
          className="mb-3 flex items-start gap-2 rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-800"
        >
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
          <div className="min-w-0">
            <p className="font-medium break-all">Emails to {b.address} are not being delivered.</p>
            <p className="mt-0.5 text-xs">
              The address has been bouncing since {format(new Date(b.since), "d MMM yyyy")}. Anything sent to it after that
              was dropped by the mail service, even where it shows as sent. Correct the address, then send again.
            </p>
          </div>
        </div>
      ))}

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
                    {item.kind === "email" && <EmailOutcomeBadge row={emailRow(item)} className="shrink-0" />}
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
                    {itemSubline(item)}
                  </p>
                  {item.kind === "email" && (
                    <EmailCopies cc={item.cc} bcc={item.bcc} className="break-all text-xs text-slate-500" />
                  )}
                  {item.detail && <p className="text-xs text-slate-500">{item.detail}</p>}
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
                  {item.kind === "email" && (item.attachmentNames?.length ?? 0) > 0 && (
                    <p className="mt-1 flex items-start gap-1 text-xs text-slate-500">
                      <Paperclip className="mt-0.5 h-3 w-3 shrink-0 text-slate-400" />
                      <span className="break-all">{item.attachmentNames!.join(", ")}</span>
                    </p>
                  )}
                  {item.kind === "email" && item.status !== "SENT" && item.errorMessage && (
                    <p className="text-xs text-red-500 mt-1">{item.errorMessage}</p>
                  )}
                  {item.kind === "email" && item.status === "SENT" && item.deliveryStatus && item.deliveryStatus !== "DELIVERED" && (
                    <p className="text-xs text-red-600 mt-1">
                      {emailOutcome(emailRow(item)).explanation}
                      {item.deliveryDetail && <span className="block break-all text-red-500/80">{item.deliveryDetail}</span>}
                    </p>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}

      {/* Sent-email viewer — the stored audit copy, rendered sandboxed. */}
      <ViewEmailDialog emailLogId={viewEmailId} onClose={() => setViewEmailId(null)} />
    </div>
  );
}
