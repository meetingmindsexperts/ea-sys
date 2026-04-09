"use client";

import { useRef, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Calendar, Eye, Loader2, Mail, Paperclip, Send, X } from "lucide-react";
import { toast } from "sonner";
import { useBulkEmail, usePreviewEmailBySlug, useScheduleBulkEmail } from "@/hooks/use-api";
import { EmailPreviewDialog } from "@/components/email-preview-dialog";

type RecipientType = "speakers" | "registrations" | "reviewers" | "abstracts";

interface EmailTypeOption {
  value: string;
  label: string;
  description: string;
}

interface BulkEmailDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  eventId: string;
  recipientType: RecipientType;
  recipientIds: string[];
  recipientCount: number;
  /** "all" when no specific IDs selected (send to all matching filters) */
  selectionMode: "selected" | "all";
  statusFilter?: string;
  ticketTypeFilter?: string;
}

const speakerEmailTypes: EmailTypeOption[] = [
  { value: "invitation", label: "Speaker Invitation", description: "Invite speakers to your event" },
  { value: "agreement", label: "Speaker Agreement", description: "Send agreement terms for review" },
  { value: "custom", label: "Custom Email", description: "Write a custom message" },
];

const reviewerEmailTypes: EmailTypeOption[] = [
  { value: "custom", label: "Custom Email", description: "Write a custom message to reviewers" },
  { value: "invitation", label: "Review Invitation", description: "Invite to review abstracts" },
];

const registrationEmailTypes: EmailTypeOption[] = [
  { value: "confirmation", label: "Registration Confirmation", description: "Confirm their registration" },
  { value: "reminder", label: "Event Reminder", description: "Remind about the upcoming event" },
  { value: "custom", label: "Custom Email", description: "Write a custom message" },
];

const abstractEmailTypes: EmailTypeOption[] = [
  { value: "abstract-accepted", label: "Abstract Accepted", description: "Notify that abstract has been accepted" },
  { value: "abstract-rejected", label: "Abstract Rejected", description: "Notify that abstract has been rejected" },
  { value: "abstract-revision", label: "Revision Requested", description: "Request revisions to abstract" },
  { value: "abstract-reminder", label: "Submission Reminder", description: "Remind to submit or revise abstract" },
  { value: "custom", label: "Custom Email", description: "Write a custom message" },
];

function getEmailTypes(recipientType: RecipientType): EmailTypeOption[] {
  switch (recipientType) {
    case "speakers": return speakerEmailTypes;
    case "reviewers": return reviewerEmailTypes;
    case "registrations": return registrationEmailTypes;
    case "abstracts": return abstractEmailTypes;
  }
}

function getDefaultEmailType(recipientType: RecipientType): string {
  switch (recipientType) {
    case "speakers": return "invitation";
    case "reviewers": return "custom";
    case "registrations": return "confirmation";
    case "abstracts": return "custom";
  }
}

function getRecipientLabel(recipientType: RecipientType): string {
  switch (recipientType) {
    case "speakers": return "speakers";
    case "reviewers": return "reviewers";
    case "registrations": return "registrations";
    case "abstracts": return "abstract submitters";
  }
}

const MIN_LEAD_MS = 5 * 60 * 1000;

