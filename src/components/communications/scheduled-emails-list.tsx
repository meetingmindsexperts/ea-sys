"use client";

import { useState } from "react";
import { Calendar, Clock, Edit, RotateCw, Trash2, AlertCircle, CheckCircle2, Loader2 } from "lucide-react";
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
          <TooltipProvider>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Scheduled For</TableHead>
                  <TableHead>Recipients</TableHead>
                  <TableHead>Email Type</TableHead>
                  <TableHead>Subject</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {scheduledEmails.map((row) => (
                  <TableRow key={row.id}>
                    <TableCell className="font-mono text-xs">
                      {new Date(row.scheduledFor).toLocaleString()}
                    </TableCell>
                    <TableCell>{RECIPIENT_LABEL[row.recipientType]}</TableCell>
                    <TableCell>{EMAIL_TYPE_LABEL[row.emailType] ?? row.emailType}</TableCell>
                    <TableCell className="max-w-[200px] truncate">
                      {row.customSubject || <span className="text-muted-foreground">—</span>}
                    </TableCell>
                    <TableCell>
                      {row.status === "SENT" && row.totalCount != null ? (
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <span>
                              <StatusBadge status={row.status} />
                            </span>
                          </TooltipTrigger>
                          <TooltipContent>
                            {row.successCount}/{row.totalCount} delivered
                            {row.failureCount ? ` · ${row.failureCount} failed` : ""}
                          </TooltipContent>
                        </Tooltip>
                      ) : row.status === "FAILED" && row.lastError ? (
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <span>
                              <StatusBadge status={row.status} />
                            </span>
                          </TooltipTrigger>
                          <TooltipContent className="max-w-xs">{row.lastError}</TooltipContent>
                        </Tooltip>
                      ) : (
                        <StatusBadge status={row.status} />
                      )}
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
    </Card>
  );
}
