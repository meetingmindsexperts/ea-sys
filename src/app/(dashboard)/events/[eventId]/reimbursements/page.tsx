"use client";

/**
 * Speaker reimbursements — organizer console (v1: submission-only).
 *
 * Invite the event's speakers to complete the web reimbursement form
 * (personalized token link), track who has submitted, review each
 * submission (claim lines, bank transfer details, uploaded receipts),
 * export CSV for finance, and reopen a submitted form for corrections.
 *
 * ACCESS: SUPER_ADMIN / ADMIN / ORGANIZER only (wire-transfer PII). The
 * APIs enforce it server-side; this page mirrors the gate client-side via
 * canManageReimbursements so restricted roles see a notice, not errors.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import { useSession } from "next-auth/react";
import {
  Banknote,
  Check,
  Copy,
  Download,
  Eye,
  FileText,
  Loader2,
  PenLine,
  Plus,
  RotateCcw,
  Send,
  Trash2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import { Card, CardContent } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { EmailPreviewDialog } from "@/components/email-preview-dialog";
import { useEmailTemplates, useEvent, usePreviewEmailBySlug, useSpeakers } from "@/hooks/use-api";
import { formatPersonName } from "@/lib/utils";
import {
  canManageReimbursements,
  claimItemLabel,
  documentKindLabel,
  formatClaimTotals,
  type BankDetails,
  type ClaimLine,
} from "@/lib/reimbursement/constants";
import { toast } from "sonner";

interface DocumentRow {
  id: string;
  kind: string;
  filename: string;
  size: number;
  createdAt: string;
}
interface ReimbursementRow {
  id: string;
  speakerId: string;
  token: string;
  status: "PENDING" | "SUBMITTED";
  fullName: string | null;
  email: string | null;
  country: string | null;
  nationality: string | null;
  passportNumber: string | null;
  roleAtEvent: string | null;
  claimLines: ClaimLine[] | null;
  bankDetails: (BankDetails & Record<string, string | null>) | null;
  signedName: string | null;
  submittedAt: string | null;
  createdAt: string;
  speaker: {
    id: string;
    title: string | null;
    firstName: string;
    lastName: string;
    email: string;
  };
  documents: DocumentRow[];
}

const BANK_FIELD_LABELS: [keyof BankDetails, string][] = [
  ["beneficiaryName", "Beneficiary Name"],
  ["beneficiaryAddress", "Beneficiary Address"],
  ["bankName", "Bank Name"],
  ["bankAddress", "Bank Address"],
  ["bankCountry", "Bank Country"],
  ["accountNumber", "Account Number"],
  ["iban", "IBAN"],
  ["swift", "SWIFT / BIC"],
  ["routingNumber", "Routing Number"],
  ["sortCode", "SORT Code"],
  ["intermediaryBank", "Intermediary Bank"],
];

export default function ReimbursementsPage() {
  const { eventId } = useParams<{ eventId: string }>();
  const { data: session } = useSession();
  const { data: event } = useEvent(eventId);
  const { data: speakers = [] } = useSpeakers(eventId);

  const [rows, setRows] = useState<ReimbursementRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [addOpen, setAddOpen] = useState(false);
  const [selectedSpeakerIds, setSelectedSpeakerIds] = useState<Set<string>>(new Set());
  const [speakerSearch, setSpeakerSearch] = useState("");
  const [adding, setAdding] = useState(false);
  const [sendOpen, setSendOpen] = useState(false);
  const [sendTarget, setSendTarget] = useState<"pending" | "all">("pending");
  const [sendSubject, setSendSubject] = useState("");
  const [sendMessage, setSendMessage] = useState("");
  const [sending, setSending] = useState(false);
  const [detail, setDetail] = useState<ReimbursementRow | null>(null);
  const [busyRowId, setBusyRowId] = useState<string | null>(null);
  const previewMutation = usePreviewEmailBySlug(eventId);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [previewData, setPreviewData] = useState<{ subject: string; htmlContent: string } | null>(
    null,
  );
  // The templates list GET auto-seeds every system default as an editable
  // per-event row, so the invitation template always has a deep-linkable id.
  const { data: templatesData } = useEmailTemplates(eventId);
  const invitationTemplateId = useMemo(
    () =>
      (templatesData?.templates as { id: string; slug: string }[] | undefined)?.find(
        (t) => t.slug === "speaker-reimbursement-invitation",
      )?.id ?? null,
    [templatesData],
  );

  const role = session?.user?.role;
  const allowed = canManageReimbursements(role);

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/events/${eventId}/reimbursements`);
      const json = await res.json();
      if (!res.ok) {
        console.error("reimbursements:load-failed", res.status, json?.error);
        toast.error(json?.error || "Failed to load reimbursements");
        return;
      }
      setRows(json.reimbursements);
    } catch (err) {
      console.error("reimbursements:load-error", err);
      toast.error("Failed to load reimbursements");
    } finally {
      setLoading(false);
    }
  }, [eventId]);

  useEffect(() => {
    if (allowed) void load();
    else setLoading(false);
  }, [allowed, load]);

  const invitedSpeakerIds = useMemo(() => new Set(rows.map((r) => r.speakerId)), [rows]);
  const addableSpeakers = useMemo(() => {
    const q = speakerSearch.trim().toLowerCase();
    return (speakers as { id: string; title?: string | null; firstName: string; lastName: string; email: string }[])
      .filter((s) => !invitedSpeakerIds.has(s.id))
      .filter(
        (s) =>
          !q ||
          `${s.firstName} ${s.lastName}`.toLowerCase().includes(q) ||
          s.email.toLowerCase().includes(q),
      );
  }, [speakers, invitedSpeakerIds, speakerSearch]);

  const pendingCount = rows.filter((r) => r.status === "PENDING").length;

  const handleAdd = useCallback(async () => {
    if (selectedSpeakerIds.size === 0) return;
    setAdding(true);
    try {
      const res = await fetch(`/api/events/${eventId}/reimbursements`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ speakerIds: [...selectedSpeakerIds] }),
      });
      const json = await res.json();
      if (!res.ok) {
        console.error("reimbursements:add-failed", res.status, json?.error);
        toast.error(json?.error || "Failed to add speakers");
        return;
      }
      toast.success(`Added ${json.created} speaker${json.created === 1 ? "" : "s"}`);
      setAddOpen(false);
      setSelectedSpeakerIds(new Set());
      await load();
    } catch (err) {
      console.error("reimbursements:add-error", err);
      toast.error("Failed to add speakers");
    } finally {
      setAdding(false);
    }
  }, [eventId, selectedSpeakerIds, load]);

  const handleSend = useCallback(
    async (reimbursementId?: string) => {
      setSending(true);
      if (reimbursementId) setBusyRowId(reimbursementId);
      try {
        const res = await fetch(`/api/events/${eventId}/reimbursements/send`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(
            reimbursementId
              ? { reimbursementId }
              : {
                  target: sendTarget,
                  subject: sendSubject.trim() || undefined,
                  message: sendMessage.trim() || undefined,
                },
          ),
        });
        const json = await res.json();
        if (!res.ok) {
          console.error("reimbursements:send-failed", res.status, json?.error);
          toast.error(json?.error || "Failed to send");
          return;
        }
        if (json.failed > 0) {
          toast.error(`Sent ${json.sent}, ${json.failed} failed`);
        } else if (json.sent === 0) {
          toast.info(json.message || "Nothing to send");
        } else {
          toast.success(`Sent ${json.sent} email${json.sent === 1 ? "" : "s"}`);
        }
        setSendOpen(false);
      } catch (err) {
        console.error("reimbursements:send-error", err);
        toast.error("Failed to send");
      } finally {
        setSending(false);
        setBusyRowId(null);
      }
    },
    [eventId, sendTarget, sendSubject, sendMessage],
  );

  // Renders exactly what the send would produce — the (possibly organizer-
  // edited) template + the typed subject/message overrides, with real event
  // branding + sample per-recipient values.
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
      console.error("reimbursements:preview-error", err);
      toast.error(err instanceof Error ? err.message : "Failed to generate preview");
    }
  }, [previewMutation, sendSubject, sendMessage]);

  const handleCopyLink = useCallback(
    async (row: ReimbursementRow) => {
      if (!event?.slug) {
        toast.error("Event details are still loading — try again in a moment.");
        return;
      }
      const url = `${window.location.origin}/e/${event.slug}/reimbursement/${row.token}`;
      try {
        await navigator.clipboard.writeText(url);
        toast.success("Link copied");
      } catch (err) {
        console.error("reimbursements:copy-failed", err);
        toast.error("Couldn't copy the link");
      }
    },
    [event?.slug],
  );

  const handleReopen = useCallback(
    async (row: ReimbursementRow) => {
      if (
        !window.confirm(
          "Reopen this submitted form so the speaker can edit and resubmit it? Finance should not process it until it is resubmitted.",
        )
      )
        return;
      setBusyRowId(row.id);
      try {
        const res = await fetch(`/api/events/${eventId}/reimbursements/${row.id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "reopen" }),
        });
        const json = await res.json();
        if (!res.ok) {
          console.error("reimbursements:reopen-failed", res.status, json?.error);
          toast.error(json?.error || "Failed to reopen");
          return;
        }
        toast.success("Form reopened for edits");
        setDetail(null);
        await load();
      } catch (err) {
        console.error("reimbursements:reopen-error", err);
        toast.error("Failed to reopen");
      } finally {
        setBusyRowId(null);
      }
    },
    [eventId, load],
  );

  const handleDelete = useCallback(
    async (row: ReimbursementRow) => {
      const label = `${row.speaker.firstName} ${row.speaker.lastName}`;
      if (
        !window.confirm(
          row.status === "SUBMITTED"
            ? `Delete ${label}'s SUBMITTED reimbursement, including uploaded documents? This cannot be undone.`
            : `Remove the reimbursement invite for ${label}?`,
        )
      )
        return;
      setBusyRowId(row.id);
      try {
        const res = await fetch(`/api/events/${eventId}/reimbursements/${row.id}`, {
          method: "DELETE",
        });
        const json = await res.json();
        if (!res.ok) {
          console.error("reimbursements:delete-failed", res.status, json?.error);
          toast.error(json?.error || "Failed to delete");
          return;
        }
        toast.success("Removed");
        setDetail(null);
        await load();
      } catch (err) {
        console.error("reimbursements:delete-error", err);
        toast.error("Failed to delete");
      } finally {
        setBusyRowId(null);
      }
    },
    [eventId, load],
  );

  if (!allowed) {
    return (
      <div className="container max-w-4xl py-8">
        <Card>
          <CardContent className="py-12 text-center text-muted-foreground">
            <Banknote className="h-10 w-10 mx-auto mb-3 opacity-40" />
            <p className="font-medium text-foreground mb-1">Restricted area</p>
            <p className="text-sm">
              Speaker reimbursements contain bank transfer details and passport data. Only
              administrators and organizers can view this page.
            </p>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="container max-w-6xl py-8">
      <div className="flex flex-wrap items-start justify-between gap-4 mb-6">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <Banknote className="h-6 w-6 text-emerald-600" />
            Speaker Reimbursements
          </h1>
          <p className="text-muted-foreground mt-1 max-w-2xl">
            Send speakers a personalized link to claim their speaker fee, flights, hotel and
            transport. Receipts and bank details are collected online — export the CSV for
            finance once forms come in.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" size="sm" asChild>
            <a href={`/api/events/${eventId}/reimbursements?export=csv`}>
              <Download className="h-4 w-4 mr-1" /> Export CSV
            </a>
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => setSendOpen(true)}
            disabled={rows.length === 0}
          >
            <Send className="h-4 w-4 mr-1" /> Email links
          </Button>
          <Button size="sm" onClick={() => setAddOpen(true)}>
            <Plus className="h-4 w-4 mr-1" /> Add speakers
          </Button>
        </div>
      </div>

      {loading ? (
        <div className="py-16 text-center text-muted-foreground">
          <Loader2 className="h-6 w-6 mx-auto animate-spin" />
        </div>
      ) : rows.length === 0 ? (
        <Card>
          <CardContent className="py-12 text-center text-muted-foreground">
            <Banknote className="h-10 w-10 mx-auto mb-3 opacity-40" />
            <p className="font-medium text-foreground mb-1">No reimbursement invites yet</p>
            <p className="text-sm mb-4">
              Add speakers to mint their personalized form links, then email them in one click.
            </p>
            <Button size="sm" onClick={() => setAddOpen(true)}>
              <Plus className="h-4 w-4 mr-1" /> Add speakers
            </Button>
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardContent className="p-0">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b text-left text-muted-foreground">
                    <th className="px-4 py-3 font-medium">Speaker</th>
                    <th className="px-4 py-3 font-medium">Status</th>
                    <th className="px-4 py-3 font-medium">Submitted</th>
                    <th className="px-4 py-3 font-medium">Total claimed</th>
                    <th className="px-4 py-3 font-medium">Docs</th>
                    <th className="px-4 py-3 font-medium text-right">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => {
                    const busy = busyRowId === row.id;
                    return (
                      <tr key={row.id} className="border-b last:border-0 hover:bg-muted/40">
                        <td className="px-4 py-3">
                          <div className="font-medium">
                            {formatPersonName(row.speaker.title, row.speaker.firstName, row.speaker.lastName)}
                          </div>
                          <div className="text-xs text-muted-foreground">{row.speaker.email}</div>
                        </td>
                        <td className="px-4 py-3">
                          {row.status === "SUBMITTED" ? (
                            <span className="inline-flex items-center gap-1 rounded-full bg-emerald-50 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300 px-2 py-0.5 text-xs font-medium">
                              <Check className="h-3 w-3" /> Submitted
                            </span>
                          ) : (
                            <span className="inline-flex items-center rounded-full bg-amber-50 text-amber-700 dark:bg-amber-950 dark:text-amber-300 px-2 py-0.5 text-xs font-medium">
                              Pending
                            </span>
                          )}
                        </td>
                        <td className="px-4 py-3 text-muted-foreground">
                          {row.submittedAt ? new Date(row.submittedAt).toLocaleDateString() : "—"}
                        </td>
                        <td className="px-4 py-3 tabular-nums">
                          {row.claimLines?.length ? formatClaimTotals(row.claimLines) : "—"}
                        </td>
                        <td className="px-4 py-3 text-muted-foreground">
                          {row.documents.length || "—"}
                        </td>
                        <td className="px-4 py-3">
                          <div className="flex items-center justify-end gap-1">
                            <Button
                              variant="ghost"
                              size="icon"
                              title="Copy the speaker's personal link"
                              onClick={() => void handleCopyLink(row)}
                            >
                              <Copy className="h-4 w-4" />
                            </Button>
                            <Button
                              variant="ghost"
                              size="icon"
                              title="Email the link to this speaker"
                              disabled={busy}
                              onClick={() => void handleSend(row.id)}
                            >
                              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
                            </Button>
                            <Button
                              variant="ghost"
                              size="icon"
                              title="View submission"
                              onClick={() => setDetail(row)}
                            >
                              <Eye className="h-4 w-4" />
                            </Button>
                            {row.status === "SUBMITTED" && (
                              <Button
                                variant="ghost"
                                size="icon"
                                title="Reopen for edits"
                                disabled={busy}
                                onClick={() => void handleReopen(row)}
                              >
                                <RotateCcw className="h-4 w-4" />
                              </Button>
                            )}
                            <Button
                              variant="ghost"
                              size="icon"
                              title="Delete"
                              disabled={busy}
                              onClick={() => void handleDelete(row)}
                            >
                              <Trash2 className="h-4 w-4 text-destructive" />
                            </Button>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Add speakers */}
      <Dialog open={addOpen} onOpenChange={setAddOpen}>
        <DialogContent className="sm:max-w-xl">
          <DialogHeader>
            <DialogTitle>Add speakers</DialogTitle>
          </DialogHeader>
          <Input
            placeholder="Search speakers…"
            value={speakerSearch}
            onChange={(e) => setSpeakerSearch(e.target.value)}
          />
          <div className="max-h-72 overflow-y-auto border rounded-md divide-y">
            {addableSpeakers.length === 0 ? (
              <p className="p-4 text-sm text-muted-foreground">
                {speakers.length === 0
                  ? "This event has no speakers yet."
                  : "Every matching speaker already has a reimbursement invite."}
              </p>
            ) : (
              addableSpeakers.map((s) => {
                const checked = selectedSpeakerIds.has(s.id);
                return (
                  <label
                    key={s.id}
                    className="flex items-center gap-3 px-3 py-2 cursor-pointer hover:bg-muted/40"
                  >
                    <Checkbox
                      checked={checked}
                      onCheckedChange={(v) => {
                        setSelectedSpeakerIds((prev) => {
                          const next = new Set(prev);
                          if (v) next.add(s.id);
                          else next.delete(s.id);
                          return next;
                        });
                      }}
                    />
                    <span className="flex-1">
                      <span className="block text-sm font-medium">
                        {formatPersonName(s.title, s.firstName, s.lastName)}
                      </span>
                      <span className="block text-xs text-muted-foreground">{s.email}</span>
                    </span>
                  </label>
                );
              })
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setAddOpen(false)}>
              Cancel
            </Button>
            <Button onClick={() => void handleAdd()} disabled={adding || selectedSpeakerIds.size === 0}>
              {adding && <Loader2 className="h-4 w-4 mr-1 animate-spin" />}
              Add {selectedSpeakerIds.size || ""} selected
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Email links */}
      <Dialog open={sendOpen} onOpenChange={setSendOpen}>
        <DialogContent className="sm:max-w-xl">
          <DialogHeader>
            <DialogTitle>Email reimbursement links</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            Each speaker receives their own personalized link, using the{" "}
            <strong>Speaker Reimbursement Form</strong> email template.{" "}
            {invitationTemplateId ? (
              <Link
                href={`/events/${eventId}/communications/templates/${invitationTemplateId}`}
                target="_blank"
                className="inline-flex items-center gap-1 text-primary hover:underline"
              >
                <PenLine className="h-3.5 w-3.5" /> Edit the template
              </Link>
            ) : (
              <span>Edit it under Communications → Email Templates.</span>
            )}{" "}
            <span>(opens in a new tab — your draft here is kept)</span>
          </p>
          <div className="space-y-3">
            <div className="flex gap-2">
              <Button
                type="button"
                variant={sendTarget === "pending" ? "default" : "outline"}
                size="sm"
                onClick={() => setSendTarget("pending")}
              >
                Not yet submitted ({pendingCount})
              </Button>
              <Button
                type="button"
                variant={sendTarget === "all" ? "default" : "outline"}
                size="sm"
                onClick={() => setSendTarget("all")}
              >
                Everyone ({rows.length})
              </Button>
            </div>
            <div>
              <Label htmlFor="reimb-subject">Subject (optional override)</Label>
              <Input
                id="reimb-subject"
                value={sendSubject}
                onChange={(e) => setSendSubject(e.target.value)}
                placeholder="Reimbursement form — …"
              />
            </div>
            <div>
              <Label htmlFor="reimb-message">Personal message (optional)</Label>
              <Textarea
                id="reimb-message"
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
              <Button onClick={() => void handleSend()} disabled={sending}>
                {sending && <Loader2 className="h-4 w-4 mr-1 animate-spin" />}
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

      {/* Detail */}
      <Dialog open={!!detail} onOpenChange={(open) => !open && setDetail(null)}>
        <DialogContent className="sm:max-w-2xl max-h-[85vh] overflow-y-auto">
          {detail && (
            <>
              <DialogHeader>
                <DialogTitle>
                  {formatPersonName(detail.speaker.title, detail.speaker.firstName, detail.speaker.lastName)}
                </DialogTitle>
              </DialogHeader>
              {detail.status !== "SUBMITTED" ? (
                <p className="text-sm text-muted-foreground">
                  Not submitted yet. Copy or email the speaker their personal link to fill the
                  form.
                </p>
              ) : (
                <div className="space-y-5 text-sm">
                  <section>
                    <h3 className="font-semibold mb-2">Speaker / Faculty details</h3>
                    <div className="grid grid-cols-2 gap-x-6 gap-y-1.5">
                      <Detail label="Full name (passport)" value={detail.fullName} />
                      <Detail label="Email" value={detail.email} />
                      <Detail label="Country" value={detail.country} />
                      <Detail label="Nationality" value={detail.nationality} />
                      <Detail label="Passport number" value={detail.passportNumber} />
                      <Detail label="Role at event" value={detail.roleAtEvent} />
                    </div>
                  </section>
                  <section>
                    <h3 className="font-semibold mb-2">Claim</h3>
                    <table className="w-full">
                      <tbody>
                        {(detail.claimLines ?? []).map((l, i) => (
                          <tr key={i} className="border-b last:border-0">
                            <td className="py-1.5 text-muted-foreground">{claimItemLabel(l.item)}</td>
                            <td className="py-1.5 text-right tabular-nums">
                              {l.currency}{" "}
                              {l.amount.toLocaleString("en-US", {
                                minimumFractionDigits: 2,
                                maximumFractionDigits: 2,
                              })}
                            </td>
                          </tr>
                        ))}
                        <tr>
                          <td className="py-1.5 font-semibold">Total</td>
                          <td className="py-1.5 text-right font-semibold tabular-nums">
                            {detail.claimLines?.length ? formatClaimTotals(detail.claimLines) : "—"}
                          </td>
                        </tr>
                      </tbody>
                    </table>
                  </section>
                  <section>
                    <h3 className="font-semibold mb-2">Bank transfer details</h3>
                    <div className="grid grid-cols-2 gap-x-6 gap-y-1.5">
                      {BANK_FIELD_LABELS.map(([key, label]) => (
                        <Detail key={key} label={label} value={detail.bankDetails?.[key] ?? null} />
                      ))}
                    </div>
                  </section>
                  <section>
                    <h3 className="font-semibold mb-2">Documents</h3>
                    {detail.documents.length === 0 ? (
                      <p className="text-muted-foreground">None uploaded.</p>
                    ) : (
                      <ul className="space-y-1.5">
                        {detail.documents.map((doc) => (
                          <li key={doc.id}>
                            <a
                              href={`/api/events/${eventId}/reimbursements/${detail.id}/documents/${doc.id}`}
                              target="_blank"
                              rel="noreferrer"
                              className="inline-flex items-center gap-2 text-primary hover:underline"
                            >
                              <FileText className="h-4 w-4" />
                              {documentKindLabel(doc.kind)}
                              <span className="text-xs text-muted-foreground">
                                {doc.filename} · {(doc.size / 1024).toFixed(0)} KB
                              </span>
                            </a>
                          </li>
                        ))}
                      </ul>
                    )}
                  </section>
                  <section className="text-muted-foreground">
                    Signed <span className="font-medium text-foreground">{detail.signedName}</span>{" "}
                    on{" "}
                    {detail.submittedAt
                      ? new Date(detail.submittedAt).toLocaleString()
                      : "—"}
                  </section>
                  <div className="flex justify-end">
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={busyRowId === detail.id}
                      onClick={() => void handleReopen(detail)}
                    >
                      <RotateCcw className="h-4 w-4 mr-1" /> Reopen for edits
                    </Button>
                  </div>
                </div>
              )}
            </>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}

function Detail({ label, value }: { label: string; value: string | null | undefined }) {
  return (
    <div>
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="font-medium break-words">{value || "—"}</div>
    </div>
  );
}