function computeMinScheduledFor(): string {
  const d = new Date(Date.now() + MIN_LEAD_MS);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function isAtLeastMinLeadTime(when: Date): boolean {
  return when.getTime() >= Date.now() + MIN_LEAD_MS;
}

const MAX_ATTACHMENT_SIZE = 10 * 1024 * 1024; // 10MB total
const MAX_FILES = 5;

// Static map: emailType → template slug used by the preview endpoint.
// Speaker invitations use a dedicated template; other types reuse common slugs.
function emailTypeToSlug(emailType: string, recipientType: RecipientType): string | null {
  switch (emailType) {
    case "invitation":
      return recipientType === "speakers" ? "speaker-invitation" : "custom-notification";
    case "agreement":
      return "speaker-agreement";
    case "confirmation":
      return "registration-confirmation";
    case "reminder":
      return "event-reminder";
    case "custom":
      return "custom-notification";
    case "abstract-accepted":
    case "abstract-rejected":
    case "abstract-revision":
      return "abstract-status-update";
    case "abstract-reminder":
      return "abstract-submission-confirmation";
    default:
      return null;
  }
}

export function BulkEmailDialog({
  open,
  onOpenChange,
  eventId,
  recipientType,
  recipientIds,
  recipientCount,
  selectionMode,
  statusFilter,
  ticketTypeFilter,
}: BulkEmailDialogProps) {
  const [emailType, setEmailType] = useState<string>(getDefaultEmailType(recipientType));
  const [customSubject, setCustomSubject] = useState("");
  const [customMessage, setCustomMessage] = useState("");
  const [attachments, setAttachments] = useState<Array<{ name: string; content: string; contentType?: string; size: number }>>([]);
  const [sendMode, setSendMode] = useState<"now" | "later">("now");
  const [scheduledFor, setScheduledFor] = useState<string>("");
  const fileInputRef = useRef<HTMLInputElement>(null);

  const bulkEmail = useBulkEmail(eventId);
  const scheduleEmail = useScheduleBulkEmail(eventId);
  const previewMutation = usePreviewEmailBySlug(eventId);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [previewData, setPreviewData] = useState<{ subject: string; htmlContent: string } | null>(null);

  // Computed once on mount; server-side validation re-checks at submit time.
  const [minScheduledFor] = useState(() => computeMinScheduledFor());

  const emailTypes = getEmailTypes(recipientType);
  const isCustom = emailType === "custom";
  const label = getRecipientLabel(recipientType);

  const totalAttachmentSize = attachments.reduce((sum, a) => sum + a.size, 0);

  const handleFileAdd = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files?.length) return;

    const remaining = MAX_FILES - attachments.length;
    const filesToAdd = Array.from(files).slice(0, remaining);

    for (const file of filesToAdd) {
      const newTotal = totalAttachmentSize + file.size;
      if (newTotal > MAX_ATTACHMENT_SIZE) {
        toast.error("Total attachment size exceeds 10MB limit");
        break;
      }

      const base64 = await new Promise<string | null>((resolve) => {
        const reader = new FileReader();
        reader.onload = () => {
          const result = reader.result as string;
          resolve(result.split(",")[1] ?? null); // strip data:...;base64, prefix
        };
        reader.onerror = () => {
          toast.error(`Failed to read ${file.name}`);
          resolve(null);
        };
        reader.readAsDataURL(file);
      });

      if (!base64) continue;

      setAttachments((prev) => [
        ...prev,
        { name: file.name, content: base64, contentType: file.type || undefined, size: file.size },
      ]);
    }

    // Reset input so the same file can be re-added
    e.target.value = "";
  };

  const removeAttachment = (index: number) => {
    setAttachments((prev) => prev.filter((_, i) => i !== index));
  };

  const handlePreview = async () => {
    const slug = emailTypeToSlug(emailType, recipientType);
    if (!slug) return;
    try {
      const result = await previewMutation.mutateAsync({
        slug,
        customSubject: isCustom ? customSubject.trim() || undefined : undefined,
        customMessage: isCustom ? customMessage.trim() || undefined : undefined,
      });
      setPreviewData(result);
      setPreviewOpen(true);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to generate preview");
    }
  };

  const handleSend = async () => {
    if (isCustom && (!customSubject.trim() || !customMessage.trim())) {
      toast.error("Please provide both subject and message for custom emails");
      return;
    }

    if (sendMode === "later") {
      if (!scheduledFor) {
        toast.error("Please pick a date and time to schedule the email");
        return;
      }
      const when = new Date(scheduledFor);
      if (!isAtLeastMinLeadTime(when)) {
        toast.error("Scheduled time must be at least 5 minutes in the future");
        return;
      }
    }

    const payload = {
      recipientType,
      recipientIds: selectionMode === "selected" ? recipientIds : undefined,
      emailType,
      customSubject: isCustom ? customSubject.trim() : undefined,
      customMessage: isCustom
        ? customMessage.trim()
        : emailType === "invitation"
        ? customMessage.trim() || undefined
        : undefined,
      attachments:
        attachments.length > 0
          ? attachments.map(({ name, content, contentType }) => ({ name, content, contentType }))
          : undefined,
      filters: {
        ...(statusFilter && statusFilter !== "all" ? { status: statusFilter } : {}),
        ...(ticketTypeFilter && ticketTypeFilter !== "all" ? { ticketTypeId: ticketTypeFilter } : {}),
      },
    };

    try {
      if (sendMode === "later") {
        const when = new Date(scheduledFor);
        await scheduleEmail.mutateAsync({
          ...payload,
          scheduledFor: when.toISOString(),
        });
        toast.success(`Scheduled for ${when.toLocaleString()}`);
        onOpenChange(false);
        resetForm();
      } else {
        const result = await bulkEmail.mutateAsync({
          ...payload,
          emailType: payload.emailType as "invitation" | "agreement" | "confirmation" | "reminder" | "custom",
        });
        if (result.success) {
          toast.success(result.message);
          onOpenChange(false);
          resetForm();
        }
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to send emails");
    }
  };

  const resetForm = () => {
    setEmailType(getDefaultEmailType(recipientType));
    setCustomSubject("");
    setCustomMessage("");
    setAttachments([]);
    setSendMode("now");
    setScheduledFor("");
  };

  const handleOpenChange = (newOpen: boolean) => {
    if (!newOpen) resetForm();
    onOpenChange(newOpen);
  };

  return (
    <>
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-[525px]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Mail className="h-5 w-5" />
            Send Bulk Email
          </DialogTitle>
          <DialogDescription>
            {selectionMode === "all"
              ? `Send to all ${recipientCount} ${label}`
              : `Send to ${recipientCount} selected ${recipientCount === 1 ? label.slice(0, -1) : label}`}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-2">
          {/* Email Type Selection */}
          <div className="space-y-2">
            <Label>Email Type</Label>
            <Select value={emailType} onValueChange={setEmailType}>
              <SelectTrigger>
                <SelectValue placeholder="Select email type" />
              </SelectTrigger>
              <SelectContent>
                {emailTypes.map((type) => (
                  <SelectItem key={type.value} value={type.value}>
                    <div>
                      <div className="font-medium">{type.label}</div>
                      <div className="text-xs text-muted-foreground">{type.description}</div>
                    </div>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {/* Custom Subject (for custom emails) */}
          {isCustom && (
            <div className="space-y-2">
              <Label htmlFor="bulk-subject">Subject</Label>
              <Input
                id="bulk-subject"
                placeholder="Email subject..."
                value={customSubject}
                onChange={(e) => setCustomSubject(e.target.value)}
                maxLength={500}
              />
            </div>
          )}

          {/* Message field (custom emails require it, invitation allows optional personal message) */}
          {(isCustom || emailType === "invitation") && (
            <div className="space-y-2">
              <Label htmlFor="bulk-message">
                {isCustom ? "Message" : "Personal Message (optional)"}
              </Label>
              <Textarea
                id="bulk-message"
                placeholder={isCustom ? "Write your email message..." : "Add a personal note to the invitation..."}
                value={customMessage}
                onChange={(e) => setCustomMessage(e.target.value)}
                rows={6}
                maxLength={10000}
              />
              <p className="text-xs text-muted-foreground text-right">
                {customMessage.length}/10000
              </p>
            </div>
          )}

          {/* Info box for template emails */}
          {!isCustom && emailType !== "invitation" && (
            <div className="rounded-md bg-muted/50 p-3 text-sm text-muted-foreground">
              {emailType === "agreement" && (
                <p>This will send the speaker agreement template with event details and terms.</p>
              )}
              {emailType === "confirmation" && (
                <p>This will send registration confirmation emails with event details and ticket information.</p>
              )}
              {emailType === "reminder" && (
                <p>This will send an event reminder with venue details and a countdown to the event date.</p>
              )}
            </div>
          )}

          {/* File Attachments */}
          <div className="space-y-2">
            <Label>Attachments</Label>
            <input
              ref={fileInputRef}
              type="file"
              multiple
              className="hidden"
              aria-label="Upload file attachments"
              onChange={handleFileAdd}
            />
            {attachments.length > 0 && (
              <div className="space-y-1">
                {attachments.map((file, index) => (
                  <div key={index} className="flex items-center justify-between rounded-md border px-3 py-1.5 text-sm">
                    <div className="flex items-center gap-2 min-w-0">
                      <Paperclip className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                      <span className="truncate">{file.name}</span>
                      <span className="shrink-0 text-xs text-muted-foreground">
                        {(file.size / 1024).toFixed(0)}KB
                      </span>
                    </div>
                    <button
                      type="button"
                      onClick={() => removeAttachment(index)}
                      aria-label={`Remove ${file.name}`}
                      className="ml-2 shrink-0 text-muted-foreground hover:text-foreground"
                    >
                      <X className="h-3.5 w-3.5" />
                    </button>
                  </div>
                ))}
              </div>
            )}
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => fileInputRef.current?.click()}
              disabled={attachments.length >= MAX_FILES}
            >
              <Paperclip className="mr-2 h-4 w-4" />
              {attachments.length === 0 ? "Add Attachments" : "Add More"}
            </Button>
            <p className="text-xs text-muted-foreground">
              Max {MAX_FILES} files, 10MB total
              {totalAttachmentSize > 0 && ` · ${(totalAttachmentSize / (1024 * 1024)).toFixed(1)}MB used`}
            </p>
          </div>

          {/* Recipient summary */}
          <div className="rounded-md border p-3 text-sm">
            <p className="font-medium">
              {recipientCount} {recipientCount === 1 ? "recipient" : "recipients"}
            </p>
            {statusFilter && statusFilter !== "all" && (
              <p className="text-muted-foreground">Filtered by status: {statusFilter}</p>
            )}
          </div>

          {/* Send mode toggle */}
          <div className="space-y-2">
            <Label>Delivery</Label>
            <div className="grid grid-cols-2 gap-2">
              <button
                type="button"
                onClick={() => setSendMode("now")}
                className={`flex items-center justify-center gap-2 rounded-md border p-2 text-sm font-medium transition-colors ${
                  sendMode === "now"
                    ? "border-primary bg-primary/10 text-primary"
                    : "border-input hover:bg-accent"
                }`}
              >
                <Send className="h-4 w-4" />
                Send now
              </button>
              <button
                type="button"
                onClick={() => setSendMode("later")}
                className={`flex items-center justify-center gap-2 rounded-md border p-2 text-sm font-medium transition-colors ${
                  sendMode === "later"
                    ? "border-primary bg-primary/10 text-primary"
                    : "border-input hover:bg-accent"
                }`}
              >
                <Calendar className="h-4 w-4" />
                Schedule for later
              </button>
            </div>
            {sendMode === "later" && (
              <div className="space-y-1">
                <Input
                  type="datetime-local"
                  value={scheduledFor}
                  min={minScheduledFor}
                  onChange={(e) => setScheduledFor(e.target.value)}
                  aria-label="Scheduled send time"
                />
                <p className="text-xs text-muted-foreground">
                  Recipients are re-evaluated at send time so this list will reflect the latest data.
                </p>
              </div>
            )}
          </div>
        </div>

        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => handleOpenChange(false)}
            disabled={bulkEmail.isPending || scheduleEmail.isPending}
          >
            Cancel
          </Button>
          <Button
            variant="outline"
            onClick={handlePreview}
            disabled={previewMutation.isPending || bulkEmail.isPending || scheduleEmail.isPending}
          >
            {previewMutation.isPending ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : (
              <Eye className="mr-2 h-4 w-4" />
            )}
            Preview
          </Button>
          <Button onClick={handleSend} disabled={bulkEmail.isPending || scheduleEmail.isPending}>
            {bulkEmail.isPending || scheduleEmail.isPending ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                {sendMode === "later" ? "Scheduling..." : "Sending..."}
              </>
            ) : sendMode === "later" ? (
              <>
                <Calendar className="mr-2 h-4 w-4" />
                Schedule Email
              </>
            ) : (
              <>
                <Send className="mr-2 h-4 w-4" />
                Send Emails
              </>
            )}
          </Button>
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
    </>
  );
}
