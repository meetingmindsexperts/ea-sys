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
import { Checkbox } from "@/components/ui/checkbox";
import { TagInput } from "@/components/ui/tag-input";
import {
  useBulkEmail,
  useEmailTemplates,
  usePreviewEmailBySlug,
  useScheduleBulkEmail,
  useTickets,
  useEventTags,
} from "@/hooks/use-api";
import { EmailPreviewDialog } from "@/components/email-preview-dialog";
import { isCustomTemplateSlug } from "@/lib/email-template-slugs";
import {
  PAYMENT_STATUS_DISPLAY_ORDER,
  PAYMENT_STATUS_LABELS,
} from "@/app/(dashboard)/events/[eventId]/registrations/registration-enums";

/** Prefix marking a Select value as a saved custom template (value = `template:<slug>`). */
const SAVED_TEMPLATE_PREFIX = "template:";

/**
 * Effective filter set the dialog asks a page to count against (live recipient
 * count). Mirrors the backend `where` dimensions. `paymentStatus` may be a
 * comma-separated list (multi-value, e.g. the Welcome-Paid tile).
 */
export interface BulkEmailEffectiveFilters {
  status?: string;
  paymentStatus?: string;
  ticketTypeId?: string;
  /** Registrations recipient only — multi ticket-type filter (ANY of). */
  ticketTypeIds?: string[];
  /** Registrations recipient only — registrations with ANY of these badge types. */
  badgeTypes?: string[];
  /** Registrations recipient only — attendees with ANY of these tags. */
  tags?: string[];
  agreementSigned?: string;
  hasSession?: string;
  sessionRole?: string;
}

