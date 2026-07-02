"use client";

import { useState } from "react";
import { Calendar, Clock, Edit, RotateCw, Trash2, AlertCircle, CheckCircle2, Loader2, Users, TrendingUp } from "lucide-react";
import { toast } from "sonner";
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  useScheduledEmails,
  useCancelScheduledEmail,
  useRetryScheduledEmail,
  type ScheduledEmailItem,
} from "@/hooks/use-api";
import { ScheduledEmailEditDialog } from "./scheduled-email-edit-dialog";
import { parseFailedRecipients } from "@/lib/scheduled-email-failures";

interface Props {
  eventId: string;
}

const STATUS_LABELS: Record<ScheduledEmailItem["status"], string> = {
  PENDING: "Pending",
  PROCESSING: "Processing",
  SENT: "Sent",
  FAILED: "Failed",
  CANCELLED: "Cancelled",
};

const STATUS_VARIANTS: Record<
  ScheduledEmailItem["status"],
  { className: string; icon: React.ReactNode }
> = {
  PENDING: {
    className: "bg-amber-100 text-amber-800 hover:bg-amber-100",
    icon: <Clock className="h-3 w-3" />,
  },
  PROCESSING: {
    className: "bg-blue-100 text-blue-800 hover:bg-blue-100",
    icon: <Loader2 className="h-3 w-3 animate-spin" />,
  },
  SENT: {
    className: "bg-green-100 text-green-800 hover:bg-green-100",
    icon: <CheckCircle2 className="h-3 w-3" />,
  },
  FAILED: {
    className: "bg-red-100 text-red-800 hover:bg-red-100",
    icon: <AlertCircle className="h-3 w-3" />,
  },
  CANCELLED: {
    className: "bg-gray-100 text-gray-700 hover:bg-gray-100",
    icon: <Trash2 className="h-3 w-3" />,
  },
};

function StatusBadge({ status }: { status: ScheduledEmailItem["status"] }) {
  const v = STATUS_VARIANTS[status];
  return (
    <Badge className={`gap-1 ${v.className}`}>
      {v.icon}
      {STATUS_LABELS[status]}
    </Badge>
  );
}

/** Compact KPI strip summarising every scheduled email for the event — computed
 *  entirely from the already-loaded rows (no extra fetch). */
function SummaryStrip({ rows }: { rows: ScheduledEmailItem[] }) {
  const sent = rows.filter((r) => r.status === "SENT").length;
  const pending = rows.filter((r) => r.status === "PENDING" || r.status === "PROCESSING").length;
  const failed = rows.filter((r) => r.status === "FAILED").length;
  // Recipients reached = successful sends across completed rows; rate is over
  // what those rows actually attempted (SENT rows with a known total).
  const delivered = rows.reduce((s, r) => s + (r.status === "SENT" ? r.successCount ?? 0 : 0), 0);
  const attempted = rows.reduce((s, r) => s + (r.status === "SENT" ? r.totalCount ?? 0 : 0), 0);
  const rate = attempted > 0 ? Math.round((delivered / attempted) * 1000) / 10 : null;

  const stats: { label: string; value: string; icon: React.ReactNode; className: string }[] = [
    { label: "Scheduled", value: String(rows.length), icon: <Calendar className="h-4 w-4" />, className: "text-[#00aade]" },
    { label: "Sent", value: String(sent), icon: <CheckCircle2 className="h-4 w-4" />, className: "text-green-600" },
    { label: "Pending", value: String(pending), icon: <Clock className="h-4 w-4" />, className: "text-amber-600" },
    { label: "Failed", value: String(failed), icon: <AlertCircle className="h-4 w-4" />, className: "text-red-600" },
    { label: "Delivered", value: delivered.toLocaleString(), icon: <Users className="h-4 w-4" />, className: "text-[#00aade]" },
    { label: "Delivery rate", value: rate != null ? `${rate}%` : "—", icon: <TrendingUp className="h-4 w-4" />, className: "text-green-600" },
  ];

  return (
    <div className="mb-4 grid grid-cols-3 gap-2 sm:grid-cols-6">
      {stats.map((s) => (
        <div key={s.label} className="rounded-lg border bg-muted/30 p-2.5">
          <div className={`flex items-center gap-1.5 ${s.className}`}>
            {s.icon}
            <span className="text-lg font-semibold tabular-nums">{s.value}</span>
          </div>
          <div className="mt-0.5 text-[11px] text-muted-foreground">{s.label}</div>
        </div>
      ))}
    </div>
  );
}

