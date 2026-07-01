"use client";

import Image from "next/image";
import { useState, useRef } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { SpecialtySelect } from "@/components/ui/specialty-select";
import { TitleSelect } from "@/components/ui/title-select";
import { TagInput } from "@/components/ui/tag-input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from "@/components/ui/sheet";
import { CountrySelect } from "@/components/ui/country-select";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Mail,
  Phone,
  Building,
  Briefcase,
  ClipboardList,
  Barcode,
  CheckCircle,
  CheckSquare,
  Square,
  Calendar,
  CreditCard,
  Utensils,
  Hotel,
  Send,
  Trash2,
  Pencil,
  Save,
  X,
  MapPin,
  ChevronDown,
  Download,
  IdCard,
  Loader2,
  Eye,
  User,
  Ticket,
  Receipt,
  Radar,
  StickyNote,
} from "lucide-react";
import { cn, formatCurrency, formatDate, formatDateTime, formatPersonName } from "@/lib/utils";
import { formatSerialId } from "@/lib/registration-serial";
import { canViewFinance } from "@/lib/finance-visibility";
import { queryKeys, useTickets, usePreviewEmailBySlug, useSponsors, useBillingAccounts, useSendCompletionEmails, useEventTags, useEmailTemplates, useEvent } from "@/hooks/use-api";
import { isCustomTemplateSlug } from "@/lib/email-template-slugs";

/** Prefix marking a dropdown value as a saved custom template (value = `template:<slug>`). */
const SAVED_TEMPLATE_PREFIX = "template:";
import { EmailPreviewDialog } from "@/components/email-preview-dialog";
import { ChangeEmailDialog } from "@/components/change-email-dialog";
import { InvoiceDownloadButtons } from "@/components/invoices/invoice-download-buttons";
import { RecordPaymentDialog } from "@/components/payments/record-payment-dialog";
import { ActivityTimelineCard } from "@/components/activity/activity-timeline-card";
import { IssuedCertificatesCard } from "@/components/certificates/issued-certificates-card";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useSession } from "next-auth/react";
import { toast } from "sonner";
import type { Registration, TicketType } from "./types";
import { displayRegistrationType } from "@/lib/faculty-filter";
import { hasCustomBilling } from "./types";
import {
  EMPTY_REGISTRATION_EDIT_DATA,
  toEditData,
  toServerPayload,
} from "./registration-edit-mapping";
import {
  ApiError,
  apiDelete,
  apiFetch,
  apiPostJson,
  apiPutJson,
} from "@/lib/api-fetch";
import {
  PAYMENT_STATUS_COLORS,
  PAYMENT_STATUS_DISPLAY_ORDER,
  PAYMENT_STATUS_LABELS,
  REGISTRATION_STATUS_COLORS,
  REGISTRATION_STATUS_DISPLAY_ORDER,
  REGISTRATION_STATUS_LABELS,
} from "./registration-enums";

const EMAIL_TYPE_LABELS: Record<string, string> = {
  confirmation: "Registration Confirmation",
  reminder: "Event Reminder",
  "payment-reminder": "Payment Reminder",
  custom: "Custom Notification",
};

const EMAIL_TYPE_TO_SLUG: Record<string, string> = {
  confirmation: "registration-confirmation",
  reminder: "event-reminder",
  "payment-reminder": "payment-reminder",
  custom: "custom-notification",
};

interface RegistrationDetailSheetProps {
  eventId: string;
  registration: Registration | null;
  /**
   * Dubai (DET/DTCM) compliance flag from the parent event. When false the
   * DTCM barcode field is hidden entirely — DTCM only applies to Dubai
   * events, so non-Dubai events shouldn't show the field at all.
   */
  requiresDtcmBarcode?: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/**
 * Human-readable label for the RegistrationCreatedSource enum. The
 * column is NULL on rows that pre-date this feature — we render
 * "Unknown" (handled by the null-check at the call site, not here).
 */
function formatCreatedSource(source: string): string {
  switch (source) {
    case "PUBLIC_REGISTER":
      return "Public registration form";
    case "PUBLIC_SUBMITTER":
      return "Abstract submitter sign-up";
    case "PUBLIC_COMPLETION_FORM":
      return "Completion form";
    case "ADMIN_DASHBOARD":
      return "Admin dashboard";
    case "CSV_IMPORT":
      return "CSV import";
    case "MCP_AGENT":
      return "AI agent (MCP)";
    case "OTHER":
      return "Other";
    default:
      // Future-proof: a new enum value we haven't shipped a label for
      // still renders as-is so the operator sees SOMETHING.
      return source;
  }
}

export function RegistrationDetailSheet({
  eventId,
  registration,
  requiresDtcmBarcode = false,
  open,
  onOpenChange,
}: RegistrationDetailSheetProps) {
  const queryClient = useQueryClient();
  const { data: userSession } = useSession();
  const isReviewer = userSession?.user?.role === "REVIEWER";
  // ONSITE + MEMBER are registration-desk operators: they can edit, check in,
  // record payment, and print badges — but NOT delete or email a registration
  // (those stay admin/organizer; the API enforces it too).
  const isOnsite = userSession?.user?.role === "ONSITE";
  const isMember = userSession?.user?.role === "MEMBER";
  const isDeskOperator = isOnsite || isMember;
  // ONSITE + MEMBER now SEE money (they record payments) — canViewFinance
  // includes them, so the Billing tab + Payment Summary + amounts show.
  const showFinance = canViewFinance(userSession?.user?.role);
  const { data: regTypes = [] } = useTickets(eventId);
  // Active custom email templates — added as "Send Email" dropdown options so a
  // single registration can be sent a saved template, not just the built-ins.
  const { data: emailTemplatesData } = useEmailTemplates(eventId);
  const customTemplates = (
    (emailTemplatesData?.templates ?? []) as Array<{ slug: string; name: string; isActive: boolean }>
  ).filter((t) => t.isActive && isCustomTemplateSlug(t.slug));
  // Sponsor list — used by the INCLUSIVE picker below + the "Sponsored by:"
  // display in the Payment Summary. Cheap query, cached at the event level.
  const { data: sponsorsRes } = useSponsors(eventId);
  // Per-event scoped payer list — only payers attached to THIS event via
  // the EventBillingAccount junction. Mirrors the picker on the Add
  // Registration form so reassignment can't pick a payer that wasn't
  // authorized for this event. Manage attachments in Settings → Billing.
  const { data: billingAccounts = [] } = useBillingAccounts({ eventId });
  const sponsors = sponsorsRes?.sponsors ?? [];
  const sponsorById = (id: string | null) =>
    id ? sponsors.find((s) => s.id === id) ?? null : null;
  const [selectedRegistration, setSelectedRegistration] = useState<Registration | null>(registration);
  const [isEditing, setIsEditing] = useState(false);
  const [printingBadge, setPrintingBadge] = useState(false);
  const [promoCodeInput, setPromoCodeInput] = useState("");
  const [promoBusy, setPromoBusy] = useState(false);
  const [activeTab, setActiveTab] = useState<"details" | "billing" | "activity">("details");
  const headerPhotoRef = useRef<HTMLInputElement>(null);

  const handleHeaderPhotoChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (file.size > 500 * 1024) { toast.error("File size must be under 500KB"); return; }
    if (!["image/jpeg", "image/png", "image/webp"].includes(file.type)) { toast.error("Only JPEG, PNG, and WebP allowed"); return; }
    const formData = new FormData();
    formData.append("file", file);
    try {
      const res = await fetch("/api/upload/photo", { method: "POST", body: formData });
      const data = await res.json();
      if (!res.ok) { toast.error(data.error || "Upload failed"); return; }
      setEditData((prev) => ({ ...prev, photo: data.url }));
      toast.success("Photo uploaded");
    } catch { toast.error("Upload failed"); }
    if (headerPhotoRef.current) headerPhotoRef.current.value = "";
  };
  // editData shape + the populate/payload mappers live in
  // ./registration-edit-mapping.ts — extracted so the same field list
  // doesn't appear three times in this file (defaults / populate /
  // server payload) and so the field-by-field normalization can be
  // unit-tested in isolation.
  const [editData, setEditData] = useState(EMPTY_REGISTRATION_EDIT_DATA);

  // Sync local state when the parent passes a different registration.
  // React 19's "Storing information from previous renders" pattern: the
  // guard compares the incoming prop to a previous-PROP snapshot kept
  // in state (not to derived state), so we only sync when the prop
  // actually changes. The prior `registration !== selectedRegistration`
  // guard had two problems: (1) it tripped React 19's StrictMode
  // setState-during-render warning because the comparison wasn't
  // against a prev-state snapshot, and (2) after a mutation's
  // onSuccess updated selectedRegistration to the fresh server row,
  // selectedRegistration diverged from the stale prop and this branch
  // would silently revert the just-saved data on the next render.
  //
  // The `!== null` guard is kept so closing the sheet (parent passes
  // null) doesn't blank the visible content mid-close animation.
  const [prevRegistration, setPrevRegistration] = useState<Registration | null>(registration);
  if (registration !== prevRegistration) {
    setPrevRegistration(registration);
    if (registration !== null) {
      setSelectedRegistration(registration);
      setIsEditing(false);
    }
  }

