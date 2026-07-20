"use client";

/**
 * Speaker profile — Reimbursement card.
 *
 * Shows this speaker's reimbursement state (not invited / pending /
 * submitted with totals) and lets the organizer act without leaving the
 * profile: create the invite, email the personalized link (through a mini
 * send dialog with optional subject/message overrides + a Preview of the
 * exact rendered email — console parity), copy it, or jump to the full
 * console for the submission detail.
 *
 * SELF-HIDES for roles outside the reimbursement boundary
 * (canManageReimbursements: SUPER_ADMIN / ADMIN / ORGANIZER only) — the
 * card's data is fetched from the staff-gated list API, and bank/passport
 * data must not be teased to MEMBER/ONSITE on the speaker page.
 */

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useSession } from "next-auth/react";
import { Banknote, Check, Copy, ExternalLink, Eye, Loader2, Plus, Send } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { EmailPreviewDialog } from "@/components/email-preview-dialog";
import { useEvent, usePreviewEmailBySlug } from "@/hooks/use-api";
import {
  canManageReimbursements,
  formatClaimTotals,
  type ClaimLine,
} from "@/lib/reimbursement/constants";
import { toast } from "sonner";

interface Props {
  eventId: string;
  speakerId: string;
}

interface Row {
  id: string;
  token: string;
  status: "PENDING" | "SUBMITTED";
  submittedAt: string | null;
  claimLines: ClaimLine[] | null;
  documents: { id: string }[];
}