/** Inline delivery outcome for a row — surfaces the counts that were previously
 *  only visible on a status-badge hover. The failed count opens a per-recipient
 *  drill-down when a parsed failure list is available. */
function ResultsCell({
  row,
  onShowFailures,
}: {
  row: ScheduledEmailItem;
  onShowFailures: (row: ScheduledEmailItem) => void;
}) {
  if (row.status === "SENT") {
    const total = row.totalCount ?? 0;
    const success = row.successCount ?? 0;
    const failed = row.failureCount ?? 0;
    if (total === 0) {
      return <span className="text-xs text-muted-foreground">No recipients</span>;
    }
    const hasFailureList = failed > 0 && (parseFailedRecipients(row.lastError)?.length ?? 0) > 0;
    return (
      <div className="flex flex-col text-xs">
        <span className="font-medium text-green-700">
          {success.toLocaleString()}/{total.toLocaleString()} delivered
        </span>
        {failed > 0 &&
          (hasFailureList ? (
            <button
              type="button"
              onClick={() => onShowFailures(row)}
              className="text-left text-red-600 underline decoration-dotted hover:text-red-700"
            >
              {failed.toLocaleString()} failed
            </button>
          ) : (
            <span className="text-red-600">{failed.toLocaleString()} failed</span>
          ))}
      </div>
    );
  }
  if (row.status === "FAILED") {
    return row.lastError ? (
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="cursor-help text-xs text-red-600 underline decoration-dotted">
            View error
          </span>
        </TooltipTrigger>
        <TooltipContent className="max-w-xs break-words">{row.lastError}</TooltipContent>
      </Tooltip>
    ) : (
      <span className="text-xs text-muted-foreground">—</span>
    );
  }
  if (row.status === "PROCESSING") {
    return <span className="text-xs text-blue-600">Sending…</span>;
  }
  return <span className="text-xs text-muted-foreground">—</span>;
}

const RECIPIENT_LABEL: Record<ScheduledEmailItem["recipientType"], string> = {
  registrations: "Registrations",
  speakers: "Speakers",
  abstracts: "Abstract Submitters",
  reviewers: "Reviewers",
};

const EMAIL_TYPE_LABEL: Record<string, string> = {
  invitation: "Invitation",
  agreement: "Agreement",
  confirmation: "Confirmation",
  reminder: "Event Reminder",
  custom: "Custom",
  "abstract-accepted": "Abstract Accepted",
  "abstract-rejected": "Abstract Rejected",
  "abstract-revision": "Revision Requested",
  "abstract-reminder": "Submission Reminder",
};

