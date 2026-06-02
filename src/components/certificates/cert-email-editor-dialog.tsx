"use client";

/**
 * Email-editor dialog used by the certificate Issue flow (2026-06-02
 * evening). Opens when the operator clicks "Issue N certificates" on
 * the Issue tab — pre-filled with the template's saved emailSubject /
 * emailBody, or the system default for the template's category when
 * the template has no saved override yet.
 *
 * Two consumers:
 *  1. Issue flow — subject + body confirmed here become the run's
 *     stored snapshot (frozen for the duration of the run).
 *  2. Templates editor — the same dialog (or the inline-card variant
 *     below) lets the organizer save a default per template.
 *
 * The Tiptap editor is lazy-loaded so pdf-lib + tiptap don't load on
 * tabs that don't need them. Matches the lazy pattern used by the
 * existing bulk-email dialog + event content editors.
 */

import { useMemo, useState } from "react";
import dynamic from "next/dynamic";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Loader2, Send } from "lucide-react";
import { COVER_EMAIL_TOKENS } from "@/lib/certificates/email-tokens";
import type { CertificateType } from "@prisma/client";

const TiptapEditor = dynamic(
  () => import("@/components/ui/tiptap-editor").then((m) => m.TiptapEditor),
  {
    ssr: false,
    loading: () => (
      <div className="h-64 rounded border bg-muted/30 animate-pulse flex items-center justify-center text-sm text-muted-foreground">
        Loading editor…
      </div>
    ),
  },
);

export interface CertEmailEditorDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Drives the token-reference dropdown filter (hides abstractTitle on
   *  ATTENDANCE templates). */
  category: CertificateType;
  /** Pre-fill values. Caller resolves "use template default" vs "use
   *  system default" before passing in. */
  initialSubject: string;
  initialBody: string;
  /** Action button label + intent. */
  submitLabel: string;
  /** How many recipients will receive this. Shown in the dialog
   *  confirmation footer + button. 0 hides the count. */
  recipientCount?: number;
  /** Optional helper text shown above the editor — used by the Issue
   *  flow to describe what happens on confirm. */
  helperText?: string;
  /** Pending state — disables Confirm + shows spinner. */
  submitting?: boolean;
  /** Called with the operator-confirmed subject + body. The dialog
   *  trims subject + body before calling. */
  onSubmit: (vars: { emailSubject: string; emailBody: string }) => void;
}

export function CertEmailEditorDialog({
  open,
  onOpenChange,
  category,
  initialSubject,
  initialBody,
  submitLabel,
  recipientCount,
  helperText,
  submitting,
  onSubmit,
}: CertEmailEditorDialogProps) {
  // Local state — only persisted out on Confirm. Cancel preserves the
  // operator's pre-existing draft on the next open (parent owns
  // initialSubject/initialBody and decides what to re-seed with).
  const [subject, setSubject] = useState(initialSubject);
  const [body, setBody] = useState(initialBody);

  // Reset local state whenever the parent re-opens with new initials.
  // React 19 "store info from previous renders" pattern — comparing
  // initials via concat-stable key so the seed flips on actual change.
  const seedKey = `${initialSubject}␟${initialBody}`;
  const [lastSeedKey, setLastSeedKey] = useState(seedKey);
  if (seedKey !== lastSeedKey) {
    setLastSeedKey(seedKey);
    setSubject(initialSubject);
    setBody(initialBody);
  }

  const tokensForCategory = useMemo(
    () => COVER_EMAIL_TOKENS.filter((t) => t.categories.includes(category)),
    [category],
  );

  function appendToken(token: string, target: "subject" | "body") {
    if (target === "subject") {
      setSubject((cur) => `${cur}${cur.endsWith(" ") || cur === "" ? "" : " "}${token}`);
    } else {
      // For the body, append a paragraph containing the token. The
      // operator can re-position via Tiptap; this keeps the click-to-
      // insert behavior predictable rather than trying to track the
      // current cursor inside Tiptap.
      setBody((cur) => `${cur}<p>${token}</p>`);
    }
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const subjectTrimmed = subject.trim();
    const bodyTrimmed = body.trim();
    if (subjectTrimmed.length === 0 || bodyTrimmed.length === 0) return;
    onSubmit({ emailSubject: subjectTrimmed, emailBody: bodyTrimmed });
  }

  const disabled = submitting || subject.trim().length === 0 || body.trim().length === 0;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-3xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Cover email</DialogTitle>
          <DialogDescription>
            {helperText ??
              "The cert PDF is attached automatically. Edit the cover-email subject and body below."}
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="cert-email-subject">Subject</Label>
            <Input
              id="cert-email-subject"
              value={subject}
              onChange={(e) => setSubject(e.target.value)}
              maxLength={200}
              required
            />
          </div>

          <div className="space-y-2">
            <Label>Body</Label>
            <TiptapEditor
              content={body}
              onChange={setBody}
              placeholder="Write the cover message..."
            />
          </div>

          <details className="rounded-md border p-3 text-sm">
            <summary className="cursor-pointer font-medium">
              Available tokens ({tokensForCategory.length})
            </summary>
            <p className="text-xs text-muted-foreground mt-2 mb-2">
              Click a token to append it to the subject or body. Tokens
              resolve per recipient when the email is sent.
            </p>
            <div className="space-y-1">
              {tokensForCategory.map((t) => (
                <div key={t.token} className="flex items-center justify-between gap-2 py-1">
                  <div className="min-w-0">
                    <code className="text-xs font-mono text-primary">{t.token}</code>
                    <span className="block text-xs text-muted-foreground truncate">
                      {t.description}
                    </span>
                  </div>
                  <div className="flex gap-1 shrink-0">
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={() => appendToken(t.token, "subject")}
                    >
                      → Subject
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={() => appendToken(t.token, "body")}
                    >
                      → Body
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          </details>

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={disabled}>
              {submitting ? (
                <Loader2 className="h-4 w-4 mr-1 animate-spin" />
              ) : (
                <Send className="h-4 w-4 mr-1" />
              )}
              {submitLabel}
              {typeof recipientCount === "number" && recipientCount > 0 && (
                <span className="ml-1">({recipientCount})</span>
              )}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