  const updateRegistration = useMutation({
    // STALE_WRITE branching lives in onError below — the ApiError thrown
    // by apiPutJson carries the status + code so the conditional refetch
    // path still works without the per-mutation try/catch boilerplate.
    mutationFn: ({ id, data }: { id: string; data: Record<string, unknown> }) =>
      apiPutJson<Registration>(`/api/events/${eventId}/registrations/${id}`, data),
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.registrations(eventId) });
      setSelectedRegistration(data);
      toast.success("Registration updated");
    },
    onError: (error: Error) => {
      if (error instanceof ApiError && error.status === 409 && error.code === "STALE_WRITE") {
        toast.error(
          "This registration was modified by someone else after you opened it. Reloading the latest version — please review and re-save your changes.",
        );
        queryClient.invalidateQueries({ queryKey: queryKeys.registrations(eventId) });
        setIsEditing(false);
        return;
      }
      toast.error(error.message);
    },
  });

  // Promo code apply/remove (organizer). The endpoint returns the discount
  // financials; we re-fetch the full detail (with recomputed `financials`) so
  // the Payment Summary + quote reflect it, then refresh the list.
  async function refreshSelectedRegistration(id: string) {
    const fresh = await apiFetch<Registration>(`/api/events/${eventId}/registrations/${id}`);
    setSelectedRegistration(fresh);
    queryClient.invalidateQueries({ queryKey: queryKeys.registrations(eventId) });
  }

  async function applyPromoCode() {
    const code = promoCodeInput.trim();
    if (!code || !selectedRegistration) return;
    setPromoBusy(true);
    try {
      await apiPostJson(`/api/events/${eventId}/registrations/${selectedRegistration.id}/promo`, { code });
      await refreshSelectedRegistration(selectedRegistration.id);
      setPromoCodeInput("");
      toast.success("Promo code applied");
    } catch (error) {
      toast.error(error instanceof ApiError ? error.message : "Couldn't apply promo code");
    } finally {
      setPromoBusy(false);
    }
  }

  async function removePromoCode() {
    if (!selectedRegistration) return;
    setPromoBusy(true);
    try {
      await apiDelete(`/api/events/${eventId}/registrations/${selectedRegistration.id}/promo`);
      await refreshSelectedRegistration(selectedRegistration.id);
      toast.success("Promo code removed");
    } catch (error) {
      toast.error(error instanceof ApiError ? error.message : "Couldn't remove promo code");
    } finally {
      setPromoBusy(false);
    }
  }

  const checkInRegistration = useMutation({
    mutationFn: (id: string) =>
      apiPostJson<Registration>(`/api/events/${eventId}/registrations/${id}/check-in`),
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.registrations(eventId) });
      setSelectedRegistration(data);
      toast.success("Attendee checked in successfully");
    },
    onError: (error: Error) => {
      toast.error(error.message);
    },
  });

  const [emailConfirmOpen, setEmailConfirmOpen] = useState(false);
  const [selectedEmailType, setSelectedEmailType] = useState("");
  const [previewOpen, setPreviewOpen] = useState(false);
  const [previewData, setPreviewData] = useState<{ subject: string; htmlContent: string } | null>(null);
  const [changeEmailOpen, setChangeEmailOpen] = useState(false);
  const [recordPaymentOpen, setRecordPaymentOpen] = useState(false);
  const [sendFormConfirmOpen, setSendFormConfirmOpen] = useState(false);
  const sendCompletionEmails = useSendCompletionEmails(eventId);
  // Existing tags for autocomplete on the in-sheet edit. Cached with
  // bulkTagRegistrations invalidation so adding a tag here makes it
  // immediately appear in the dropdown for other sheets.
  const eventTagsQuery = useEventTags(eventId);
  // For the hybrid attendance-mode toggle (only meaningful on HYBRID events).
  const { data: eventForMode } = useEvent(eventId);
  const isHybridEvent = (eventForMode as { eventType?: string } | undefined)?.eventType === "HYBRID";
  const previewMutation = usePreviewEmailBySlug(eventId);

  const handlePreviewRegistrationEmail = async () => {
    // Saved custom templates preview by their own slug; built-ins map via
    // EMAIL_TYPE_TO_SLUG.
    const slug = selectedEmailType.startsWith(SAVED_TEMPLATE_PREFIX)
      ? selectedEmailType.slice(SAVED_TEMPLATE_PREFIX.length)
      : EMAIL_TYPE_TO_SLUG[selectedEmailType];
    if (!slug) return;
    try {
      const result = await previewMutation.mutateAsync({ slug });
      setPreviewData(result);
      setPreviewOpen(true);
    } catch {
      toast.error("Failed to generate preview");
    }
  };

  // Open the email-confirmation dialog with a specific email type.
  // Four dropdown items used to inline this 2-line state-set pair;
  // collapsing it here also gives the call sites a single name.
  // Human label for the confirm dialog — built-ins map via EMAIL_TYPE_LABELS,
  // a saved custom template ("template:<slug>") resolves to its display name.
  const selectedEmailLabel = selectedEmailType.startsWith(SAVED_TEMPLATE_PREFIX)
    ? customTemplates.find(
        (t) => t.slug === selectedEmailType.slice(SAVED_TEMPLATE_PREFIX.length),
      )?.name ?? "Custom Template"
    : EMAIL_TYPE_LABELS[selectedEmailType];

  const openEmailDialog = (type: string) => {
    setSelectedEmailType(type);
    setEmailConfirmOpen(true);
  };

  // Submit handler for the email-confirmation dialog. Pulled out so the
  // Send button's onClick is a one-liner.
  const handleConfirmSendEmail = () => {
    if (selectedRegistration) {
      // A saved custom template is encoded as "template:<slug>" → send via
      // templateSlug; built-in types send via `type`.
      if (selectedEmailType.startsWith(SAVED_TEMPLATE_PREFIX)) {
        sendEmail.mutate({
          id: selectedRegistration.id,
          templateSlug: selectedEmailType.slice(SAVED_TEMPLATE_PREFIX.length),
        });
      } else {
        sendEmail.mutate({ id: selectedRegistration.id, type: selectedEmailType });
      }
      setEmailConfirmOpen(false);
    }
  };

  // Destructive-action confirmations. Kept simple `window.confirm`
  // (the codebase's house style for one-shot destructive actions);
  // the handler form just lets us name the intent at the call site.
  const handleDeleteClick = () => {
    if (!selectedRegistration) return;
    if (confirm("Are you sure you want to delete this registration?")) {
      deleteRegistration.mutate(selectedRegistration.id);
    }
  };

  const handleRefundClick = () => {
    if (!selectedRegistration) return;
    if (confirm("Issue a full refund via Stripe? This cannot be undone.")) {
      issueRefund.mutate(selectedRegistration.id);
    }
  };

  // Badge print fetches a binary PDF, opens it in a new tab, and triggers
  // print there. Uses raw fetch because the response is a PDF blob — the
  // apiFetch helper expects JSON. Stays inline-style here so the URL
  // revocation timer + window.open lifecycle is obvious in one place.
  const handlePrintBadge = async () => {
    if (!selectedRegistration) return;
    setPrintingBadge(true);
    try {
      const res = await fetch(`/api/events/${eventId}/registrations/badges`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ registrationIds: [selectedRegistration.id] }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        toast.error(data.error || "Badge generation failed");
        return;
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const printWindow = window.open(url);
      if (printWindow) {
        printWindow.addEventListener("load", () => printWindow.print());
      }
      // Allow time for the print dialog to read the blob before we revoke.
      setTimeout(() => URL.revokeObjectURL(url), 60000);
    } catch {
      toast.error("Badge generation failed");
    } finally {
      setPrintingBadge(false);
    }
  };

  const sendEmail = useMutation({
    mutationFn: ({ id, type, templateSlug }: { id: string; type?: string; templateSlug?: string }) =>
      apiPostJson(`/api/events/${eventId}/registrations/${id}/email`, templateSlug ? { templateSlug } : { type }),
    onSuccess: () => {
      toast.success("Email sent");
    },
    onError: (error: Error) => {
      toast.error(error.message);
    },
  });

  const deleteRegistration = useMutation({
    mutationFn: (id: string) =>
      apiDelete(`/api/events/${eventId}/registrations/${id}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.registrations(eventId) });
      onOpenChange(false);
      setSelectedRegistration(null);
      toast.success("Registration deleted");
    },
    onError: (error: Error) => {
      toast.error(error.message);
    },
  });

  const issueRefund = useMutation({
    mutationFn: (id: string) =>
      apiPostJson(`/api/events/${eventId}/registrations/${id}/refund`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.registrations(eventId) });
      setSelectedRegistration((prev) => prev ? { ...prev, paymentStatus: "REFUNDED" } : prev);
      toast.success("Refund issued successfully");
    },
    onError: (error: Error) => {
      toast.error(error.message);
    },
  });

  const startEditing = () => {
    if (selectedRegistration) {
      setEditData(toEditData(selectedRegistration));
      setIsEditing(true);
    }
  };

  const saveEdits = () => {
    if (!selectedRegistration) return;
    updateRegistration.mutate(
      {
        id: selectedRegistration.id,
        // Optimistic-lock token + per-field normalization (null vs
        // undefined, payer-triplet atomicity) all live in
        // toServerPayload — see registration-edit-mapping.ts.
        data: toServerPayload(editData, selectedRegistration.updatedAt),
      },
      {
        // Only exit edit mode on success — keep user input on error so they can retry
        onSuccess: () => setIsEditing(false),
      }
    );
  };

  return (
    <>
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="overflow-y-auto p-0 w-full sm:w-[750px]">
        {selectedRegistration ? (
          <>
            {/* Header with actions */}
            <div className="sticky top-0 z-10 bg-gradient-to-r from-primary to-primary/70 px-6 py-4 text-white">
              <div className="flex items-start justify-between gap-4 pr-8">
                <SheetHeader className="flex-1">
                  <SheetTitle className="text-white text-lg">
                    {formatPersonName(selectedRegistration.attendee.title, selectedRegistration.attendee.firstName, selectedRegistration.attendee.lastName)}
                  </SheetTitle>
                  <SheetDescription asChild>
                    <span className="flex gap-2 mt-1">
                      <Badge className={`${REGISTRATION_STATUS_COLORS[selectedRegistration.status]} border-white/30`} variant="outline">
                        {selectedRegistration.status}
                      </Badge>
                      <Badge className={`${PAYMENT_STATUS_COLORS[selectedRegistration.paymentStatus]} border-white/30`} variant="outline">
                        {selectedRegistration.paymentStatus}
                      </Badge>
                    </span>
                  </SheetDescription>
                </SheetHeader>
                {(() => {
                  const photoSrc = isEditing ? editData.photo : selectedRegistration.attendee.photo;
                  const avatar = photoSrc ? (
                    <Image src={photoSrc} alt="" width={112} height={112} className="w-28 h-28 rounded-full object-cover ring-2 ring-white/40 shrink-0" unoptimized />
                  ) : (
                    <div className="w-28 h-28 rounded-full bg-white/20 flex items-center justify-center text-white font-bold text-2xl shrink-0">
                      {selectedRegistration.attendee.firstName[0]}{selectedRegistration.attendee.lastName[0]}
                    </div>
                  );
                  if (!isEditing) return avatar;
                  return (
                    <div className="shrink-0 flex flex-col items-center">
                      <div className="relative group">
                        <input ref={headerPhotoRef} type="file" accept="image/jpeg,image/png,image/webp" onChange={handleHeaderPhotoChange} className="hidden" aria-label="Upload photo" />
                        <button type="button" title="Change photo" onClick={() => headerPhotoRef.current?.click()} className="block rounded-full cursor-pointer">
                          {avatar}
                          <div className="absolute inset-0 rounded-full bg-black/40 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity">
                            <Pencil className="h-5 w-5 text-white" />
                          </div>
                        </button>
                      </div>
                      {photoSrc && (
                        <button
                          type="button"
                          onClick={() => setEditData((prev) => ({ ...prev, photo: null }))}
                          className="mt-1.5 text-xs text-white/80 hover:text-white flex items-center gap-1"
                        >
                          <X className="h-3 w-3" /> Remove
                        </button>
                      )}
                    </div>
                  );
                })()}
              </div>

              {/* Quick Actions in header */}
              {!isReviewer && (
                <div className="flex flex-wrap gap-2 mt-3">
                  {!isEditing ? (
                    <>
                      <Button size="sm" variant="secondary" onClick={startEditing}>
                        <Pencil className="mr-2 h-4 w-4" />
                        Edit
                      </Button>
                      {selectedRegistration.status !== "CHECKED_IN" &&
                        selectedRegistration.status !== "CANCELLED" && (
                          <Button
                            size="sm"
                            onClick={() => checkInRegistration.mutate(selectedRegistration.id)}
                            disabled={checkInRegistration.isPending}
                            className="bg-green-600 hover:bg-green-700 text-white"
                          >
                            <CheckCircle className="mr-2 h-4 w-4" />
                            Check In
                          </Button>
                        )}
                      {!isDeskOperator && (
                        <Button
                          size="sm"
                          variant="secondary"
                          className="text-red-600 hover:text-red-700"
                          onClick={handleDeleteClick}
                          disabled={deleteRegistration.isPending}
                        >
                          <Trash2 className="mr-2 h-4 w-4" />
                          Delete
                        </Button>
                      )}
                    </>
                  ) : (
                    <>
                      <Button
                        size="sm"
                        onClick={saveEdits}
                        disabled={updateRegistration.isPending}
                        className="bg-green-600 hover:bg-green-700 text-white"
                      >
                        <Save className="mr-2 h-4 w-4" />
                        {updateRegistration.isPending ? "Saving..." : "Save"}
                      </Button>
                      <Button
                        size="sm"
                        variant="secondary"
                        onClick={() => setIsEditing(false)}
                        disabled={updateRegistration.isPending}
                      >
                        <X className="mr-2 h-4 w-4" />
                        Cancel
                      </Button>
                    </>
                  )}
                </div>
              )}
            </div>

            <div className="px-6 py-5 space-y-4 bg-slate-50/40">
              {/* Tab pill bar — shown in view mode only. When editing, all
                  sections collapse to a single flat form so the admin can
                  move through the whole record sequentially without tab
                  switches. */}
              {!isEditing && (
                <div
                  role="tablist"
                  className="inline-flex h-9 w-full items-center justify-center rounded-lg bg-muted p-[3px] text-muted-foreground"
                >
                  {(
                    [
                      { value: "details", label: "Details" },
                      // Billing & Payments is finance data — hidden entirely
                      // for MEMBER (read-only viewer). The detail API already
                      // strips payments/invoices/billing for MEMBER, so
                      // showing the tab would just render an empty shell.
                      ...(showFinance
                        ? ([{ value: "billing", label: "Billing & Payments" }] as const)
                        : []),
                      { value: "activity", label: "Activity" },
                    ] as { value: "details" | "billing" | "activity"; label: string }[]
                  ).map((t) => (
                    <button
                      key={t.value}
                      type="button"
                      role="tab"
                      aria-selected={activeTab === t.value}
                      onClick={() => setActiveTab(t.value)}
                      className={cn(
                        "inline-flex h-[calc(100%-1px)] flex-1 items-center justify-center whitespace-nowrap rounded-md border border-transparent px-2 py-1 text-sm font-medium transition-all",
                        activeTab === t.value
                          ? "bg-background text-foreground shadow-sm"
                          : "hover:text-foreground",
                      )}
                    >
                      {t.label}
                    </button>
                  ))}
                </div>
              )}

              {/* Attendee Info */}
              <section className={cn(
                "rounded-xl border border-slate-200 bg-white px-5 py-4 space-y-4",
                !isEditing && activeTab !== "details" && "hidden",
              )}>
                <h3 className="flex items-center gap-2 text-sm font-semibold uppercase tracking-wide text-slate-700">
                  <User className="h-4 w-4 text-slate-400" />
                  Attendee Information
                </h3>
                {isEditing ? (
                  <div className="grid gap-4">
                    <div className="grid grid-cols-[100px_1fr_1fr] gap-4">
                      <div className="space-y-2">
                        <Label htmlFor="edit-title">Title</Label>
                        <TitleSelect
                          value={editData.title}
                          onChange={(title) => setEditData({ ...editData, title })}
                        />
                      </div>
                      <div className="space-y-2">
                        <Label htmlFor="edit-firstName">First Name *</Label>
                        <Input
                          id="edit-firstName"
                          value={editData.firstName}
                          onChange={(e) => setEditData({ ...editData, firstName: e.target.value })}
                          required
                        />
                      </div>
                      <div className="space-y-2">
                        <Label htmlFor="edit-lastName">Last Name *</Label>
                        <Input
                          id="edit-lastName"
                          value={editData.lastName}
                          onChange={(e) => setEditData({ ...editData, lastName: e.target.value })}
                          required
                        />
                      </div>
                    </div>
                    <div className="space-y-2">
                      <Label>Email</Label>
                      <div className="flex gap-2">
                        <Input value={selectedRegistration.attendee.email} disabled readOnly className="flex-1 bg-muted" />
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          onClick={() => setChangeEmailOpen(true)}
                        >
                          Change
                        </Button>
                      </div>
                      <p className="text-xs text-muted-foreground">
                        Email changes cascade to login + contact records.
                      </p>
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="edit-additionalEmail">Additional Email</Label>
                      <Input
                        id="edit-additionalEmail"
                        type="email"
                        value={editData.additionalEmail}
                        onChange={(e) => setEditData({ ...editData, additionalEmail: e.target.value })}
                        placeholder="alternate@example.com"
                      />
                      <p className="text-xs text-muted-foreground">
                        Optional secondary inbox. Auto-CC&apos;d on every email about this registration.
                        Leave blank to clear.
                      </p>
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="edit-phone">Phone</Label>
                      <Input
                        id="edit-phone"
                        value={editData.phone}
                        onChange={(e) => setEditData({ ...editData, phone: e.target.value })}
                      />
                    </div>
                    <div className="grid grid-cols-2 gap-4">
                      <div className="space-y-2">
                        <Label htmlFor="edit-organization">Organization</Label>
                        <Input
                          id="edit-organization"
                          value={editData.organization}
                          onChange={(e) => setEditData({ ...editData, organization: e.target.value })}
                        />
                      </div>
                      <div className="space-y-2">
                        <Label htmlFor="edit-jobTitle">Job Title</Label>
                        <Input
                          id="edit-jobTitle"
                          value={editData.jobTitle}
                          onChange={(e) => setEditData({ ...editData, jobTitle: e.target.value })}
                        />
                      </div>
                    </div>
                    <div className="grid grid-cols-2 gap-4">
                      <div className="space-y-2">
                        <Label htmlFor="edit-city">City</Label>
                        <Input
                          id="edit-city"
                          value={editData.city}
                          onChange={(e) => setEditData({ ...editData, city: e.target.value })}
                        />
                      </div>
                      <div className="space-y-2">
                        <Label htmlFor="edit-country">Country</Label>
                        <CountrySelect
                          value={editData.country}
                          onChange={(country) => setEditData({ ...editData, country })}
                        />
                      </div>
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="edit-bio">Bio</Label>
                      <textarea
                        id="edit-bio"
                        placeholder="Short biography"
                        className="flex min-h-[80px] w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                        value={editData.bio}
                        onChange={(e) => setEditData({ ...editData, bio: e.target.value })}
                      />
                    </div>
                    <div className="grid grid-cols-2 gap-4">
                      <div className="space-y-2">
                        <Label htmlFor="edit-specialty">Specialty</Label>
                        <SpecialtySelect
                          value={editData.specialty}
                          onChange={(specialty) => setEditData({ ...editData, specialty })}
                        />
                      </div>
                      <div className="space-y-2">
                        <Label htmlFor="edit-dietaryReqs">Dietary Requirements</Label>
                        <Input
                          id="edit-dietaryReqs"
                          value={editData.dietaryReqs}
                          onChange={(e) => setEditData({ ...editData, dietaryReqs: e.target.value })}
                        />
                      </div>
                    </div>
                    {!isReviewer && (
                      <div className="space-y-2">
                        <Label>Tags</Label>
                        <TagInput
                          value={editData.tags}
                          onChange={(tags) => setEditData({ ...editData, tags })}
                          placeholder="Type a tag and press Enter or comma"
                          suggestions={(eventTagsQuery.data?.tags ?? []).map((t) => t.tag)}
                        />
                      </div>
                    )}
                    <div className="space-y-2">
                      <Label htmlFor="edit-notes">Notes</Label>
                      <Input
                        id="edit-notes"
                        value={editData.notes}
                        onChange={(e) => setEditData({ ...editData, notes: e.target.value })}
                      />
                    </div>
                    {/* DTCM barcode — Dubai (DET/DTCM) compliance only. Shown
                        solely for events flagged requiresDtcmBarcode; these
                        codes are normally bulk-imported via CSV, but the field
                        allows a manual correction. */}
                    {requiresDtcmBarcode && (
                      <div className="space-y-2">
                        <Label htmlFor="edit-dtcmBarcode">DTCM Barcode</Label>
                        <Input
                          id="edit-dtcmBarcode"
                          value={editData.dtcmBarcode}
                          onChange={(e) => setEditData({ ...editData, dtcmBarcode: e.target.value })}
                          placeholder="Enter DTCM barcode"
                          className="font-mono"
                        />
                        <p className="text-xs text-muted-foreground">Dubai compliance code — usually CSV-imported. Must be unique across the event.</p>
                      </div>
                    )}

                    {/* Membership Details */}
                    <div className="space-y-3 border-t pt-4">
                      <h4 className="text-sm font-semibold text-slate-700">Membership Details</h4>
                      <div className="grid grid-cols-2 gap-4">
                        <div className="space-y-2">
                          <Label htmlFor="edit-associationName">Association Name</Label>
                          <Input
                            id="edit-associationName"
                            value={editData.associationName}
                            onChange={(e) => setEditData({ ...editData, associationName: e.target.value })}
                            placeholder="e.g. AMA"
                          />
                        </div>
                        <div className="space-y-2">
                          <Label htmlFor="edit-memberId">Member ID</Label>
                          <Input
                            id="edit-memberId"
                            value={editData.memberId}
                            onChange={(e) => setEditData({ ...editData, memberId: e.target.value })}
                            placeholder="e.g. MEM-12345"
                          />
                        </div>
                      </div>
                    </div>

                    {/* Student Details */}
                    <div className="space-y-3 border-t pt-4">
                      <h4 className="text-sm font-semibold text-slate-700">Student Details</h4>
                      <div className="grid grid-cols-2 gap-4">
                        <div className="space-y-2">
                          <Label htmlFor="edit-studentId">Student ID</Label>
                          <Input
                            id="edit-studentId"
                            value={editData.studentId}
                            onChange={(e) => setEditData({ ...editData, studentId: e.target.value })}
                            placeholder="e.g. STU-2024-001"
                          />
                        </div>
                        <div className="space-y-2">
                          <Label htmlFor="edit-studentIdExpiry">Student ID Expiry</Label>
                          <Input
                            id="edit-studentIdExpiry"
                            type="date"
                            value={editData.studentIdExpiry}
                            onChange={(e) => setEditData({ ...editData, studentIdExpiry: e.target.value })}
                          />
                        </div>
                      </div>
                    </div>
                  </div>
                ) : (
                  <div className="grid grid-cols-2 gap-x-6 gap-y-3">
                    <div className="flex items-center gap-3">
                      <Mail className="h-4 w-4 text-muted-foreground shrink-0" />
                      <span className="truncate">{selectedRegistration.attendee.email}</span>
                    </div>
                    {/* Additional email — always render so admins can see
                        whether a secondary CC inbox is set without having
                        to enter edit mode. Empty value shows "Not set —
                        click Edit to add" for clarity. */}
                    <div className="flex items-center gap-3">
                      <Mail className="h-4 w-4 text-muted-foreground shrink-0" />
                      <div className="min-w-0">
                        <div className="text-xs text-muted-foreground">Additional email (CC&apos;d)</div>
                        {selectedRegistration.attendee.additionalEmail ? (
                          <div className="truncate">{selectedRegistration.attendee.additionalEmail}</div>
                        ) : (
                          <div className="text-sm italic text-muted-foreground">Not set — click Edit to add</div>
                        )}
                      </div>
                    </div>
                    {selectedRegistration.attendee.phone ? (
                      <div className="flex items-center gap-3">
                        <Phone className="h-4 w-4 text-muted-foreground shrink-0" />
                        <span>{selectedRegistration.attendee.phone}</span>
                      </div>
                    ) : <div />}
                    {selectedRegistration.attendee.organization && (
                      <div className="flex items-center gap-3">
                        <Building className="h-4 w-4 text-muted-foreground shrink-0" />
                        <span>{selectedRegistration.attendee.organization}</span>
                      </div>
                    )}
                    {selectedRegistration.attendee.jobTitle && (
                      <div className="flex items-center gap-3">
                        <Briefcase className="h-4 w-4 text-muted-foreground shrink-0" />
                        <span>{selectedRegistration.attendee.jobTitle}</span>
                      </div>
                    )}
                    {(selectedRegistration.attendee.city || selectedRegistration.attendee.country) && (
                      <div className="flex items-center gap-3">
                        <MapPin className="h-4 w-4 text-muted-foreground shrink-0" />
                        <span>
                          {[selectedRegistration.attendee.city, selectedRegistration.attendee.country]
                            .filter(Boolean)
                            .join(", ")}
                        </span>
                      </div>
                    )}
                    {selectedRegistration.attendee.specialty && (
                      <div className="flex items-center gap-3">
                        <ClipboardList className="h-4 w-4 text-muted-foreground shrink-0" />
                        <div>
                          <div className="text-xs text-muted-foreground">Specialty</div>
                          <div>{selectedRegistration.attendee.specialty}</div>
                        </div>
                      </div>
                    )}
                    {selectedRegistration.attendee.dietaryReqs && (
                      <div className="flex items-center gap-3">
                        <Utensils className="h-4 w-4 text-muted-foreground shrink-0" />
                        <span>{selectedRegistration.attendee.dietaryReqs}</span>
                      </div>
                    )}
                    {selectedRegistration.attendee.tags && selectedRegistration.attendee.tags.length > 0 && (
                      <div className="flex items-start gap-3 col-span-2">
                        <ClipboardList className="h-4 w-4 text-muted-foreground mt-1 shrink-0" />
                        <div>
                          <div className="text-xs text-muted-foreground mb-1">Tags</div>
                          <div className="flex flex-wrap gap-1">
                            {selectedRegistration.attendee.tags.map((tag, index) => (
                              <Badge key={index} variant="secondary" className="text-xs">
                                {tag}
                              </Badge>
                            ))}
                          </div>
                        </div>
                      </div>
                    )}
                    {selectedRegistration.attendee.bio && (
                      <div className="col-span-2">
                        <div className="text-xs text-muted-foreground">Bio</div>
                        <div className="text-sm whitespace-pre-wrap">{selectedRegistration.attendee.bio}</div>
                      </div>
                    )}
                    {(selectedRegistration.attendee.associationName || selectedRegistration.attendee.memberId) && (
                      <>
                        <div>
                          <div className="text-xs text-muted-foreground">Association</div>
                          <div className="text-sm">{selectedRegistration.attendee.associationName || "—"}</div>
                        </div>
                        <div>
                          <div className="text-xs text-muted-foreground">Member ID</div>
                          <div className="text-sm">{selectedRegistration.attendee.memberId || "—"}</div>
                        </div>
                      </>
                    )}
                    {(selectedRegistration.attendee.studentId || selectedRegistration.attendee.studentIdExpiry) && (
                      <>
                        <div>
                          <div className="text-xs text-muted-foreground">Student ID</div>
                          <div className="text-sm">{selectedRegistration.attendee.studentId || "—"}</div>
                        </div>
                        <div>
                          <div className="text-xs text-muted-foreground">Student ID Expiry</div>
                          <div className="text-sm">{selectedRegistration.attendee.studentIdExpiry ? new Date(selectedRegistration.attendee.studentIdExpiry).toLocaleDateString() : "—"}</div>
                        </div>
                      </>
                    )}
                  </div>
                )}
              </section>

              {/* Notes — shown on the Details tab in view mode so the field
                  surfaces on the same tab where it's edited (the textarea
                  lives inside the Attendee Information edit form above).
                  Always rendered with a "Not set" placeholder so admins know
                  the field exists even when empty — previously notes were
                  only visible on the Activity tab AND only when non-empty,
                  which made the edit experience feel write-only. */}
              {!isEditing && (
                <section className={cn(
                  "rounded-xl border border-slate-200 bg-white px-5 py-4 space-y-3",
                  activeTab !== "details" && "hidden",
                )}>
                  <h3 className="flex items-center gap-2 text-sm font-semibold uppercase tracking-wide text-slate-700">
                    <StickyNote className="h-4 w-4 text-slate-400" />
                    Notes
                  </h3>
                  {selectedRegistration.notes ? (
                    <p className="text-sm whitespace-pre-wrap text-slate-700">
                      {selectedRegistration.notes}
                    </p>
                  ) : (
                    <p className="text-sm italic text-muted-foreground">
                      Not set — click Edit to add internal notes about this registration.
                    </p>
                  )}
                </section>
              )}

              <section className={cn(
                "rounded-xl border border-slate-200 bg-white px-5 py-4 space-y-4",
                !isEditing && activeTab !== "details" && "hidden",
              )}>
                <h3 className="flex items-center gap-2 text-sm font-semibold uppercase tracking-wide text-slate-700">
                  <Ticket className="h-4 w-4 text-slate-400" />
                  Registration Details
                </h3>

                {/* Registration ID */}
                {selectedRegistration.serialId != null && (
                  <div className="flex items-center gap-2 text-sm">
                    <span className="text-muted-foreground">Registration ID:</span>
                    <span className="font-mono font-medium">{formatSerialId(selectedRegistration.serialId)}</span>
                  </div>
                )}

              {/* Registration Type + Badge Type (side by side). Desk operators
                  (ONSITE/MEMBER) can edit; only reviewers get the read-only branch. */}
              {!isReviewer ? (
                <div className="grid grid-cols-2 gap-3">
                  <div className="space-y-2">
                    <Label>Registration Type</Label>
                    {selectedRegistration.ticketType?.isFaculty ? (
                      // Faculty companion: show the profession (read-only). Its
                      // ticket type is the hidden "Faculty" type — not a delegate
                      // category — so it isn't reassignable from this picker.
                      <div className="flex h-9 items-center text-sm font-medium">
                        {displayRegistrationType({ ticketTypeName: selectedRegistration.ticketType?.name, isFaculty: true, attendeeRegistrationType: selectedRegistration.attendee.registrationType })}
                      </div>
                    ) : (
                      <Select
                        value={selectedRegistration.ticketType?.id ?? ""}
                        onValueChange={(value) =>
                          updateRegistration.mutate({
                            id: selectedRegistration.id,
                            data: { ticketTypeId: value },
                          })
                        }
                        disabled={updateRegistration.isPending}
                      >
                        <SelectTrigger>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {(regTypes as TicketType[]).map((rt) => (
                            <SelectItem key={rt.id} value={rt.id}>
                              {rt.name}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    )}
                  </div>
                  <div className="space-y-2">
                    <Label>Badge Type</Label>
                    {(() => {
                      const BADGE_TYPES = ["Delegate", "Faculty", "Exhibitor", "Committee", "Chairman", "Co-Chairman"];
                      const currentBadge = selectedRegistration.badgeType || "Delegate";
                      const isCustom = !BADGE_TYPES.includes(currentBadge) && currentBadge !== "Custom";
                      return (
                        <>
                          <Select
                            value={isCustom ? "Custom" : currentBadge}
                            onValueChange={(value) => {
                              if (value === "Custom") {
                                updateRegistration.mutate({
                                  id: selectedRegistration.id,
                                  data: { badgeType: "" },
                                });
                              } else {
                                updateRegistration.mutate({
                                  id: selectedRegistration.id,
                                  data: { badgeType: value },
                                });
                              }
                            }}
                            disabled={updateRegistration.isPending}
                          >
                            <SelectTrigger>
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              {BADGE_TYPES.map((bt) => (
                                <SelectItem key={bt} value={bt}>{bt}</SelectItem>
                              ))}
                              <SelectItem value="Custom">Custom...</SelectItem>
                            </SelectContent>
                          </Select>
                          {(isCustom || currentBadge === "" || currentBadge === "Custom") && (
                            <Input
                              placeholder="Enter custom badge type"
                              defaultValue={isCustom ? currentBadge : ""}
                              onBlur={(e) => {
                                if (e.target.value.trim()) {
                                  updateRegistration.mutate({
                                    id: selectedRegistration.id,
                                    data: { badgeType: e.target.value.trim() },
                                  });
                                }
                              }}
                              onKeyDown={(e) => {
                                if (e.key === "Enter" && (e.target as HTMLInputElement).value.trim()) {
                                  updateRegistration.mutate({
                                    id: selectedRegistration.id,
                                    data: { badgeType: (e.target as HTMLInputElement).value.trim() },
                                  });
                                }
                              }}
                            />
                          )}
                        </>
                      );
                    })()}
                  </div>
                </div>
              ) : (
                <div className="flex items-center gap-3">
                  <ClipboardList className="h-4 w-4 text-muted-foreground" />
                  <div className="font-medium">{displayRegistrationType({ ticketTypeName: selectedRegistration.ticketType?.name, isFaculty: selectedRegistration.ticketType?.isFaculty, attendeeRegistrationType: selectedRegistration.attendee.registrationType })}</div>
                </div>
              )}

              {/* Attendance mode — HYBRID events only. Gated `!isReviewer` to
                  match the other seat-affecting selects (Registration Type)
                  and the PUT route's REGISTRATION_DESK_ALLOW (admins, organizers
                  + registration-desk staff can change it; reviewers can't). */}
              {isHybridEvent && !isReviewer && (
                <div className="space-y-2">
                  <Label>Attendance</Label>
                  <Select
                    value={selectedRegistration.attendanceMode ?? "IN_PERSON"}
                    onValueChange={(value) =>
                      updateRegistration.mutate({
                        id: selectedRegistration.id,
                        data: { attendanceMode: value },
                      })
                    }
                    disabled={updateRegistration.isPending}
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="IN_PERSON">In-person</SelectItem>
                      <SelectItem value="VIRTUAL">Virtual</SelectItem>
                    </SelectContent>
                  </Select>
                  <p className="text-xs text-muted-foreground">
                    Switching to <strong>in-person</strong> issues an entry barcode and
                    takes a venue seat (blocked if the type is sold out); <strong>virtual</strong>{" "}
                    releases the seat and suppresses badge/check-in. This does <strong>not</strong>{" "}
                    change the amount owed — adjust payment separately if needed.
                  </p>
                </div>
              )}

              {/* Pricing Tier — which sales window this registration fell
                  under (Early Bird / Standard / Onsite). Read-only: captured
                  at registration time (public form picks it via the category
                  URL; admin add-form has the picker). Shown on the Details
                  tab for ALL roles incl. MEMBER — the tier NAME is
                  operational, only the tier PRICE is financial, so it must
                  not be buried in the finance-gated Payment Summary. */}
              <div className="space-y-2">
                <Label>Pricing Tier</Label>
                <div className="bg-muted p-3 rounded-lg">
                  {selectedRegistration.pricingTier?.name ? (
                    <span className="inline-flex items-center rounded-md bg-amber-100 px-2 py-0.5 text-sm font-medium text-amber-800">
                      {selectedRegistration.pricingTier.name}
                    </span>
                  ) : (
                    <span className="text-sm text-muted-foreground">
                      — no pricing tier (legacy or non-tiered registration)
                    </span>
                  )}
                </div>
              </div>

              {/* Payment block — finance-gated (showFinance hides it for
                  MEMBER; `financials` is also absent in MEMBER payloads).
                  Always shown to finance roles: heading flips between
                  "Payment Pending" (balance owed) and "Paid in Full".
                  Surfaces amount + VAT on the Details tab so it's visible
                  at a glance, not buried in the Billing-tab summary. The
                  bank-transfer partial case shows naturally as a non-zero
                  Balance Due. */}
              {showFinance && selectedRegistration.financials && selectedRegistration.financials.total > 0 && (() => {
                const f = selectedRegistration.financials!;
                const pending = f.hasOutstandingBalance;
                return (
                  <div className={cn(
                    "rounded-xl border px-5 py-4 space-y-2",
                    pending ? "border-amber-300 bg-amber-50/60" : "border-emerald-200 bg-emerald-50/50",
                  )}>
                    <div className="flex items-center justify-between">
                      <h3 className={cn(
                        "flex items-center gap-2 text-sm font-semibold uppercase tracking-wide",
                        pending ? "text-amber-800" : "text-emerald-700",
                      )}>
                        <CreditCard className="h-4 w-4" />
                        {pending ? "Payment Pending" : "Paid in Full"}
                      </h3>
                      <Badge
                        className={cn(
                          "border-white/40",
                          PAYMENT_STATUS_COLORS[selectedRegistration.paymentStatus],
                        )}
                        variant="outline"
                      >
                        {PAYMENT_STATUS_LABELS[selectedRegistration.paymentStatus]}
                      </Badge>
                    </div>
                    <div className="space-y-1.5 text-sm">
                      <div className="flex justify-between">
                        <span className="text-muted-foreground">Subtotal</span>
                        <span className="font-medium">{formatCurrency(f.subtotal, f.currency)}</span>
                      </div>
                      {selectedRegistration.promoCode && (
                        <div className="flex justify-between">
                          <span className="text-muted-foreground">Promo code applied</span>
                          <span className="font-medium text-emerald-700">{selectedRegistration.promoCode.code}</span>
                        </div>
                      )}
                      {f.discount > 0 && (
                        <div className="flex justify-between">
                          <span className="text-muted-foreground">Discount</span>
                          <span className="font-medium text-emerald-600">
                            −{formatCurrency(f.discount, f.currency)}
                          </span>
                        </div>
                      )}
                      {f.taxRate > 0 && (
                        <div className="flex justify-between">
                          <span className="text-muted-foreground">
                            {f.taxLabel} ({f.taxRate}%)
                          </span>
                          <span className="font-medium">{formatCurrency(f.taxAmount, f.currency)}</span>
                        </div>
                      )}
                      <div className="flex justify-between border-t pt-1.5">
                        <span className="text-muted-foreground">Total</span>
                        <span className="font-semibold">{formatCurrency(f.total, f.currency)}</span>
                      </div>
                      {f.totalPaid > 0 && (
                        <div className="flex justify-between">
                          <span className="text-muted-foreground">Paid</span>
                          <span className="font-medium text-emerald-600">
                            {formatCurrency(f.totalPaid, f.currency)}
                          </span>
                        </div>
                      )}
                      {pending && (
                        <div className="flex justify-between border-t pt-1.5">
                          <span className="font-semibold text-amber-800">Outstanding</span>
                          <span className="font-bold text-amber-800">
                            {formatCurrency(f.balanceDue, f.currency)}
                          </span>
                        </div>
                      )}
                    </div>
                    {pending && !isReviewer && (
                      <Button
                        size="sm"
                        variant="outline"
                        className="w-full mt-1"
                        disabled={sendEmail.isPending}
                        onClick={() =>
                          sendEmail.mutate({ id: selectedRegistration.id, type: "payment-reminder" })
                        }
                      >
                        {sendEmail.isPending ? "Sending…" : "Send Payment Link"}
                      </Button>
                    )}
                  </div>
                );
              })()}

              {/* Registration Status + Payment Status (side by side) — these
                  Selects mutate on change. Desk operators (ONSITE/MEMBER) can
                  change status/payment now; only reviewers are excluded. */}
              {!isReviewer && (
                <div className="grid grid-cols-2 gap-3">
                  <div className="space-y-2">
                    <Label>Registration Status</Label>
                    <Select
                      value={selectedRegistration.status}
                      onValueChange={(value) =>
                        updateRegistration.mutate({
                          id: selectedRegistration.id,
                          data: { status: value },
                        })
                      }
                      disabled={updateRegistration.isPending}
                    >
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {REGISTRATION_STATUS_DISPLAY_ORDER.map((status) => (
                          <SelectItem key={status} value={status}>
                            {REGISTRATION_STATUS_LABELS[status]}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-2">
                    <Label>Payment Status</Label>
                    <Select
                      value={selectedRegistration.paymentStatus}
                      onValueChange={(value) => {
                        // When flipping to INCLUSIVE, require a sponsor pick before
                        // sending the mutation — the server validates it but a
                        // client-side guard avoids a useless round-trip + a confusing
                        // 400 toast. If no sponsor is currently set on the
                        // registration, prompt the user to pick one via the sponsor
                        // dropdown below; do NOT send the mutation yet.
                        if (value === "INCLUSIVE" && !selectedRegistration.sponsorId) {
                          toast.error("Pick a sponsor below before marking this Inclusive.");
                          return;
                        }
                        updateRegistration.mutate({
                          id: selectedRegistration.id,
                          data: { paymentStatus: value },
                        });
                      }}
                      disabled={updateRegistration.isPending}
                    >
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {PAYMENT_STATUS_DISPLAY_ORDER.map((status) => (
                          <SelectItem key={status} value={status}>
                            {PAYMENT_STATUS_LABELS[status]}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                </div>
              )}

              {/* Sponsor picker — only relevant when the registration is INCLUSIVE.
                  Shown in the edit area (above the Payment Summary). Picking from
                  here triggers an immediate update, same as the other inline
                  selects in this section. */}
              {isEditing && selectedRegistration.paymentStatus === "INCLUSIVE" && (
                <div className="space-y-2">
                  <Label>Sponsored by</Label>
                  {sponsors.length === 0 ? (
                    <p className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded px-2 py-1.5">
                      No sponsors configured for this event.{" "}
                      <a
                        href={`/events/${eventId}/sponsors`}
                        className="underline font-medium"
                      >
                        Add a sponsor first
                      </a>
                      , then pick from this dropdown.
                    </p>
                  ) : (
                    <Select
                      value={selectedRegistration.sponsorId ?? ""}
                      onValueChange={(value) =>
                        updateRegistration.mutate({
                          id: selectedRegistration.id,
                          data: { sponsorId: value },
                        })
                      }
                      disabled={updateRegistration.isPending}
                    >
                      <SelectTrigger>
                        <SelectValue placeholder="Pick the sponsor that paid" />
                      </SelectTrigger>
                      <SelectContent>
                        {sponsors.map((s) => (
                          <SelectItem key={s.id} value={s.id}>
                            {s.name}
                            {s.tier ? ` · ${s.tier}` : ""}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  )}
                </div>
              )}

              {/* "Charge to another account" — reassign the payer post-hoc.
                  This is also the fallback control: setting it back to
                  self-pay reverts an unpaid third-party invoice to the
                  attendee. Orthogonal to paymentStatus. Immediate-update on
                  change, like the other inline selects in this section. */}
              {isEditing && (
                <div className="space-y-2">
                  <Label>Charge to (billing account)</Label>
                  <Select
                    value={selectedRegistration.billingAccountId ?? "__self__"}
                    onValueChange={(value) =>
                      updateRegistration.mutate({
                        id: selectedRegistration.id,
                        data: { billingAccountId: value === "__self__" ? null : value },
                      })
                    }
                    disabled={updateRegistration.isPending}
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="__self__">The attendee (self-pay)</SelectItem>
                      {/* Safety net: if the current payer was detached from
                          this event since assignment, the filtered list won't
                          include it. Render it as a synthetic option so the
                          dropdown reflects the actual state and the user can
                          consciously keep or change it. */}
                      {selectedRegistration.billingAccountId &&
                        selectedRegistration.billingAccount &&
                        !billingAccounts.some(
                          (ba) => ba.id === selectedRegistration.billingAccountId,
                        ) && (
                          <SelectItem value={selectedRegistration.billingAccountId}>
                            {selectedRegistration.billingAccount.name} (no longer attached to this event)
                          </SelectItem>
                        )}
                      {billingAccounts.map((ba) => (
                        <SelectItem key={ba.id} value={ba.id}>
                          {ba.name} ({ba.type})
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  {selectedRegistration.billingAccountId && (
                    <>
                      <Input
                        value={editData.payerReference}
                        onChange={(e) =>
                          setEditData((p) => ({ ...p, payerReference: e.target.value }))
                        }
                        onBlur={() =>
                          updateRegistration.mutate({
                            id: selectedRegistration.id,
                            data: { payerReference: editData.payerReference.trim() || null },
                          })
                        }
                        placeholder="PO / grant reference (printed on invoice)"
                      />
                      <label className="flex items-start gap-2 text-sm text-muted-foreground">
                        <input
                          type="checkbox"
                          className="mt-0.5"
                          checked={selectedRegistration.attendeeIsGuarantor}
                          onChange={(e) =>
                            updateRegistration.mutate({
                              id: selectedRegistration.id,
                              data: { attendeeIsGuarantor: e.target.checked },
                            })
                          }
                        />
                        Attendee is guarantor — if the payer doesn&apos;t settle,
                        the balance can revert to the attendee.
                      </label>
                    </>
                  )}
                </div>
              )}
              </section>

              {/* Payment Summary — always rendered in Billing tab. Shows the
                  financial snapshot at a glance (status badge + ticket price
                  + discount + total paid) plus a Download Quote action. */}
              {!isEditing && (() => {
                // Single source of truth — same `financials` block the
                // Details-tab Payment block uses, so the two surfaces
                // (and the quote/invoice PDF) can never disagree on VAT.
                const f = selectedRegistration.financials;
                const showFinancials = !!f && (f.total > 0 || f.totalPaid > 0);
                return (
                  <section className={cn(
                    "rounded-xl border border-slate-200 bg-white px-5 py-4 space-y-4",
                    activeTab !== "billing" && "hidden",
                  )}>
                    <div className="flex items-center justify-between">
                      <h3 className="flex items-center gap-2 text-sm font-semibold uppercase tracking-wide text-slate-700">
                        <CreditCard className="h-4 w-4 text-slate-400" />
                        Payment Summary
                      </h3>
                      <Badge className={PAYMENT_STATUS_COLORS[selectedRegistration.paymentStatus]} variant="outline">
                        {PAYMENT_STATUS_LABELS[selectedRegistration.paymentStatus]}
                      </Badge>
                    </div>
                    {showFinancials && f ? (
                      <div className="space-y-2 text-sm">
                        <div className="flex justify-between">
                          <span className="text-muted-foreground">Ticket</span>
                          <span className="font-medium">
                            {selectedRegistration.ticketType?.name ?? "—"}
                            {selectedRegistration.pricingTier && ` · ${selectedRegistration.pricingTier.name}`}
                          </span>
                        </div>
                        <div className="flex justify-between">
                          <span className="text-muted-foreground">Subtotal</span>
                          <span className="font-medium">{formatCurrency(f.subtotal, f.currency)}</span>
                        </div>
                        {selectedRegistration.promoCode && (
                          <div className="flex justify-between">
                            <span className="text-muted-foreground">Promo code applied</span>
                            <span className="font-medium text-emerald-700">{selectedRegistration.promoCode.code}</span>
                          </div>
                        )}
                        {f.discount > 0 && (
                          <div className="flex justify-between">
                            <span className="text-muted-foreground">Discount</span>
                            <span className="font-medium text-emerald-600">−{formatCurrency(f.discount, f.currency)}</span>
                          </div>
                        )}
                        {f.taxRate > 0 && (
                          <div className="flex justify-between">
                            <span className="text-muted-foreground">{f.taxLabel} ({f.taxRate}%)</span>
                            <span className="font-medium">{formatCurrency(f.taxAmount, f.currency)}</span>
                          </div>
                        )}
                        <div className="flex justify-between border-t pt-2">
                          <span className="text-muted-foreground">Total</span>
                          <span className="font-semibold">{formatCurrency(f.total, f.currency)}</span>
                        </div>
                        {f.totalPaid > 0 && (
                          <div className="flex justify-between">
                            <span className="text-muted-foreground">Paid</span>
                            <span className="font-medium text-emerald-600">{formatCurrency(f.totalPaid, f.currency)}</span>
                          </div>
                        )}
                        {/* Final outstanding amount — always shown when money is
                            still owed, prominent so it's unmissable. */}
                        {f.hasOutstandingBalance && (
                          <div className="flex justify-between border-t pt-2">
                            <span className="font-semibold text-amber-800">Outstanding</span>
                            <span className="font-bold text-amber-800">{formatCurrency(f.balanceDue, f.currency)}</span>
                          </div>
                        )}
                      </div>
                    ) : (
                      <p className="text-sm text-muted-foreground">
                        {selectedRegistration.paymentStatus === "COMPLIMENTARY"
                          ? "Complimentary registration — no payment due."
                          : selectedRegistration.paymentStatus === "INCLUSIVE"
                          ? "Sponsor-paid registration — no payment due from attendee."
                          : "Free registration — no payment required."}
                      </p>
                    )}
                    {/* Show sponsor attribution whenever sponsorId is set (even if
                        status is no longer INCLUSIVE — we don't auto-clear, so
                        admins can see the historical attribution). */}
                    {selectedRegistration.sponsorId && (
                      <div className="rounded-lg border border-violet-200 bg-violet-50 px-3 py-2 text-sm flex items-center justify-between">
                        <div>
                          <span className="text-violet-700 font-medium">Sponsored by:</span>{" "}
                          <span className="text-violet-900">
                            {sponsorById(selectedRegistration.sponsorId)?.name ?? "(sponsor removed)"}
                          </span>
                        </div>
                        {selectedRegistration.paymentStatus !== "INCLUSIVE" && (
                          <span className="text-xs text-violet-700/70">
                            (status: {PAYMENT_STATUS_LABELS[selectedRegistration.paymentStatus]})
                          </span>
                        )}
                      </div>
                    )}
                    {/* "Charge to another account" — bill-to attribution.
                        Shown whenever a payer is set; the invoice/quote is
                        addressed to them, not the attendee. */}
                    {selectedRegistration.billingAccountId && (
                      <div className="rounded-lg border border-sky-200 bg-sky-50 px-3 py-2 text-sm">
                        <div className="flex items-center justify-between">
                          <span>
                            <span className="text-sky-700 font-medium">Billed to:</span>{" "}
                            <span className="text-sky-900">
                              {selectedRegistration.billingAccount?.name ??
                                "(payer removed)"}
                            </span>
                          </span>
                          {selectedRegistration.attendeeIsGuarantor && (
                            <span className="text-xs text-sky-700/70">
                              attendee is guarantor
                            </span>
                          )}
                        </div>
                        {selectedRegistration.payerReference && (
                          <div className="text-xs text-sky-700/80 mt-0.5">
                            Ref: {selectedRegistration.payerReference}
                          </div>
                        )}
                      </div>
                    )}
                    {/* Promo code — apply/remove while payment is still
                        outstanding. Same rules as the registrant self-apply
                        (organizers don't bypass a promo's own limits). */}
                    {(["UNASSIGNED", "UNPAID", "PENDING"] as string[]).includes(selectedRegistration.paymentStatus) &&
                      !!f && f.subtotal > 0 && (
                        <div className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2.5 space-y-2">
                          <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Promo code</p>
                          {selectedRegistration.promoCode ? (
                            <div className="flex items-center justify-between text-sm">
                              <span className="font-medium text-emerald-700">{selectedRegistration.promoCode.code} applied</span>
                              <button
                                type="button"
                                className="text-slate-600 underline underline-offset-2 hover:text-slate-900 disabled:opacity-50"
                                disabled={promoBusy}
                                onClick={removePromoCode}
                              >
                                Remove
                              </button>
                            </div>
                          ) : (
                            <div className="flex items-center gap-2">
                              <Input
                                placeholder="Enter code"
                                value={promoCodeInput}
                                onChange={(e) => setPromoCodeInput(e.target.value)}
                                onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); applyPromoCode(); } }}
                                disabled={promoBusy}
                                className="h-9 uppercase placeholder:normal-case"
                              />
                              <Button
                                variant="outline"
                                size="sm"
                                className="h-9 shrink-0"
                                disabled={promoBusy || !promoCodeInput.trim()}
                                onClick={applyPromoCode}
                              >
                                {promoBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : "Apply"}
                              </Button>
                            </div>
                          )}
                        </div>
                      )}
                    {!!f && f.subtotal > 0 && (
                      <Button variant="outline" size="sm" asChild className="w-full">
                        <a href={`/api/events/${eventId}/registrations/${selectedRegistration.id}/quote`} download>
                          <Download className="mr-2 h-4 w-4" /> Download Quote
                        </a>
                      </Button>
                    )}
                  </section>
                );
              })()}

              {/* Billing Details — always rendered in Billing tab (view mode)
                  OR in edit mode (so admins can add a billing override). When
                  the registrant has no custom billing block we fall back to
                  the attendee's personal address with a note, so the section
                  is never empty. */}
              {(() => {
                const customBilling = hasCustomBilling(selectedRegistration);
                return (
                  <section className={cn(
                    "rounded-xl border border-slate-200 bg-white px-5 py-4 space-y-4",
                    !isEditing && activeTab !== "billing" && "hidden",
                  )}>
                    <h3 className="flex items-center gap-2 text-sm font-semibold uppercase tracking-wide text-slate-700">
                      <Receipt className="h-4 w-4 text-slate-400" />
                      Billing Details
                    </h3>
                    {/* "Charge to" status — visible at the top in view mode so
                        organizers don't have to enter Edit to see the current
                        payer/self-pay state. Pre-this-fix the only signal in
                        view mode was the "Billed to" pill in Payment Summary,
                        which only appeared when a payer was set. */}
                    {!isEditing && (
                      <div className={cn(
                        "rounded-md border px-3 py-2 text-sm",
                        selectedRegistration.billingAccountId
                          ? "border-sky-200 bg-sky-50"
                          : "border-slate-200 bg-slate-50",
                      )}>
                        <div className="flex items-center justify-between gap-3 flex-wrap">
                          <div>
                            <span className={cn(
                              "font-medium",
                              selectedRegistration.billingAccountId ? "text-sky-700" : "text-slate-600",
                            )}>
                              Charge to:
                            </span>{" "}
                            <span className={cn(
                              selectedRegistration.billingAccountId ? "text-sky-900" : "text-slate-900",
                            )}>
                              {selectedRegistration.billingAccount?.name
                                ?? (selectedRegistration.billingAccountId
                                  ? "(payer removed)"
                                  : "Attendee — self-pay")}
                            </span>
                            {selectedRegistration.attendeeIsGuarantor && selectedRegistration.billingAccountId && (
                              <span className="ml-2 text-xs text-sky-700/70">
                                · attendee is guarantor
                              </span>
                            )}
                          </div>
                          {selectedRegistration.billingAccountId && selectedRegistration.payerReference && (
                            <div className="text-xs text-sky-700/80">
                              Ref: {selectedRegistration.payerReference}
                            </div>
                          )}
                        </div>
                      </div>
                    )}
                    {/* Billing address status — always visible in view mode
                        so the "same as personal" vs "custom" state is obvious
                        at a glance, regardless of whether hasCustomBilling()
                        decides to render the custom-address grid or the
                        same-as-personal fallback below. Sibling of the
                        "Charge to" pill. */}
                    {!isEditing && (() => {
                      const isCustom = hasCustomBilling(selectedRegistration);
                      return (
                        <div className={cn(
                          "rounded-md border px-3 py-2 text-sm",
                          isCustom
                            ? "border-amber-200 bg-amber-50"
                            : "border-slate-200 bg-slate-50",
                        )}>
                          <span className={cn(
                            "font-medium",
                            isCustom ? "text-amber-700" : "text-slate-600",
                          )}>
                            Billing address:
                          </span>{" "}
                          <span className={cn(
                            isCustom ? "text-amber-900" : "text-slate-900",
                          )}>
                            {isCustom
                              ? "Custom billing address (overrides personal)"
                              : "Same as personal details"}
                          </span>
                        </div>
                      );
                    })()}
                    {isEditing ? (
                      <div className="space-y-4">
                        <div className="space-y-2">
                          <Label htmlFor="edit-taxNumber">Tax Number / VAT ID</Label>
                          <Input
                            id="edit-taxNumber"
                            value={editData.taxNumber}
                            onChange={(e) => setEditData({ ...editData, taxNumber: e.target.value })}
                            placeholder="e.g. AE1234567890"
                          />
                        </div>
                        <div className="grid grid-cols-2 gap-4">
                          <div className="space-y-2">
                            <Label htmlFor="edit-billingFirstName">Billing First Name</Label>
                            <Input
                              id="edit-billingFirstName"
                              value={editData.billingFirstName}
                              onChange={(e) => setEditData({ ...editData, billingFirstName: e.target.value })}
                            />
                          </div>
                          <div className="space-y-2">
                            <Label htmlFor="edit-billingLastName">Billing Last Name</Label>
                            <Input
                              id="edit-billingLastName"
                              value={editData.billingLastName}
                              onChange={(e) => setEditData({ ...editData, billingLastName: e.target.value })}
                            />
                          </div>
                        </div>
                        <div className="grid grid-cols-2 gap-4">
                          <div className="space-y-2">
                            <Label htmlFor="edit-billingEmail">Billing Email</Label>
                            <Input
                              id="edit-billingEmail"
                              type="email"
                              value={editData.billingEmail}
                              onChange={(e) => setEditData({ ...editData, billingEmail: e.target.value })}
                            />
                          </div>
                          <div className="space-y-2">
                            <Label htmlFor="edit-billingPhone">Billing Phone</Label>
                            <Input
                              id="edit-billingPhone"
                              value={editData.billingPhone}
                              onChange={(e) => setEditData({ ...editData, billingPhone: e.target.value })}
                            />
                          </div>
                        </div>
                        <div className="space-y-2">
                          <Label htmlFor="edit-billingAddress">Billing Address</Label>
                          <Input
                            id="edit-billingAddress"
                            value={editData.billingAddress}
                            onChange={(e) => setEditData({ ...editData, billingAddress: e.target.value })}
                            placeholder="Street address"
                          />
                        </div>
                        <div className="grid grid-cols-2 gap-4">
                          <div className="space-y-2">
                            <Label htmlFor="edit-billingCity">Billing City</Label>
                            <Input
                              id="edit-billingCity"
                              value={editData.billingCity}
                              onChange={(e) => setEditData({ ...editData, billingCity: e.target.value })}
                            />
                          </div>
                          <div className="space-y-2">
                            <Label htmlFor="edit-billingCountry">Billing Country</Label>
                            <CountrySelect
                              value={editData.billingCountry}
                              onChange={(billingCountry) => setEditData({ ...editData, billingCountry })}
                            />
                          </div>
                        </div>
                        <div className="grid grid-cols-2 gap-4">
                          <div className="space-y-2">
                            <Label htmlFor="edit-billingState">Billing State / Province</Label>
                            <Input
                              id="edit-billingState"
                              value={editData.billingState}
                              onChange={(e) => setEditData({ ...editData, billingState: e.target.value })}
                            />
                          </div>
                          <div className="space-y-2">
                            <Label htmlFor="edit-billingZipCode">Billing Zip / Postal</Label>
                            <Input
                              id="edit-billingZipCode"
                              value={editData.billingZipCode}
                              onChange={(e) => setEditData({ ...editData, billingZipCode: e.target.value })}
                            />
                          </div>
                        </div>
                        <p className="text-xs text-muted-foreground">
                          Leave blank to use the registrant&apos;s personal address
                          for billing. Any non-blank field overrides the
                          corresponding personal value on invoices + quotes.
                        </p>
                      </div>
                    ) : customBilling ? (
                      <div className="grid grid-cols-2 gap-x-6 gap-y-3 text-sm">
                        {(selectedRegistration.billingFirstName || selectedRegistration.billingLastName) && (
                          <div className="col-span-2">
                            <div className="text-xs text-muted-foreground">Bill to</div>
                            <div className="font-medium">
                              {[selectedRegistration.billingFirstName, selectedRegistration.billingLastName]
                                .filter(Boolean)
                                .join(" ")}
                            </div>
                          </div>
                        )}
                        {selectedRegistration.taxNumber && (
                          <div>
                            <div className="text-xs text-muted-foreground">Tax Number / VAT</div>
                            <div className="font-medium">{selectedRegistration.taxNumber}</div>
                          </div>
                        )}
                        {selectedRegistration.billingEmail && (
                          <div>
                            <div className="text-xs text-muted-foreground">Billing Email</div>
                            <div className="font-medium">{selectedRegistration.billingEmail}</div>
                          </div>
                        )}
                        {selectedRegistration.billingPhone && (
                          <div>
                            <div className="text-xs text-muted-foreground">Billing Phone</div>
                            <div className="font-medium">{selectedRegistration.billingPhone}</div>
                          </div>
                        )}
                        {selectedRegistration.billingAddress && (
                          <div className="col-span-2">
                            <div className="text-xs text-muted-foreground">Address</div>
                            <div className="font-medium">{selectedRegistration.billingAddress}</div>
                          </div>
                        )}
                        {(selectedRegistration.billingCity
                          || selectedRegistration.billingState
                          || selectedRegistration.billingZipCode
                          || selectedRegistration.billingCountry) && (
                          <div className="col-span-2">
                            <div className="text-xs text-muted-foreground">City / State / Zip / Country</div>
                            <div className="font-medium">
                              {[
                                selectedRegistration.billingCity,
                                [selectedRegistration.billingState, selectedRegistration.billingZipCode]
                                  .filter(Boolean)
                                  .join(" "),
                                selectedRegistration.billingCountry,
                              ]
                                .filter(Boolean)
                                .join(", ")}
                            </div>
                          </div>
                        )}
                      </div>
                    ) : (
                      <div className="space-y-3 text-sm">
                        <p className="text-xs text-muted-foreground italic">
                          Billing address same as personal — invoices + quotes
                          will use the attendee details below. Click Edit to
                          override.
                        </p>
                        <div className="grid grid-cols-2 gap-x-6 gap-y-3">
                          <div className="col-span-2">
                            <div className="text-xs text-muted-foreground">Bill to</div>
                            <div className="font-medium">
                              {[selectedRegistration.attendee.firstName, selectedRegistration.attendee.lastName]
                                .filter(Boolean)
                                .join(" ")}
                            </div>
                          </div>
                          <div>
                            <div className="text-xs text-muted-foreground">Email</div>
                            <div className="font-medium">{selectedRegistration.attendee.email}</div>
                          </div>
                          {selectedRegistration.attendee.phone && (
                            <div>
                              <div className="text-xs text-muted-foreground">Phone</div>
                              <div className="font-medium">{selectedRegistration.attendee.phone}</div>
                            </div>
                          )}
                          {(selectedRegistration.attendee.city
                            || selectedRegistration.attendee.state
                            || selectedRegistration.attendee.zipCode
                            || selectedRegistration.attendee.country) && (
                            <div className="col-span-2">
                              <div className="text-xs text-muted-foreground">City / State / Zip / Country</div>
                              <div className="font-medium">
                                {[
                                  selectedRegistration.attendee.city,
                                  [selectedRegistration.attendee.state, selectedRegistration.attendee.zipCode]
                                    .filter(Boolean)
                                    .join(" "),
                                  selectedRegistration.attendee.country,
                                ]
                                  .filter(Boolean)
                                  .join(", ")}
                              </div>
                            </div>
                          )}
                        </div>
                      </div>
                    )}
                  </section>
                );
              })()}

              {/* Event Barcode + DTCM Barcode (Details tab only)
                  Previously nested inside the Registration Details section
                  which (along with Payment Summary + Billing Details) was
                  swallowed by a stale Registration-Details closing tag at
                  this position. Now its own section so the Details-tab gate
                  is local to this block and doesn't trap sibling content. */}
              {!isEditing && (
                <section className={cn(
                  "rounded-xl border border-slate-200 bg-white px-5 py-4 space-y-3",
                  activeTab !== "details" && "hidden",
                )}>
                  <h3 className="flex items-center gap-2 text-sm font-semibold uppercase tracking-wide text-slate-700">
                    <Barcode className="h-4 w-4 text-slate-400" />
                    Barcodes
                  </h3>
                  {/* Scannable Code 128 image (byte-identical to the printed
                      badge). Rendered server-side via bwip-js; the endpoint
                      prefers qrCode, falls back to dtcmBarcode. Gated on the
                      value so the endpoint is only hit when a barcode exists. */}
                  {(selectedRegistration.qrCode || selectedRegistration.dtcmBarcode) && (
                    <div className="flex justify-center rounded-lg bg-white border border-slate-200 p-3">
                      {/* `unoptimized` — barcode PNG must bypass Next's image
                          optimizer; re-encoding could blur the bars and break
                          scanning. */}
                      <Image
                        src={`/api/events/${eventId}/registrations/${selectedRegistration.id}/barcode`}
                        alt="Registration barcode"
                        width={320}
                        height={64}
                        unoptimized
                        className="h-16 w-auto max-w-full"
                      />
                    </div>
                  )}
                  <div className={cn("grid gap-3", requiresDtcmBarcode ? "grid-cols-2" : "grid-cols-1")}>
                    <div className="space-y-2">
                      <div className="font-semibold text-sm flex items-center gap-2">
                        <Barcode className="h-4 w-4" />
                        Event Barcode
                      </div>
                      <div className="bg-muted p-3 rounded-lg text-center">
                        {selectedRegistration.qrCode ? (
                          <p className="font-mono text-sm break-all">{selectedRegistration.qrCode}</p>
                        ) : (
                          <p className="text-sm text-muted-foreground italic">Not set</p>
                        )}
                      </div>
                    </div>
                    {/* DTCM barcode tile — Dubai compliance only, shown solely
                        for events flagged requiresDtcmBarcode. */}
                    {requiresDtcmBarcode && (
                      <div className="space-y-2">
                        <div className="font-semibold text-sm flex items-center gap-2">
                          <Barcode className="h-4 w-4" />
                          DTCM Barcode
                        </div>
                        <div className="bg-muted p-3 rounded-lg text-center">
                          {selectedRegistration.dtcmBarcode ? (
                            <p className="font-mono text-sm break-all">{selectedRegistration.dtcmBarcode}</p>
                          ) : (
                            <p className="text-sm text-muted-foreground italic">Not set — usually CSV-imported</p>
                          )}
                        </div>
                      </div>
                    )}
                  </div>
                </section>
              )}

              {/* Print Badge + Download Quote + Send Email (3 buttons in a row) */}
              {!isReviewer && !isEditing && (
                <section className={cn(
                  "rounded-xl border border-slate-200 bg-white px-5 py-4",
                  activeTab !== "activity" && "hidden",
                )}>
                  {/* Desk operators (ONSITE/MEMBER) get Print Badge + Download
                      Quote (they see finance now); Send Email stays admin/
                      organizer, so the grid is 2 cols for them, 3 otherwise. */}
                  <div className={cn("grid gap-2", isDeskOperator ? "grid-cols-2" : "grid-cols-3")}>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={printingBadge}
                    onClick={handlePrintBadge}
                  >
                    {printingBadge ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <IdCard className="mr-2 h-4 w-4" />}
                    Print Badge
                  </Button>
                  <Button variant="outline" size="sm" asChild>
                    <a href={`/api/events/${eventId}/registrations/${selectedRegistration.id}/quote`} download>
                      <Download className="mr-2 h-4 w-4" /> Download Quote
                    </a>
                  </Button>
                  {!isDeskOperator && (
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button size="sm" variant="outline" disabled={sendEmail.isPending}>
                        <Send className="mr-2 h-4 w-4" />
                        {sendEmail.isPending ? "Sending..." : "Send Email"}
                        <ChevronDown className="ml-1 h-3 w-3" />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="start">
                      <DropdownMenuItem onClick={() => openEmailDialog("confirmation")}>
                        Registration Confirmation
                      </DropdownMenuItem>
                      <DropdownMenuItem onClick={() => openEmailDialog("reminder")}>
                        Event Reminder
                      </DropdownMenuItem>
                      <DropdownMenuItem onClick={() => openEmailDialog("payment-reminder")}>
                        Payment Reminder
                      </DropdownMenuItem>
                      <DropdownMenuItem onClick={() => openEmailDialog("custom")}>
                        Custom Notification
                      </DropdownMenuItem>
                      {/* Active saved custom templates — sendable to this one
                          registration via templateSlug (encoded as
                          "template:<slug>" so handleConfirmSendEmail can route
                          it to the templateSlug path). */}
                      {customTemplates.length > 0 && <DropdownMenuSeparator />}
                      {customTemplates.map((t) => (
                        <DropdownMenuItem
                          key={t.slug}
                          onClick={() => openEmailDialog(`${SAVED_TEMPLATE_PREFIX}${t.slug}`)}
                        >
                          {t.name}
                        </DropdownMenuItem>
                      ))}
                      {/* Token-gated completion link — only meaningful for
                          registrations that haven't been linked to a user
                          yet. The action is hidden once the registrant
                          completes (and thus has a userId) because the
                          link they'd get would 410-expire on first access:
                          the route checks for an existing linked user up
                          front. */}
                      {!selectedRegistration.userId && (
                        <DropdownMenuItem
                          onClick={() => setSendFormConfirmOpen(true)}
                        >
                          Send Registration Form
                        </DropdownMenuItem>
                      )}
                    </DropdownMenuContent>
                  </DropdownMenu>
                  )}
                  </div>
                </section>
              )}

              {/* Accommodation */}
              {selectedRegistration.accommodation && (
                <section className={cn(
                  "rounded-xl border border-slate-200 bg-white px-5 py-4 space-y-4",
                  !isEditing && activeTab !== "details" && "hidden",
                )}>
                  <h3 className="flex items-center gap-2 text-sm font-semibold uppercase tracking-wide text-slate-700">
                    <Hotel className="h-4 w-4 text-slate-400" />
                    Accommodation
                  </h3>
                  <div className="bg-slate-50 p-4 rounded-lg">
                    <div className="font-medium">{selectedRegistration.accommodation.roomType.hotel.name}</div>
                    <div className="text-sm text-muted-foreground">{selectedRegistration.accommodation.roomType.name}</div>
                    <div className="text-sm text-muted-foreground mt-1">
                      {formatDate(selectedRegistration.accommodation.checkIn)} - {formatDate(selectedRegistration.accommodation.checkOut)}
                    </div>
                    <Badge variant="outline" className="mt-2">{selectedRegistration.accommodation.status}</Badge>
                  </div>
                </section>
              )}

              {/* Payment History — always rendered in the Billing tab so
                  admins see "No payments recorded yet" instead of an empty
                  tab when nothing's been charged. */}
              {!isEditing && (
                <section className={cn(
                  "rounded-xl border border-slate-200 bg-white px-5 py-4 space-y-4",
                  activeTab !== "billing" && "hidden",
                )}>
                  <h3 className="flex items-center gap-2 text-sm font-semibold uppercase tracking-wide text-slate-700">
                    <CreditCard className="h-4 w-4 text-slate-400" />
                    Payment History
                  </h3>
                  {selectedRegistration.payments && selectedRegistration.payments.length > 0 ? (
                    <>
                      <div className="space-y-2">
                        {selectedRegistration.payments.map((payment) => {
                          // Prefer the Stripe `paidAt` (actual settlement) over `createdAt`
                          // (row-insert time — drifts under webhook retries).
                          const settledAt = payment.paidAt || payment.createdAt;
                          // Card-first instrument label; falls back to the generic
                          // payment_method_details.type (bank_transfer, sepa_debit, etc.).
                          let instrument: string | null = null;
                          if (payment.cardBrand && payment.cardLast4) {
                            const brand = payment.cardBrand.charAt(0).toUpperCase() + payment.cardBrand.slice(1);
                            instrument = `${brand} ending ${payment.cardLast4}`;
                          } else if (payment.paymentMethodType) {
                            instrument = payment.paymentMethodType.replace(/_/g, " ");
                          }
                          // Manual-payment metadata — bank reference, cash recipient,
                          // free-form notes captured by the organizer when recording
                          // the payment offline.
                          const meta = payment.metadata ?? null;
                          const bankReference = meta?.bankReference;
                          const cashReceivedBy = meta?.cashReceivedBy;
                          const paymentNotes = meta?.notes;
                          // For manual transfers `receiptUrl` carries the organizer-
                          // uploaded proof (transfer copy / receipt photo). For Stripe
                          // it's the hosted receipt URL.
                          const proofUrl = payment.receiptUrl;
                          return (
                            <div key={payment.id} className="flex items-start justify-between gap-3 p-3 bg-muted rounded-lg">
                              <div className="min-w-0 flex-1">
                                <div className="font-medium">{formatCurrency(Number(payment.amount), payment.currency)}</div>
                                <div className="text-sm text-muted-foreground">{formatDateTime(settledAt)}</div>
                                {instrument && (
                                  <div className="text-xs text-muted-foreground mt-0.5">
                                    via {instrument}
                                  </div>
                                )}
                                {bankReference && (
                                  <div className="text-xs text-muted-foreground mt-0.5">
                                    Ref: <span className="font-mono">{bankReference}</span>
                                  </div>
                                )}
                                {cashReceivedBy && (
                                  <div className="text-xs text-muted-foreground mt-0.5">
                                    Received by: {cashReceivedBy}
                                  </div>
                                )}
                                {paymentNotes && (
                                  <div className="text-xs text-muted-foreground mt-0.5 italic">
                                    {paymentNotes}
                                  </div>
                                )}
                                {proofUrl && (
                                  <a
                                    href={proofUrl}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    className="inline-flex items-center gap-1 text-xs text-primary hover:underline mt-1"
                                  >
                                    View receipt
                                  </a>
                                )}
                              </div>
                              <Badge variant="outline" className="shrink-0">
                                {payment.status}
                              </Badge>
                            </div>
                          );
                        })}
                      </div>

                      {/* Download Invoice — only meaningful once payment has settled */}
                      {selectedRegistration.paymentStatus === "PAID" && (
                        <div className="pt-2 border-t border-slate-100">
                          <div className="text-xs font-medium text-slate-600 uppercase tracking-wide mb-2">
                            Download
                          </div>
                          <InvoiceDownloadButtons registrationId={selectedRegistration.id} />
                        </div>
                      )}
                      {!isReviewer && selectedRegistration.paymentStatus === "PAID" && (
                        <Button
                          variant="outline"
                          size="sm"
                          className="text-red-600 hover:bg-red-50 hover:text-red-700"
                          disabled={issueRefund.isPending}
                          onClick={handleRefundClick}
                        >
                          {issueRefund.isPending ? (
                            <><Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" /> Processing…</>
                          ) : (
                            <><CreditCard className="mr-2 h-3.5 w-3.5" /> Issue Refund</>
                          )}
                        </Button>
                      )}
                    </>
                  ) : (
                    <p className="text-sm text-muted-foreground italic">
                      No payments recorded yet.
                    </p>
                  )}
                  {/* "Record Manual Payment" — visible whenever the
                      registration could still take a payment record:
                        - any non-PAID, non-COMPLIMENTARY status (UNPAID,
                          PENDING, FAILED, UNASSIGNED, REFUNDED) — the
                          standard path
                        - PAID but with no Payment row yet — admin flipped
                          the dropdown without capturing details, this is
                          the recovery path
                      Hidden when the registration is COMPLIMENTARY (no
                      payment due) or when PAID with at least one Payment
                      row already recorded. */}
                  {!isReviewer &&
                    selectedRegistration.paymentStatus !== "COMPLIMENTARY" &&
                    !(
                      selectedRegistration.paymentStatus === "PAID" &&
                      (selectedRegistration.payments?.length ?? 0) > 0
                    ) && (
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => setRecordPaymentOpen(true)}
                      >
                        <CreditCard className="mr-2 h-3.5 w-3.5" /> Record Manual Payment
                      </Button>
                    )}
                </section>
              )}

              {/* Timeline */}
              <section className={cn(
                "rounded-xl border border-slate-200 bg-white px-5 py-4 space-y-4",
                !isEditing && activeTab !== "activity" && "hidden",
              )}>
                <h3 className="flex items-center gap-2 text-sm font-semibold uppercase tracking-wide text-slate-700">
                  <Calendar className="h-4 w-4 text-slate-400" />
                  Timeline
                </h3>
                <div className="space-y-3">
                  <div className="flex items-center gap-3 text-sm">
                    <Calendar className="h-4 w-4 text-muted-foreground" />
                    <div>
                      <div className="text-muted-foreground">Registered</div>
                      <div className="font-medium">{formatDateTime(selectedRegistration.createdAt)}</div>
                    </div>
                  </div>
                  {selectedRegistration.checkedInAt && (
                    <div className="flex items-center gap-3 text-sm">
                      <CheckCircle className="h-4 w-4 text-green-600" />
                      <div>
                        <div className="text-muted-foreground">Checked In</div>
                        <div className="font-medium">{formatDateTime(selectedRegistration.checkedInAt)}</div>
                      </div>
                    </div>
                  )}
                  {/* Survey completion — a checked box + timestamp when the
                      registrant has submitted the event survey, unchecked
                      otherwise. Read-only; set when they submit the survey. */}
                  <div className="flex items-center gap-3 text-sm">
                    {selectedRegistration.surveyCompletedAt ? (
                      <CheckSquare className="h-4 w-4 text-green-600" />
                    ) : (
                      <Square className="h-4 w-4 text-muted-foreground" />
                    )}
                    <div>
                      <div className="text-muted-foreground">Survey</div>
                      <div className="font-medium">
                        {selectedRegistration.surveyCompletedAt
                          ? `Completed · ${formatDateTime(selectedRegistration.surveyCompletedAt)}`
                          : "Not completed"}
                      </div>
                    </div>
                  </div>
                </div>
              </section>

              {/* Notes — moved to the Details tab so the field lives next
                  to its edit textarea. The Activity tab no longer carries
                  a duplicate copy. */}

              {/* Source / Tracking — entry path is always shown when
                  known (rows pre-dating the column show "Unknown"
                  silently by being null), UTM fields are conditional. */}
              {(selectedRegistration.createdSource || selectedRegistration.referrer || selectedRegistration.utmSource) && (
                <section className={cn(
                  "rounded-xl border border-slate-200 bg-white px-5 py-4 space-y-3",
                  !isEditing && activeTab !== "activity" && "hidden",
                )}>
                  <h3 className="flex items-center gap-2 text-sm font-semibold uppercase tracking-wide text-slate-700">
                    <Radar className="h-4 w-4 text-slate-400" />
                    Source
                  </h3>
                  <div className="space-y-1.5 text-sm">
                    {selectedRegistration.createdSource && (
                      <div className="flex justify-between">
                        <span className="text-muted-foreground">Entry path</span>
                        <span className="font-medium">{formatCreatedSource(selectedRegistration.createdSource)}</span>
                      </div>
                    )}
                    {selectedRegistration.utmSource && (
                      <div className="flex justify-between">
                        <span className="text-muted-foreground">UTM source</span>
                        <span className="font-medium">{selectedRegistration.utmSource}</span>
                      </div>
                    )}
                    {selectedRegistration.utmMedium && (
                      <div className="flex justify-between">
                        <span className="text-muted-foreground">UTM medium</span>
                        <span className="font-medium">{selectedRegistration.utmMedium}</span>
                      </div>
                    )}
                    {selectedRegistration.utmCampaign && (
                      <div className="flex justify-between">
                        <span className="text-muted-foreground">Campaign</span>
                        <span className="font-medium">{selectedRegistration.utmCampaign}</span>
                      </div>
                    )}
                    {selectedRegistration.referrer && (
                      <div className="flex justify-between">
                        <span className="text-muted-foreground">Referrer</span>
                        <span className="font-medium text-xs truncate max-w-[200px]">{selectedRegistration.referrer}</span>
                      </div>
                    )}
                  </div>
                </section>
              )}

              {/* ── Activity tab: certificates (with actions) + timeline ── */}
              {/* The IssuedCertificatesCard (with Resend/Revoke actions) mounts
                  above the unified ActivityTimelineCard so "did the cert go
                  out?" — the most common attendee question — is the first
                  thing the operator sees. The timeline below is the
                  chronological view (audit + email + certs, with Open). Both
                  reuse the same registrationId the sheet is rendered against. */}
              <div className={cn("space-y-4", !isEditing && activeTab !== "activity" && "hidden")}>
                <IssuedCertificatesCard
                  eventId={eventId}
                  registrationId={selectedRegistration.id}
                  recipientLabel={
                    selectedRegistration.attendee
                      ? `${[
                          selectedRegistration.attendee.title,
                          selectedRegistration.attendee.firstName,
                          selectedRegistration.attendee.lastName,
                        ]
                          .filter(Boolean)
                          .join(" ")} <${selectedRegistration.attendee.email}>`
                      : undefined
                  }
                />
                {/* Unified activity timeline — subsumes the email-history card
                    (includes emails) and adds AuditLog events, issued
                    certificates (with Open), and — if this attendee is also a
                    speaker — the linked speaker's activity (pointed, not
                    duplicated). Same feed the speaker page shows. */}
                <ActivityTimelineCard
                  endpoint={`/api/events/${eventId}/registrations/${selectedRegistration.id}/activity`}
                  anchor="registration"
                  queryKey={[eventId, "registration", selectedRegistration.id]}
                />
              </div>
            </div>
          </>
        ) : null}
      </SheetContent>
    </Sheet>

    {/* Email confirmation dialog */}
    <Dialog open={emailConfirmOpen} onOpenChange={setEmailConfirmOpen}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Send Email</DialogTitle>
          <DialogDescription asChild>
            <span>
              Send <strong>{selectedEmailLabel}</strong> to{" "}
              {selectedRegistration ? formatPersonName(
                selectedRegistration.attendee?.title,
                selectedRegistration.attendee?.firstName || "",
                selectedRegistration.attendee?.lastName || ""
              ) : "recipient"}
              {selectedRegistration?.attendee?.email && ` (${selectedRegistration.attendee.email})`}
            </span>
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={() => setEmailConfirmOpen(false)}>
            Cancel
          </Button>
          <Button variant="outline" onClick={handlePreviewRegistrationEmail} disabled={previewMutation.isPending}>
            {previewMutation.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Eye className="mr-2 h-4 w-4" />}
            Preview
          </Button>
          <Button
            onClick={handleConfirmSendEmail}
            disabled={sendEmail.isPending}
          >
            <Send className="mr-2 h-4 w-4" />
            Send
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

    {/* Token-gated registration-completion link send. Shared rate-limit
        bucket with the bulk-list-page action (5/hr per org). */}
    {selectedRegistration && (
      <Dialog open={sendFormConfirmOpen} onOpenChange={setSendFormConfirmOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Send registration form</DialogTitle>
            <DialogDescription>
              {selectedRegistration.attendee.firstName} will receive an email with
              a 7-day token link to fill in their own details and create an
              account.
            </DialogDescription>
          </DialogHeader>
          <div className="text-sm text-muted-foreground">
            Sending to{" "}
            <span className="font-medium text-foreground">
              {selectedRegistration.attendee.email}
            </span>
            . This counts against the 5-per-hour bulk-send limit.
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setSendFormConfirmOpen(false)}
              disabled={sendCompletionEmails.isPending}
            >
              Cancel
            </Button>
            <Button
              onClick={async () => {
                try {
                  const result = await sendCompletionEmails.mutateAsync([
                    selectedRegistration.id,
                  ]);
                  setSendFormConfirmOpen(false);
                  if (result.sent > 0) {
                    toast.success(
                      `Registration form sent to ${selectedRegistration.attendee.email}`,
                    );
                  } else if (result.skipped > 0) {
                    toast.info(
                      "Skipped — this registrant already has a linked account",
                    );
                  } else {
                    toast.error(result.errors[0] ?? "Send failed");
                  }
                } catch (err) {
                  const msg = err instanceof Error ? err.message : "Send failed";
                  toast.error(msg);
                }
              }}
              disabled={sendCompletionEmails.isPending}
            >
              {sendCompletionEmails.isPending ? "Sending..." : "Send"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    )}

    {selectedRegistration && (
      <>
        <ChangeEmailDialog
          open={changeEmailOpen}
          onOpenChange={setChangeEmailOpen}
          currentEmail={selectedRegistration.attendee.email}
          endpoint={`/api/events/${eventId}/registrations/${selectedRegistration.id}/email`}
          entityLabel="registration"
          onSuccess={() => {
            queryClient.invalidateQueries({ queryKey: queryKeys.registrations(eventId) });
          }}
        />
        <RecordPaymentDialog
          open={recordPaymentOpen}
          onOpenChange={setRecordPaymentOpen}
          eventId={eventId}
          registrationId={selectedRegistration.id}
          defaultAmount={Number(
            selectedRegistration.pricingTier?.price ??
              selectedRegistration.ticketType?.price ??
              0,
          )}
          defaultCurrency={
            selectedRegistration.pricingTier?.currency ??
            selectedRegistration.ticketType?.currency ??
            "USD"
          }
          onRecorded={() => {
            // Refresh the list so the row reflects PAID and Payment
            // History gets the new row + the Invoice download appears.
            queryClient.invalidateQueries({ queryKey: queryKeys.registrations(eventId) });
          }}
        />
      </>
    )}
    </>
  );
}