export function ScheduledEmailsList({ eventId }: Props) {
  const { data: scheduledEmails = [], isLoading } = useScheduledEmails(eventId);
  const cancelMutation = useCancelScheduledEmail(eventId);
  const retryMutation = useRetryScheduledEmail(eventId);

  const [editing, setEditing] = useState<ScheduledEmailItem | null>(null);
  const [confirmCancel, setConfirmCancel] = useState<ScheduledEmailItem | null>(null);
  const [viewingFailures, setViewingFailures] = useState<ScheduledEmailItem | null>(null);

  const handleCancel = async () => {
    if (!confirmCancel) return;
    try {
      await cancelMutation.mutateAsync(confirmCancel.id);
      toast.success("Scheduled email cancelled");
      setConfirmCancel(null);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to cancel");
    }
  };

  const handleRetry = async (id: string) => {
    try {
      await retryMutation.mutateAsync(id);
      toast.success("Re-queued for sending");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to retry");
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Calendar className="h-5 w-5" />
          Scheduled Emails
        </CardTitle>
        <CardDescription>
          Emails queued for future delivery. Recipients are re-evaluated when each email is sent.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <div className="flex h-24 items-center justify-center text-sm text-muted-foreground">
            Loading…
          </div>
        ) : scheduledEmails.length === 0 ? (
          <div className="flex h-24 items-center justify-center text-sm text-muted-foreground">
            No scheduled emails yet. Use the audience cards above and choose &ldquo;Schedule for later&rdquo;.
          </div>
        ) : (
          <>
            <SummaryStrip rows={scheduledEmails} />
          <TooltipProvider>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Scheduled For</TableHead>
                  <TableHead>Recipients</TableHead>
                  <TableHead>Email Type</TableHead>
                  <TableHead>Subject</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Results</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {scheduledEmails.map((row) => (
                  <TableRow key={row.id}>
                    <TableCell className="font-mono text-xs">
                      {new Date(row.scheduledFor).toLocaleString()}
                      {row.sentAt && (
                        <div className="mt-0.5 font-sans text-[10px] text-muted-foreground">
                          Sent {new Date(row.sentAt).toLocaleString()}
                        </div>
                      )}
                    </TableCell>
                    <TableCell>
                      <div className="flex flex-col">
                        <span>{RECIPIENT_LABEL[row.recipientType]}</span>
                        {row.recipientIds.length > 0 ? (
                          <span className="text-xs text-muted-foreground">
                            {row.recipientIds.length} fixed
                          </span>
                        ) : (
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <span className="text-xs text-muted-foreground underline decoration-dotted">
                                matching at send time
                              </span>
                            </TooltipTrigger>
                            <TooltipContent>
                              Audience is re-evaluated when this sends, so it includes
                              registrations added after it was scheduled.
                            </TooltipContent>
                          </Tooltip>
                        )}
                      </div>
                    </TableCell>
                    <TableCell>{EMAIL_TYPE_LABEL[row.emailType] ?? row.emailType}</TableCell>
                    <TableCell className="max-w-[200px] truncate">
                      {row.customSubject || <span className="text-muted-foreground">—</span>}
                    </TableCell>
                    <TableCell>
                      <div className="flex flex-col items-start gap-1">
                        <StatusBadge status={row.status} />
                        {row.retryCount > 0 && (
                          <span className="text-[10px] text-muted-foreground">
                            retried ×{row.retryCount}
                          </span>
                        )}
                      </div>
                    </TableCell>
                    <TableCell>
                      <ResultsCell row={row} onShowFailures={setViewingFailures} />
                    </TableCell>
                    <TableCell className="text-right">
                      <div className="flex items-center justify-end gap-1">
                        {row.status === "PENDING" && (
                          <>
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() => setEditing(row)}
                              aria-label="Edit scheduled email"
                            >
                              <Edit className="h-4 w-4" />
                            </Button>
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() => setConfirmCancel(row)}
                              aria-label="Cancel scheduled email"
                            >
                              <Trash2 className="h-4 w-4" />
                            </Button>
                          </>
                        )}
                        {row.status === "FAILED" && (
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => handleRetry(row.id)}
                            disabled={retryMutation.isPending}
                            aria-label="Retry scheduled email"
                          >
                            <RotateCw className="h-4 w-4" />
                          </Button>
                        )}
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </TooltipProvider>
          </>
        )}
      </CardContent>

      <ScheduledEmailEditDialog
        eventId={eventId}
        scheduledEmail={editing}
        open={!!editing}
        onOpenChange={(o) => !o && setEditing(null)}
      />

      <AlertDialog open={!!confirmCancel} onOpenChange={(o) => !o && setConfirmCancel(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Cancel scheduled email?</AlertDialogTitle>
            <AlertDialogDescription>
              This email will not be sent. You can schedule a new one anytime.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={cancelMutation.isPending}>Keep it</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleCancel}
              disabled={cancelMutation.isPending}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {cancelMutation.isPending ? "Cancelling…" : "Cancel email"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <Dialog open={!!viewingFailures} onOpenChange={(o) => !o && setViewingFailures(null)}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Failed recipients</DialogTitle>
            <DialogDescription>
              {viewingFailures &&
                `${(viewingFailures.failureCount ?? 0).toLocaleString()} of ${(
                  viewingFailures.totalCount ?? 0
                ).toLocaleString()} recipients didn't receive this email.`}
            </DialogDescription>
          </DialogHeader>
          {(() => {
            const list = parseFailedRecipients(viewingFailures?.lastError ?? null) ?? [];
            const notShown = Math.max(0, (viewingFailures?.failureCount ?? 0) - list.length);
            return (
              <div className="max-h-[50vh] overflow-y-auto rounded-md border">
                <table className="w-full text-xs">
                  <thead className="sticky top-0 bg-muted">
                    <tr>
                      <th className="p-2 text-left font-medium">Email</th>
                      <th className="p-2 text-left font-medium">Reason</th>
                    </tr>
                  </thead>
                  <tbody>
                    {list.map((r, i) => (
                      <tr key={`${r.email}-${i}`} className="border-t">
                        <td className="break-all p-2 font-mono">{r.email}</td>
                        <td className="p-2 text-muted-foreground">{r.error}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {notShown > 0 && (
                  <div className="border-t p-2 text-center text-[11px] text-muted-foreground">
                    …and {notShown.toLocaleString()} more not shown
                  </div>
                )}
              </div>
            );
          })()}
        </DialogContent>
      </Dialog>
    </Card>
  );
}
