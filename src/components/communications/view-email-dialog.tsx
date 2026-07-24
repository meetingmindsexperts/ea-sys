"use client";

import { useQuery } from "@tanstack/react-query";
import { Loader2, Mail } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

interface ViewEmailDialogProps {
  /** The EmailLog id whose stored HTML to render, or null when closed. */
  emailLogId: string | null;
  onClose: () => void;
}

/**
 * Renders the stored audit copy of a sent email (its final HTML), fetched on
 * open from `GET /api/email-logs/[id]/body` and shown in a fully-sandboxed
 * iframe (`sandbox=""` — no scripts, no same-origin) so template markup can't
 * touch the dashboard. Shared by the Activity timeline, the per-person Email
 * History card, and the Email Activity table so the viewer stays identical
 * (and can't drift) across all three.
 */
export function ViewEmailDialog({ emailLogId, onClose }: ViewEmailDialogProps) {
  const query = useQuery<{ subject: string; to: string; htmlBody: string }>({
    queryKey: ["email-log-body", emailLogId],
    queryFn: async () => {
      const res = await fetch(`/api/email-logs/${emailLogId}/body`);
      if (!res.ok) {
        const data = (await res.json().catch(() => null)) as { error?: string } | null;
        throw new Error(data?.error ?? `Failed to load the email (${res.status})`);
      }
      return res.json();
    },
    enabled: !!emailLogId,
    staleTime: 5 * 60_000,
  });

  return (
    <Dialog open={!!emailLogId} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Mail className="h-4 w-4" />
            Sent email
          </DialogTitle>
          <DialogDescription>
            {query.data
              ? `To ${query.data.to} — “${query.data.subject}”`
              : "The stored copy of exactly what was sent."}
          </DialogDescription>
        </DialogHeader>
        {query.isLoading && (
          <div className="flex items-center gap-2 p-4 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" /> Loading the stored email…
          </div>
        )}
        {query.isError && (
          <p className="rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-700">
            {query.error instanceof Error ? query.error.message : "Failed to load the email"}
          </p>
        )}
        {query.data && (
          <iframe
            title="Sent email"
            sandbox=""
            srcDoc={query.data.htmlBody}
            className="h-[28rem] w-full rounded-md border bg-white"
          />
        )}
      </DialogContent>
    </Dialog>
  );
}