/** Render a payment-filter value (single status, comma-list, or "all") as a label. */
function formatPaymentLabel(value: string): string {
  if (!value || value === "all") return "All payment statuses";
  return value
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((p) => PAYMENT_STATUS_LABELS[p as keyof typeof PAYMENT_STATUS_LABELS] ?? p)
    .join(" / ");
}

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
  /**
   * Optional `PaymentStatus` filter — registrations recipient only.
   * Closes W2-F4 (unpaid-chase workflow). Caller passes through from
   * the registrations list filter bar.
   */
  paymentStatusFilter?: string;
  ticketTypeFilter?: string;
  /**
   * Registrations recipient only — pass-through filters (the Communications
   * page Advanced-filters block provides the controls; the dialog carries
   * them into the send payload + recap + live count, like ticketTypeFilter).
   */
  badgeTypesFilter?: string[];
  tagsFilter?: string[];
  /**
   * Registrations recipient only — the distinct badge-type values available
   * on this event, used to populate the in-dialog Badge type checkbox list.
   * The host page computes it from its loaded registrations.
   */
  badgeOptions?: string[];
  /**
   * Tier-1 speaker filters (speakers recipient only). Passed through to
   * the bulk-email `filters` payload — backend applies them to the
   * Speaker `where`. No in-dialog re-select control for now (consistent
   * with `statusFilter` pass-through pattern).
   */
  agreementSignedFilter?: string;
  hasSessionFilter?: string;
  sessionRoleFilter?: string;
  /**
   * Tile-driven launch: pre-select an email type (e.g. "agreement",
   * "reminder") instead of falling back to the per-recipient default.
   * Only honored on transition from closed → open so a user who picks
   * a different type mid-dialog isn't clobbered. Must be a valid email
   * type for the current recipient (callers ensure this).
   */
  defaultEmailType?: string;
  /**
   * Optional live-count function. Given the dialog's current effective
   * filters (including the in-dialog payment dropdown), returns how many
   * recipients an "all"-mode send would actually reach. When provided, it
   * drives the displayed count so tile-initiated sends and in-dialog filter
   * overrides show the true number (not the page's advanced-filter total).
   * Omit for audiences without row data (abstracts/reviewers) — falls back
   * to `recipientCount`. Not used in "selected" mode.
   */
  recipientCountFor?: (filters: BulkEmailEffectiveFilters) => number;
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
  // Survey invitation — per-recipient token mint + {{surveyLink}}.
  // Body comes from the per-event "Survey Invitation" template
  // (override in Communications → Email Templates) or the cert-
  // neutral system default.
  { value: "survey-invitation", label: "Survey Invitation", description: "Send a unique link to the post-event feedback survey" },
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
  // Saved custom template — the slug is encoded in the option value.
  if (emailType.startsWith(SAVED_TEMPLATE_PREFIX)) {
    return emailType.slice(SAVED_TEMPLATE_PREFIX.length);
  }
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
  paymentStatusFilter,
  ticketTypeFilter,
  badgeTypesFilter,
  tagsFilter,
  badgeOptions,
  agreementSignedFilter,
  hasSessionFilter,
  sessionRoleFilter,
  defaultEmailType,
  recipientCountFor,
}: BulkEmailDialogProps) {
  const [emailType, setEmailType] = useState<string>(
    defaultEmailType ?? getDefaultEmailType(recipientType)
  );
  // W2-F4 — local payment-status filter control. Seed from the prop so
  // pages that already pass a value (e.g. the registrations list payment
  // filter, or an "Email all unpaid" link) render the dropdown
  // pre-selected AND send with that filter applied. Registrations
  // recipient only. Re-seeded on every open below — useState only inits
  // on first mount, but this dialog is mounted once and toggled, so
  // without the re-seed a stale value from the previous open would drive
  // the send (the bug: page filtered to UNPAID, dialog still sent to all).
  const [localPaymentFilter, setLocalPaymentFilter] = useState<string>(paymentStatusFilter ?? "all");
  // Registrations-only in-dialog multi-select filters. Seeded from the host
  // page's current selection on open (same re-seed-on-open pattern as payment).
  const [localTicketTypeIds, setLocalTicketTypeIds] = useState<string[]>(
    ticketTypeFilter && ticketTypeFilter !== "all" ? [ticketTypeFilter] : [],
  );
  const [localBadgeTypes, setLocalBadgeTypes] = useState<string[]>(badgeTypesFilter ?? []);
  const [localTags, setLocalTags] = useState<string[]>(tagsFilter ?? []);
  // Reset emailType + payment filter on the closed → open transition only
  // (so users who change a control mid-dialog don't lose it on a
  // re-render). Uses React's documented "store info from previous render"
  // pattern instead of useEffect+setState (banned by
  // react-hooks/set-state-in-effect under React 19).
  const [prevOpen, setPrevOpen] = useState(open);
  if (open !== prevOpen) {
    setPrevOpen(open);
    if (open) {
      setEmailType(defaultEmailType ?? getDefaultEmailType(recipientType));
      setLocalPaymentFilter(paymentStatusFilter ?? "all");
      setLocalTicketTypeIds(ticketTypeFilter && ticketTypeFilter !== "all" ? [ticketTypeFilter] : []);
      setLocalBadgeTypes(badgeTypesFilter ?? []);
      setLocalTags(tagsFilter ?? []);
    }
  }
  const [customSubject, setCustomSubject] = useState("");
  const [customMessage, setCustomMessage] = useState("");
  const [attachments, setAttachments] = useState<Array<{ name: string; content: string; contentType?: string; size: number }>>([]);
  const [sendMode, setSendMode] = useState<"now" | "later">("now");
  const [scheduledFor, setScheduledFor] = useState<string>("");
  // survey-invitation only — TTL (days) for the minted survey link.
  const [surveyExpiryDays, setSurveyExpiryDays] = useState<string>("7");
  const fileInputRef = useRef<HTMLInputElement>(null);

  const bulkEmail = useBulkEmail(eventId);
  const scheduleEmail = useScheduleBulkEmail(eventId);
  const previewMutation = usePreviewEmailBySlug(eventId);
  // Registrations-only filter option sources. Always called (hooks must be
  // unconditional); only rendered for the registrations recipient type.
  const { data: ticketTypeData } = useTickets(eventId);
  const ticketTypeOptions = ((ticketTypeData ?? []) as Array<{ id: string; name: string }>).map(
    (t) => ({ id: t.id, name: t.name }),
  );
  const eventTagsQuery = useEventTags(eventId);
  const tagSuggestions = (eventTagsQuery.data?.tags ?? []).map((t) => t.tag);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [previewData, setPreviewData] = useState<{ subject: string; htmlContent: string } | null>(null);

  // Computed once on mount; server-side validation re-checks at submit time.
  const [minScheduledFor] = useState(() => computeMinScheduledFor());

  // Active custom templates (organizer-created, not system defaults) become
  // selectable send options — this is the bridge that makes them appear in the
  // dropdown for every recipient type and on the Communications page. Inactive
  // and system templates are excluded (the latter are already covered by the
  // built-in options above).
  const { data: templatesData } = useEmailTemplates(eventId);
  const customTemplates = (
    (templatesData?.templates ?? []) as Array<{ slug: string; name: string; isActive: boolean }>
  ).filter((t) => t.isActive && isCustomTemplateSlug(t.slug));

  const emailTypes: EmailTypeOption[] = [
    ...getEmailTypes(recipientType),
    ...customTemplates.map((t) => ({
      value: `${SAVED_TEMPLATE_PREFIX}${t.slug}`,
      label: t.name,
      description: "Your saved template",
    })),
  ];

  const isSavedTemplate = emailType.startsWith(SAVED_TEMPLATE_PREFIX);
  const savedTemplateSlug = isSavedTemplate
    ? emailType.slice(SAVED_TEMPLATE_PREFIX.length)
    : undefined;
  const savedTemplateName = customTemplates.find(
    (t) => t.slug === savedTemplateSlug
  )?.name;
  const isCustom = emailType === "custom";
  const label = getRecipientLabel(recipientType);

  // Live recipient count. In "all" mode, ask the page to count against the
  // dialog's current effective filters (so tiles + the in-dialog payment
  // override show the true number); fall back to the static prop when no
  // counter is provided. "selected" mode always shows the selected count.
  const isRegistrations = recipientType === "registrations";
  const effectiveFilters: BulkEmailEffectiveFilters = {
    status: statusFilter,
    paymentStatus:
      isRegistrations && localPaymentFilter !== "all" ? localPaymentFilter : undefined,
    ticketTypeIds: isRegistrations && localTicketTypeIds.length ? localTicketTypeIds : undefined,
    badgeTypes: isRegistrations && localBadgeTypes.length ? localBadgeTypes : undefined,
    tags: isRegistrations && localTags.length ? localTags : undefined,
    agreementSigned: agreementSignedFilter,
    hasSession: hasSessionFilter,
    sessionRole: sessionRoleFilter,
  };
  const displayCount =
    selectionMode === "selected"
      ? recipientCount
      : recipientCountFor
        ? recipientCountFor(effectiveFilters)
        : recipientCount;

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
      // A saved custom template sends as emailType "template" with the slug
      // carried in filters.templateSlug (so it survives schedule → worker).
      emailType: isSavedTemplate ? "template" : emailType,
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
        // W2-F4 — local Select drives the value; falls back to the prop
        // when the consumer pre-seeds it. Only meaningful for the
        // registrations recipient type.
        ...(recipientType === "registrations" && localPaymentFilter && localPaymentFilter !== "all"
          ? { paymentStatus: localPaymentFilter }
          : {}),
        // Registrations recipient only — ticket type / badge / tags, all
        // multi-select, driven by the in-dialog controls (seeded from the page).
        ...(recipientType === "registrations" && localTicketTypeIds.length > 0
          ? { ticketTypeIds: localTicketTypeIds }
          : {}),
        ...(recipientType === "registrations" && localBadgeTypes.length > 0
          ? { badgeTypes: localBadgeTypes }
          : {}),
        ...(recipientType === "registrations" && localTags.length > 0
          ? { tagsInclude: localTags }
          : {}),
        // Tier-1 speaker filters (speakers recipient only).
        ...(recipientType === "speakers" && agreementSignedFilter && agreementSignedFilter !== "all"
          ? { agreementSigned: agreementSignedFilter }
          : {}),
        ...(recipientType === "speakers" && hasSessionFilter && hasSessionFilter !== "all"
          ? { hasSession: hasSessionFilter }
          : {}),
        ...(recipientType === "speakers" && sessionRoleFilter && sessionRoleFilter !== "all"
          ? { sessionRole: sessionRoleFilter }
          : {}),
        // survey-invitation only — TTL (days) for the minted survey link.
        ...(emailType === "survey-invitation"
          ? { surveyExpiryDays: Number(surveyExpiryDays) }
          : {}),
        // Saved custom template — slug rides in filters so scheduled sends
        // reconstruct it from the persisted ScheduledEmail.filters JSON.
        ...(isSavedTemplate && savedTemplateSlug ? { templateSlug: savedTemplateSlug } : {}),
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
          emailType: payload.emailType as "invitation" | "agreement" | "confirmation" | "reminder" | "custom" | "template" | "survey-invitation",
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
              ? `Send to all ${displayCount} ${label}`
              : `Send to ${displayCount} selected ${displayCount === 1 ? label.slice(0, -1) : label}`}
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
              {isSavedTemplate && (
                <p>
                  This will send your saved{savedTemplateName ? ` “${savedTemplateName}”` : ""} template,
                  rendered with this event&apos;s details and branding for each recipient.
                </p>
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

          {/* W2-F4 — payment-status filter (registrations only). Lets the
              organizer narrow the audience to e.g. UNPAID for the
              "email all unpaid" workflow without leaving the dialog. */}
          {recipientType === "registrations" && (
            <div className="space-y-2">
              <Label htmlFor="bulk-email-payment-status">Payment status</Label>
              <Select value={localPaymentFilter} onValueChange={setLocalPaymentFilter}>
                <SelectTrigger id="bulk-email-payment-status" aria-label="Payment status">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All payment statuses</SelectItem>
                  {/* Synthetic option for a multi-value filter (e.g. the
                      Welcome-Paid tile sends PAID,COMPLIMENTARY,INCLUSIVE).
                      Without it the trigger would render blank. Picking any
                      single status below overrides it. */}
                  {localPaymentFilter.includes(",") && (
                    <SelectItem value={localPaymentFilter}>
                      {formatPaymentLabel(localPaymentFilter)}
                    </SelectItem>
                  )}
                  {PAYMENT_STATUS_DISPLAY_ORDER.map((s) => (
                    <SelectItem key={s} value={s}>
                      {PAYMENT_STATUS_LABELS[s]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">
                Combine with status filter to target e.g. CONFIRMED + UNPAID.
              </p>
            </div>
          )}

          {/* Registration type — multi-select (checkbox). Empty = all types. */}
          {recipientType === "registrations" && ticketTypeOptions.length > 0 && (
            <div className="space-y-2">
              <Label>Registration type</Label>
              <div className="max-h-32 space-y-1.5 overflow-y-auto rounded-md border p-2.5">
                {ticketTypeOptions.map((tt) => (
                  <label key={tt.id} className="flex cursor-pointer items-center gap-2 text-sm">
                    <Checkbox
                      checked={localTicketTypeIds.includes(tt.id)}
                      onCheckedChange={(c) =>
                        setLocalTicketTypeIds((prev) =>
                          c === true ? [...prev, tt.id] : prev.filter((id) => id !== tt.id),
                        )
                      }
                    />
                    <span>{tt.name}</span>
                  </label>
                ))}
              </div>
              <p className="text-xs text-muted-foreground">
                Leave all unchecked to include every registration type.
              </p>
            </div>
          )}

          {/* Badge type — multi-select (checkbox). Empty = all badges. */}
          {recipientType === "registrations" && badgeOptions && badgeOptions.length > 0 && (
            <div className="space-y-2">
              <Label>Badge type</Label>
              <div className="max-h-32 space-y-1.5 overflow-y-auto rounded-md border p-2.5">
                {badgeOptions.map((b) => (
                  <label key={b} className="flex cursor-pointer items-center gap-2 text-sm">
                    <Checkbox
                      checked={localBadgeTypes.includes(b)}
                      onCheckedChange={(c) =>
                        setLocalBadgeTypes((prev) =>
                          c === true ? [...prev, b] : prev.filter((x) => x !== b),
                        )
                      }
                    />
                    <span>{b}</span>
                  </label>
                ))}
              </div>
            </div>
          )}

          {/* Tags — any of (multi). Empty = no tag filter. */}
          {recipientType === "registrations" && (
            <div className="space-y-2">
              <Label>Tags (any of)</Label>
              <TagInput
                value={localTags}
                onChange={setLocalTags}
                suggestions={tagSuggestions}
                placeholder="Filter by tag(s)…"
              />
            </div>
          )}

          {/* survey-invitation only — link expiry (days). Mirrors the
              dashboard shareable-link expiry control; default 7. */}
          {emailType === "survey-invitation" && (
            <div className="space-y-2">
              <Label htmlFor="bulk-email-survey-expiry">Survey link expires in</Label>
              <Select value={surveyExpiryDays} onValueChange={setSurveyExpiryDays}>
                <SelectTrigger id="bulk-email-survey-expiry" aria-label="Survey link expiry">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="3">3 days</SelectItem>
                  <SelectItem value="5">5 days</SelectItem>
                  <SelectItem value="7">7 days</SelectItem>
                  <SelectItem value="10">10 days</SelectItem>
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">
                Each recipient gets a unique link that stops working after this many days.
              </p>
            </div>
          )}

          {/* Recipient summary */}
          <div className="rounded-md border p-3 text-sm">
            <p className="font-medium">
              {displayCount} {displayCount === 1 ? "recipient" : "recipients"}
            </p>
            {statusFilter && statusFilter !== "all" && (
              <p className="text-muted-foreground">Filtered by status: {statusFilter}</p>
            )}
            {recipientType === "registrations" && localPaymentFilter && localPaymentFilter !== "all" && (
              <p className="text-muted-foreground">Filtered by payment: {formatPaymentLabel(localPaymentFilter)}</p>
            )}
            {recipientType === "registrations" && localTicketTypeIds.length > 0 && (
              <p className="text-muted-foreground">
                Filtered by type:{" "}
                {localTicketTypeIds
                  .map((id) => ticketTypeOptions.find((t) => t.id === id)?.name ?? id)
                  .join(", ")}
              </p>
            )}
            {recipientType === "registrations" && localBadgeTypes.length > 0 && (
              <p className="text-muted-foreground">Filtered by badge: {localBadgeTypes.join(", ")}</p>
            )}
            {recipientType === "registrations" && localTags.length > 0 && (
              <p className="text-muted-foreground">Filtered by tags: {localTags.join(", ")}</p>
            )}
            {recipientType === "speakers" && agreementSignedFilter && agreementSignedFilter !== "all" && (
              <p className="text-muted-foreground">Filtered by agreement: {agreementSignedFilter}</p>
            )}
            {recipientType === "speakers" && hasSessionFilter && hasSessionFilter !== "all" && (
              <p className="text-muted-foreground">
                Filtered by sessions: {hasSessionFilter === "yes" ? "Has session" : "No session"}
              </p>
            )}
            {recipientType === "speakers" && sessionRoleFilter && sessionRoleFilter !== "all" && (
              <p className="text-muted-foreground">Filtered by session role: {sessionRoleFilter}</p>
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
