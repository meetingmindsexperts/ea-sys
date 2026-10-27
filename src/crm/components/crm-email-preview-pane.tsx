"use client";

/**
 * The compose dialog's Preview (Oct 27, 2026): the email exactly as one chosen
 * recipient will receive it, with their name, the event's details, the sender's
 * signature and the event branding, rendered on the server by the send's own
 * code. Nothing is sent.
 *
 * The HTML renders in a sandboxed iframe (no scripts, no same-origin), the same
 * containment the CRM inbox uses for email bodies.
 */
import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { usePreviewCrmEmail, type CrmEmailTarget } from "@/crm/hooks/use-crm-api";
import type { SponsorRecipient } from "@/crm/lib/crm-types";

export function CrmEmailPreviewPane({
  target,
  recipients,
  subject,
  message,
}: {
  target: CrmEmailTarget;
  /** The people the send will reach; the preview can be for any of them. */
  recipients: SponsorRecipient[];
  subject: string;
  message: string;
}) {
  const [contactId, setContactId] = useState(recipients[0]?.crmContactId);
  const preview = usePreviewCrmEmail();
  const { mutate } = preview;

  useEffect(() => {
    mutate({
      [target.kind === "deal" ? "dealId" : "eventId"]: target.id,
      ...(contactId ? { contactId } : {}),
      subject,
      message,
    });
  }, [mutate, target.kind, target.id, contactId, subject, message]);

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto pr-1">
      {recipients.length > 1 && (
        <div className="flex items-center gap-2">
          <Label className="shrink-0 text-sm text-muted-foreground">Preview for</Label>
          <Select value={contactId} onValueChange={setContactId}>
            <SelectTrigger className="h-8 w-full sm:w-80" aria-label="Preview for">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {recipients.map((r) => (
                <SelectItem key={r.crmContactId} value={r.crmContactId}>
                  {`${r.firstName} ${r.lastName}`.trim()} · {r.email}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      )}
      {recipients.length === 0 && (
        <p className="text-xs text-muted-foreground">Nobody is selected, so this shows a sample person.</p>
      )}

      {preview.isPending && (
        <p className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" />
          Building the preview…
        </p>
      )}
      {preview.isError && (
        <p className="text-sm text-destructive">
          {preview.error instanceof Error ? preview.error.message : "Could not build the preview"}
        </p>
      )}
      {preview.data && !preview.isPending && (
        <>
          <div className="rounded-md border bg-muted/20 px-3 py-2 text-sm">
            <span className="text-muted-foreground">Subject: </span>
            <span className="font-medium">{preview.data.subject}</span>
          </div>
          <iframe
            title="Email preview"
            sandbox=""
            srcDoc={preview.data.html}
            className="h-[50vh] min-h-[280px] w-full shrink-0 rounded-md border bg-white"
          />
        </>
      )}
    </div>
  );
}