export function SpeakerReimbursementCard({ eventId, speakerId }: Props) {
  const { data: session } = useSession();
  const { data: event } = useEvent(eventId);
  const allowed = canManageReimbursements(session?.user?.role);

  const [row, setRow] = useState<Row | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [sendOpen, setSendOpen] = useState(false);
  const [sendSubject, setSendSubject] = useState("");
  const [sendMessage, setSendMessage] = useState("");
  const previewMutation = usePreviewEmailBySlug(eventId);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [previewData, setPreviewData] = useState<{ subject: string; htmlContent: string } | null>(
    null,
  );

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/events/${eventId}/reimbursements?speakerId=${speakerId}`);
      const json = await res.json();
      if (!res.ok) {
        console.error("speaker-reimbursement-card:load-failed", res.status, json?.error);
        return;
      }
      setRow(json.reimbursements?.[0] ?? null);
    } catch (err) {
      console.error("speaker-reimbursement-card:load-error", err);
    } finally {
      setLoading(false);
    }
  }, [eventId, speakerId]);

  useEffect(() => {
    if (allowed) void load();
  }, [allowed, load]);

  const handleCreate = useCallback(
    async (sendAfter: boolean) => {
      setBusy(true);
      try {
        const res = await fetch(`/api/events/${eventId}/reimbursements`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ speakerIds: [speakerId] }),
        });
        const json = await res.json();
        if (!res.ok) {
          console.error("speaker-reimbursement-card:create-failed", res.status, json?.error);
          toast.error(json?.error || "Failed to create the reimbursement invite");
          return;
        }
        // Reload to pick up the minted row (needed for the send dialog).
        const listRes = await fetch(`/api/events/${eventId}/reimbursements?speakerId=${speakerId}`);
        const listJson = await listRes.json();
        const created: Row | null = listRes.ok ? (listJson.reimbursements?.[0] ?? null) : null;
        setRow(created);
        toast.success("Reimbursement invite created");
        // "Create & email link" continues into the send dialog so the
        // organizer can preview / personalize before anything goes out.
        if (sendAfter && created) setSendOpen(true);
      } catch (err) {
        console.error("speaker-reimbursement-card:create-error", err);
        toast.error("Failed to create the reimbursement invite");
      } finally {
        setBusy(false);
      }
    },
    [eventId, speakerId],
  );

  const handleSend = useCallback(async () => {
    if (!row) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/events/${eventId}/reimbursements/send`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          reimbursementId: row.id,
          subject: sendSubject.trim() || undefined,
          message: sendMessage.trim() || undefined,
        }),
      });
      const json = await res.json();
      if (!res.ok || json.failed > 0) {
        console.error("speaker-reimbursement-card:send-failed", res.status, json?.error);
        toast.error(json?.error || "Failed to email the reimbursement link");
        return;
      }
      toast.success("Reimbursement link emailed to the speaker");
      setSendOpen(false);
    } catch (err) {
      console.error("speaker-reimbursement-card:send-error", err);
      toast.error("Failed to email the reimbursement link");
    } finally {
      setBusy(false);
    }
  }, [eventId, row, sendSubject, sendMessage]);

  // Renders the real per-event template + the typed overrides — identical to
  // the console's preview (shared /email-preview route, template auto-picked).
  const handlePreview = useCallback(async () => {
    try {
      const result = await previewMutation.mutateAsync({
        slug: "speaker-reimbursement-invitation",
        customSubject: sendSubject.trim() || undefined,
        customMessage: sendMessage.trim() || undefined,
      });
      setPreviewData(result);
      setPreviewOpen(true);
    } catch (err) {
      console.error("speaker-reimbursement-card:preview-error", err);
      toast.error(err instanceof Error ? err.message : "Failed to generate preview");
    }
  }, [previewMutation, sendSubject, sendMessage]);

  const handleCopy = useCallback(async () => {
    if (!row) return;
    if (!event?.slug) {
      toast.error("Event details are still loading — try again in a moment.");
      return;
    }
    try {
      await navigator.clipboard.writeText(
        `${window.location.origin}/e/${event.slug}/reimbursement/${row.token}`,
      );
      toast.success("Link copied");
    } catch (err) {
      console.error("speaker-reimbursement-card:copy-failed", err);
      toast.error("Couldn't copy the link");
    }
  }, [row, event?.slug]);

  if (!allowed) return null;

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base flex items-center gap-2">
          <Banknote className="h-4 w-4 text-emerald-600" />
          Reimbursement
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {loading ? (
          <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
        ) : !row ? (
          <>
            <p className="text-sm text-muted-foreground">
              No reimbursement form yet. Send the speaker a personalized link to claim their
              fee, flights, hotel and transport.
            </p>
            <div className="flex flex-wrap gap-2">
              <Button size="sm" disabled={busy} onClick={() => void handleCreate(true)}>
                {busy ? (
                  <Loader2 className="h-4 w-4 mr-1 animate-spin" />
                ) : (
                  <Send className="h-4 w-4 mr-1" />
                )}
                Create &amp; email link
              </Button>
              <Button size="sm" variant="outline" disabled={busy} onClick={() => void handleCreate(false)}>
                <Plus className="h-4 w-4 mr-1" /> Create only
              </Button>
            </div>
          </>
        ) : (
          <>
            <div className="flex items-center justify-between text-sm">
              {row.status === "SUBMITTED" ? (
                <span className="inline-flex items-center gap-1 rounded-full bg-emerald-50 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300 px-2 py-0.5 text-xs font-medium">
                  <Check className="h-3 w-3" /> Submitted
                  {row.submittedAt ? ` · ${new Date(row.submittedAt).toLocaleDateString()}` : ""}
                </span>
              ) : (
                <span className="inline-flex items-center rounded-full bg-amber-50 text-amber-700 dark:bg-amber-950 dark:text-amber-300 px-2 py-0.5 text-xs font-medium">
                  Awaiting submission
                </span>
              )}
              {row.claimLines?.length ? (
                <span className="tabular-nums font-medium">{formatClaimTotals(row.claimLines)}</span>
              ) : null}
            </div>
            <div className="flex flex-wrap gap-2">
              <Button size="sm" variant="outline" disabled={busy} onClick={() => setSendOpen(true)}>
                <Send className="h-4 w-4 mr-1" />
                {row.status === "SUBMITTED" ? "Resend link" : "Email link"}
              </Button>
              <Button size="sm" variant="outline" onClick={() => void handleCopy()}>
                <Copy className="h-4 w-4 mr-1" /> Copy link
              </Button>
              <Button size="sm" variant="ghost" asChild>
                <Link href={`/events/${eventId}/reimbursements`}>
                  <ExternalLink className="h-4 w-4 mr-1" /> Open console
                </Link>
              </Button>
            </div>
          </>
        )}
      </CardContent>

      {/* Send dialog — preview + personalize before anything goes out. */}
      <Dialog open={sendOpen} onOpenChange={setSendOpen}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Email reimbursement link</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            Sends this speaker their personalized form link using the{" "}
            <strong>Speaker Reimbursement Form</strong> email template (editable under
            Communications → Email Templates).
          </p>
          <div className="space-y-3">
            <div>
              <Label htmlFor="spk-reimb-subject">Subject (optional override)</Label>
              <Input
                id="spk-reimb-subject"
                value={sendSubject}
                onChange={(e) => setSendSubject(e.target.value)}
                placeholder="Reimbursement form — …"
              />
            </div>
            <div>
              <Label htmlFor="spk-reimb-message">Personal message (optional)</Label>
              <Textarea
                id="spk-reimb-message"
                value={sendMessage}
                onChange={(e) => setSendMessage(e.target.value)}
                rows={3}
              />
            </div>
          </div>
          <DialogFooter className="gap-2 sm:justify-between">
            <Button
              variant="outline"
              onClick={() => void handlePreview()}
              disabled={previewMutation.isPending}
            >
              {previewMutation.isPending ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <>
                  <Eye className="h-4 w-4 mr-1" /> Preview
                </>
              )}
            </Button>
            <div className="flex gap-2">
              <Button variant="outline" onClick={() => setSendOpen(false)}>
                Cancel
              </Button>
              <Button onClick={() => void handleSend()} disabled={busy}>
                {busy ? (
                  <Loader2 className="h-4 w-4 mr-1 animate-spin" />
                ) : (
                  <Send className="h-4 w-4 mr-1" />
                )}
                Send
              </Button>
            </div>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {previewData && (
        <EmailPreviewDialog
          open={previewOpen}
          onOpenChange={setPreviewOpen}
          subject={previewData.subject}
          htmlContent={previewData.htmlContent}
        />
      )}
    </Card>
  );
}
