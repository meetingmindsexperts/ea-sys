"use client";

/**
 * Speaker profile — "Photo & Documents form" card (Aug 4, 2026).
 *
 * Lets the organizer send this speaker a personalized public form link to
 * upload their photo + passport photocopy (+ optional cover letter) and
 * review their bio. Shows the form state (not sent / awaiting / submitted),
 * with send (through a mini dialog with subject/message overrides + a
 * Preview of the exact rendered email), copy link, and reopen-after-submit.
 *
 * Mirrors the SpeakerReimbursementCard shape. Self-hides for roles that
 * fail denyReviewer on the API anyway (staff-only surface).
 */

import { useCallback, useEffect, useState } from "react";
import { useSession } from "next-auth/react";
import { Check, Copy, Eye, IdCard, Loader2, RotateCcw, Send } from "lucide-react";
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
import { usePreviewEmailBySlug } from "@/hooks/use-api";
import { toast } from "sonner";

const STAFF_ROLES = new Set(["SUPER_ADMIN", "ADMIN", "ORGANIZER"]);

interface Props {
  eventId: string;
  speakerId: string;
}

interface FormRow {
  id: string;
  status: "PENDING" | "SUBMITTED";
  submittedAt: string | null;
  createdAt: string;
  link: string;
}

export function SpeakerProfileFormCard({ eventId, speakerId }: Props) {
  const { data: session } = useSession();
  const allowed = STAFF_ROLES.has(session?.user?.role ?? "");

  const [form, setForm] = useState<FormRow | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [sendOpen, setSendOpen] = useState(false);
  const [sendSubject, setSendSubject] = useState("");
  const [sendMessage, setSendMessage] = useState("");
  const previewMutation = usePreviewEmailBySlug(eventId);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [previewData, setPreviewData] = useState<{ subject: string; htmlContent: string } | null>(null);

  const base = `/api/events/${eventId}/speakers/${speakerId}/profile-form`;

  const load = useCallback(async () => {
    try {
      const res = await fetch(base);
      const json = await res.json();
      if (!res.ok) {
        console.error("speaker-profile-form-card:load-failed", res.status, json?.error);
        return;
      }
      setForm(json.form ?? null);
    } catch (err) {
      console.error("speaker-profile-form-card:load-error", err);
    } finally {
      setLoading(false);
    }
  }, [base]);

  useEffect(() => {
    if (allowed) void load();
  }, [allowed, load]);

  const handleSend = useCallback(async () => {
    setBusy(true);
    try {
      const res = await fetch(base, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          subject: sendSubject.trim() || undefined,
          message: sendMessage.trim() || undefined,
        }),
      });
      const json = await res.json();
      if (!res.ok) {
        console.error("speaker-profile-form-card:send-failed", res.status, json?.error);
        toast.error(json?.error || "Failed to email the form link");
        return;
      }
      toast.success(`Form link emailed to ${json.sentTo}`);
      setSendOpen(false);
      void load();
    } catch (err) {
      console.error("speaker-profile-form-card:send-error", err);
      toast.error("Failed to email the form link");
    } finally {
      setBusy(false);
    }
  }, [base, sendSubject, sendMessage, load]);

  const handlePreview = useCallback(async () => {
    try {
      const result = await previewMutation.mutateAsync({
        slug: "speaker-profile-form-request",
        // Preview greets THIS speaker, matching the send.
        speakerId,
        customSubject: sendSubject.trim() || undefined,
        customMessage: sendMessage.trim() || undefined,
      });
      setPreviewData(result);
      setPreviewOpen(true);
    } catch (err) {
      console.error("speaker-profile-form-card:preview-error", err);
      toast.error(err instanceof Error ? err.message : "Failed to generate preview");
    }
  }, [previewMutation, sendSubject, sendMessage, speakerId]);

  const handleCopy = useCallback(async () => {
    if (!form) return;
    try {
      await navigator.clipboard.writeText(form.link);
      toast.success("Link copied");
    } catch (err) {
      console.error("speaker-profile-form-card:copy-failed", err);
      toast.error("Couldn't copy the link");
    }
  }, [form]);

  const handleReopen = useCallback(async () => {
    setBusy(true);
    try {
      const res = await fetch(base, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reopen: true }),
      });
      const json = await res.json();
      if (!res.ok) {
        console.error("speaker-profile-form-card:reopen-failed", res.status, json?.error);
        toast.error(json?.error || "Failed to reopen the form");
        return;
      }
      toast.success("Form reopened — the speaker's existing link works again");
      void load();
    } catch (err) {
      console.error("speaker-profile-form-card:reopen-error", err);
      toast.error("Failed to reopen the form");
    } finally {
      setBusy(false);
    }
  }, [base, load]);

  if (!allowed) return null;

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base flex items-center gap-2">
          <IdCard className="h-4 w-4 text-primary" />
          Photo &amp; Documents form
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {loading ? (
          <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
        ) : !form ? (
          <>
            <p className="text-sm text-muted-foreground">
              Send the speaker a personalized link to upload their photo and passport
              photocopy (plus an optional cover letter) and review their bio.
            </p>
            <Button size="sm" disabled={busy} onClick={() => setSendOpen(true)}>
              <Send className="h-4 w-4 mr-1" /> Send the form
            </Button>
          </>
        ) : (
          <>
            <div className="flex items-center justify-between text-sm">
              {form.status === "SUBMITTED" ? (
                <span className="inline-flex items-center gap-1 rounded-full bg-emerald-50 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300 px-2 py-0.5 text-xs font-medium">
                  <Check className="h-3 w-3" /> Submitted
                  {form.submittedAt ? ` · ${new Date(form.submittedAt).toLocaleDateString()}` : ""}
                </span>
              ) : (
                <span className="inline-flex items-center rounded-full bg-amber-50 text-amber-700 dark:bg-amber-950 dark:text-amber-300 px-2 py-0.5 text-xs font-medium">
                  Awaiting submission
                </span>
              )}
            </div>
            <div className="flex flex-wrap gap-2">
              {form.status === "PENDING" && (
                <Button size="sm" variant="outline" disabled={busy} onClick={() => setSendOpen(true)}>
                  <Send className="h-4 w-4 mr-1" /> Resend link
                </Button>
              )}
              <Button size="sm" variant="outline" onClick={() => void handleCopy()}>
                <Copy className="h-4 w-4 mr-1" /> Copy link
              </Button>
              {form.status === "SUBMITTED" && (
                <Button size="sm" variant="outline" disabled={busy} onClick={() => void handleReopen()}>
                  <RotateCcw className="h-4 w-4 mr-1" /> Reopen for edits
                </Button>
              )}
            </div>
            {form.status === "SUBMITTED" && (
              <p className="text-xs text-muted-foreground">
                The photo is on this profile; passport/cover letter are on the Documents card.
              </p>
            )}
          </>
        )}
      </CardContent>

      {/* Send dialog — preview + personalize before anything goes out. */}
      <Dialog open={sendOpen} onOpenChange={setSendOpen}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Email the photo &amp; documents form</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            Sends this speaker their personalized form link using the{" "}
            <strong>Speaker Profile Form Request</strong> email template (editable under
            Communications → Email Templates).
          </p>
          <div className="space-y-3">
            <div>
              <Label htmlFor="spk-profile-subject">Subject (optional override)</Label>
              <Input
                id="spk-profile-subject"
                value={sendSubject}
                onChange={(e) => setSendSubject(e.target.value)}
                placeholder="Your photo & documents — …"
              />
            </div>
            <div>
              <Label htmlFor="spk-profile-message">Personal message (optional)</Label>
              <Textarea
                id="spk-profile-message"
                value={sendMessage}
                onChange={(e) => setSendMessage(e.target.value)}
                rows={3}
              />
            </div>
          </div>
          <DialogFooter className="gap-2 sm:justify-between">
            <Button variant="outline" onClick={() => void handlePreview()} disabled={previewMutation.isPending}>
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
                {busy ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : <Send className="h-4 w-4 mr-1" />}
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
