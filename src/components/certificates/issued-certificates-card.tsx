"use client";

/**
 * IssuedCertificatesCard — per-recipient cert activity panel.
 *
 * Mounted above the EmailLogCard on the registration detail sheet AND
 * on the speaker detail page. Same component, same shape; the parent
 * passes EITHER registrationId OR speakerId (exactly one). The card
 * lists the certs already issued for that recipient with serial,
 * issued/last-sent dates, send count, and per-row [Open] (opens the
 * cert PDF inline in a new tab) + [Resend] actions.
 *
 * The Resend button opens a confirm dialog so a fat-finger click can't
 * spam the recipient — and because resend is a real outbound email,
 * not a click-undo affordance.
 *
 * Auth: parent surfaces are already org-scoped; this card relies on
 * the underlying API to refuse cross-tenant access (404 on miss).
 * Visibility-wise the card renders for everyone the parent shows —
 * the Resend button is the one that the API's denyReviewer guard
 * actually gates.
 */

import { useState } from "react";
import { formatDistanceToNow } from "date-fns";
import {
  Award,
  ExternalLink,
  Loader2,
  AlertCircle,
  Mail,
  Send,
  XCircle,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { toast } from "sonner";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Plus } from "lucide-react";
import {
  useIssuedCertificates,
  useReissueCertificate,
  useResendCertificateBundle,
  useIssueSingleCertificate,
  useCertificateTemplates,
  type IssuedCertificateRow,
} from "@/hooks/use-api";

interface IssuedCertificatesCardProps {
  eventId: string;
  /** Pass EXACTLY one of these. Card will error-state if neither is set. */
  registrationId?: string;
  speakerId?: string;
  /** Display name shown in the resend confirm dialog. Falls back to "the recipient". */
  recipientLabel?: string;
}

export function IssuedCertificatesCard({
  eventId,
  registrationId,
  speakerId,
  recipientLabel,
}: IssuedCertificatesCardProps) {
  const { data, isLoading, isError } = useIssuedCertificates({
    eventId,
    registrationId,
    speakerId,
  });

  const resendMutation = useReissueCertificate(eventId);

  // Confirm dialog state — single cert at a time. We track the whole
  // row (not just id) so the dialog can show the cert's type + serial
  // without re-fetching.
  const [confirmCert, setConfirmCert] = useState<IssuedCertificateRow | null>(null);

  // "Resend all" flow — re-sends every resendable cert this person holds as
  // ONE email with one PDF per cert (frozen PDFs, resend semantics — the
  // per-row Resend is the re-render-from-latest path).
  const [resendAllOpen, setResendAllOpen] = useState(false);
  const resendBundleMutation = useResendCertificateBundle(eventId);
  const resendAllBusy = resendBundleMutation.isPending;

  const certificates = data?.certificates ?? [];
  // Only non-revoked, rendered certs can be (re)sent.
  const resendableCerts = certificates.filter((c) => !c.revokedAt && c.pdfUrl);

  // ── On-demand single issue ──
  const issueMutation = useIssueSingleCertificate(eventId);
  const [issueOpen, setIssueOpen] = useState(false);
  const [selectedTemplateId, setSelectedTemplateId] = useState("");
  // A registration card issues ATTENDANCE templates; a speaker card issues
  // APPRECIATION ones (the facet the recipient can hold).
  const facetCategory = speakerId ? "APPRECIATION" : "ATTENDANCE";
  const { data: templatesData } = useCertificateTemplates(eventId, issueOpen);
  const issuableTemplates = (templatesData?.templates ?? []).filter((t) => t.category === facetCategory);

  async function handleIssue() {
    if (!selectedTemplateId) return;
    try {
      const body = registrationId
        ? { templateId: selectedTemplateId, registrationId }
        : { templateId: selectedTemplateId, speakerId };
      const res = await issueMutation.mutateAsync(body);
      toast.success(`Issued & emailed certificate ${res.serial} to ${res.recipientEmail}`);
      setIssueOpen(false);
      setSelectedTemplateId("");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to issue certificate");
    }
  }

  async function handleResendAll() {
    if (resendableCerts.length === 0) return;
    try {
      const res = await resendBundleMutation.mutateAsync(
        registrationId ? { registrationId } : { speakerId },
      );
      setResendAllOpen(false);
      toast.success(
        `Re-sent ${res.sentCount} certificate${res.sentCount === 1 ? "" : "s"} to ${res.recipientEmail} in one email`,
      );
    } catch (e) {
      // Leave the dialog open so the operator can retry.
      toast.error(e instanceof Error ? e.message : "Resend failed");
    }
  }

  async function handleResend(cert: IssuedCertificateRow) {
    try {
      const result = await resendMutation.mutateAsync(cert.id);
      const category = cert.type === "ATTENDANCE" ? "attendance" : "appreciation";
      // Reissue re-renders from the CURRENT template (so template/greeting
      // edits propagate) and re-sends — not a replay of the frozen original.
      toast.success(`Re-rendered the ${category} certificate from the latest template and re-sent to ${result.recipientEmail}`);
      setConfirmCert(null);
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Resend failed";
      toast.error(msg);
      // Leave the dialog open on failure — the operator may want to
      // retry without re-clicking the row's button.
    }
  }

  // No id supplied — a developer wiring bug. Surface it loudly in dev,
  // but never ship the amber sentinel panel to a real user in prod
  // (render nothing instead).
  if (!registrationId && !speakerId) {
    if (process.env.NODE_ENV !== "development") return null;
    return (
      <div className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
        IssuedCertificatesCard: pass registrationId OR speakerId.
      </div>
    );
  }

  return (
    <div className="rounded-lg border border-slate-200 bg-white p-4">
      <div className="flex items-center gap-2 mb-3">
        <Award className="h-4 w-4 text-amber-600" />
        <h3 className="text-sm font-semibold text-slate-800">Certificates</h3>
        {certificates.length > 0 && (
          <span className="text-xs text-slate-400">({certificates.length})</span>
        )}
        <div className="ml-auto flex items-center gap-1.5">
          <Button
            size="sm"
            variant="outline"
            className="h-7 px-2 text-xs"
            onClick={() => setIssueOpen(true)}
            disabled={issueMutation.isPending}
            title="Issue a certificate template to this person"
          >
            <Plus className="h-3.5 w-3.5 mr-1" />
            Issue certificate
          </Button>
          {resendableCerts.length >= 2 && (
            <Button
              size="sm"
              variant="outline"
              className="h-7 px-2 text-xs"
              onClick={() => setResendAllOpen(true)}
              disabled={resendAllBusy}
              title="Re-render + resend every certificate this person holds"
            >
              {resendAllBusy ? (
                <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" />
              ) : (
                <Send className="h-3.5 w-3.5 mr-1" />
              )}
              Resend all ({resendableCerts.length})
            </Button>
          )}
        </div>
      </div>

      {isLoading && (
        <div className="flex items-center gap-2 text-sm text-slate-400">
          <Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading…
        </div>
      )}

      {isError && (
        <div className="flex items-center gap-2 text-sm text-red-500">
          <AlertCircle className="h-3.5 w-3.5" /> Couldn&apos;t load certificates.
        </div>
      )}

      {!isLoading && !isError && certificates.length === 0 && (
        <p className="text-sm text-slate-400">
          No certificates issued yet for this {speakerId ? "speaker" : "registration"}.
        </p>
      )}

      {certificates.length > 0 && (
        <ul className="divide-y divide-slate-100">
          {certificates.map((cert) => (
            <CertRow
              key={cert.id}
              cert={cert}
              isResending={
                resendMutation.isPending &&
                resendMutation.variables === cert.id
              }
              onResend={() => setConfirmCert(cert)}
            />
          ))}
        </ul>
      )}

      {/* Confirm dialog — single-instance, swap target via confirmCert. */}
      <Dialog open={!!confirmCert} onOpenChange={(open) => !open && setConfirmCert(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Mail className="h-4 w-4" />
              Resend latest version
            </DialogTitle>
            <DialogDescription>
              This re-renders the certificate from the <strong>current</strong>{" "}
              template (picking up any design or cover-email edits) and emails it
              again. The serial stays the same; the PDF is refreshed.
            </DialogDescription>
          </DialogHeader>
          {confirmCert && (
            <div className="space-y-3 text-sm">
              <div className="rounded-md border border-slate-200 bg-slate-50 p-3">
                <div className="flex items-center gap-2 mb-1.5">
                  <Badge
                    variant="outline"
                    className={
                      confirmCert.type === "ATTENDANCE"
                        ? "border-blue-300 bg-blue-50 text-blue-800"
                        : "border-amber-300 bg-amber-50 text-amber-800"
                    }
                  >
                    {confirmCert.type === "ATTENDANCE" ? "Attendance" : "Appreciation"}
                  </Badge>
                  <span className="text-xs text-slate-500">{confirmCert.serial}</span>
                </div>
                {confirmCert.certificateTemplate && (
                  <p className="text-xs text-slate-600">
                    Template: {confirmCert.certificateTemplate.name}
                  </p>
                )}
                {recipientLabel && (
                  <p className="text-xs text-slate-600 mt-1">
                    Sending to: <strong>{recipientLabel}</strong>
                  </p>
                )}
                {confirmCert.resendCount > 0 && (
                  <p className="text-xs text-slate-500 mt-2">
                    Previously resent {confirmCert.resendCount} time
                    {confirmCert.resendCount === 1 ? "" : "s"}
                    {confirmCert.lastResentAt &&
                      ` · last ${formatDistanceToNow(new Date(confirmCert.lastResentAt), {
                        addSuffix: true,
                      })}`}
                  </p>
                )}
              </div>
            </div>
          )}
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setConfirmCert(null)}
              disabled={resendMutation.isPending}
            >
              Cancel
            </Button>
            <Button
              onClick={() => confirmCert && handleResend(confirmCert)}
              disabled={resendMutation.isPending}
            >
              {resendMutation.isPending ? (
                <>
                  <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
                  Sending…
                </>
              ) : (
                <>
                  <Send className="h-3.5 w-3.5 mr-1.5" />
                  Resend now
                </>
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Resend-all confirm dialog. */}
      <Dialog open={resendAllOpen} onOpenChange={(open) => !resendAllBusy && !open && setResendAllOpen(false)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Mail className="h-4 w-4" />
              Resend all certificates
            </DialogTitle>
            <DialogDescription>
              All {resendableCerts.length} certificates below are re-sent in{" "}
              <strong>one email</strong> — one PDF attachment per certificate,
              replaying each cert&apos;s existing PDF (same serials, no re-render).
              Use a row&apos;s <em>Resend</em> button instead to re-render a single
              certificate from its latest template.
            </DialogDescription>
          </DialogHeader>
          <ul className="space-y-1.5 text-sm">
            {resendableCerts.map((c) => (
              <li key={c.id} className="flex items-center gap-2">
                <Badge
                  variant="outline"
                  className={
                    c.type === "ATTENDANCE"
                      ? "border-blue-300 bg-blue-50 text-blue-800"
                      : "border-amber-300 bg-amber-50 text-amber-800"
                  }
                >
                  {c.type === "ATTENDANCE" ? "Attendance" : "Appreciation"}
                </Badge>
                <span className="truncate">{c.certificateTemplate?.name ?? "Certificate"}</span>
                <span className="ml-auto shrink-0 font-mono text-xs text-slate-400">{c.serial}</span>
              </li>
            ))}
          </ul>
          <DialogFooter>
            <Button variant="outline" onClick={() => setResendAllOpen(false)} disabled={resendAllBusy}>
              Cancel
            </Button>
            <Button onClick={handleResendAll} disabled={resendAllBusy}>
              {resendAllBusy ? (
                <>
                  <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
                  Sending…
                </>
              ) : (
                <>
                  <Send className="h-3.5 w-3.5 mr-1.5" />
                  Resend all in one email ({resendableCerts.length})
                </>
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Issue-certificate dialog — pick a template, render + email to this person. */}
      <Dialog
        open={issueOpen}
        onOpenChange={(open) => {
          if (issueMutation.isPending) return;
          setIssueOpen(open);
          if (!open) setSelectedTemplateId("");
        }}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Plus className="h-4 w-4" />
              Issue a certificate
            </DialogTitle>
            <DialogDescription>
              Render one certificate template and email it to this{" "}
              {speakerId ? "speaker" : "registration"} now. Tags are not checked —
              this is a direct, on-demand issue.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <label className="text-sm font-medium text-slate-700">Template</label>
            <Select value={selectedTemplateId} onValueChange={setSelectedTemplateId}>
              <SelectTrigger className="w-full">
                <SelectValue placeholder="Choose a certificate template…" />
              </SelectTrigger>
              <SelectContent>
                {issuableTemplates.length === 0 ? (
                  <div className="px-2 py-1.5 text-sm text-slate-400">
                    No {facetCategory === "ATTENDANCE" ? "attendance" : "appreciation"} templates configured.
                  </div>
                ) : (
                  issuableTemplates.map((t) => (
                    <SelectItem key={t.id} value={t.id}>
                      {t.name}
                    </SelectItem>
                  ))
                )}
              </SelectContent>
            </Select>
            <p className="text-xs text-slate-400">
              Already-held templates will be rejected — use “Resend latest version” on the existing row instead.
            </p>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setIssueOpen(false)} disabled={issueMutation.isPending}>
              Cancel
            </Button>
            <Button onClick={handleIssue} disabled={issueMutation.isPending || !selectedTemplateId}>
              {issueMutation.isPending ? (
                <>
                  <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
                  Issuing…
                </>
              ) : (
                <>
                  <Plus className="h-3.5 w-3.5 mr-1.5" />
                  Issue &amp; email
                </>
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

interface CertRowProps {
  cert: IssuedCertificateRow;
  isResending: boolean;
  onResend: () => void;
}

function CertRow({ cert, isResending, onResend }: CertRowProps) {
  const isRevoked = !!cert.revokedAt;
  const firstSentAt = cert.issueRunItem?.emailedAt ?? null;

  return (
    <li className="py-3 flex items-start gap-3">
      <Badge
        variant="outline"
        className={`shrink-0 mt-0.5 ${
          cert.type === "ATTENDANCE"
            ? "border-blue-300 bg-blue-50 text-blue-800"
            : "border-amber-300 bg-amber-50 text-amber-800"
        }`}
      >
        {cert.type === "ATTENDANCE" ? "Attendance" : "Appreciation"}
      </Badge>
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2">
          <p className="text-sm font-medium text-slate-800 truncate">
            {cert.certificateTemplate?.name ?? "Certificate"}
          </p>
          <span className="text-xs text-slate-400 shrink-0 font-mono">
            {cert.serial}
          </span>
        </div>
        <div className="text-xs text-slate-500 mt-0.5 space-y-0.5">
          <div>
            Issued{" "}
            {formatDistanceToNow(new Date(cert.issuedAt), { addSuffix: true })}
            {firstSentAt && (
              <>
                {" · sent "}
                {formatDistanceToNow(new Date(firstSentAt), { addSuffix: true })}
              </>
            )}
          </div>
          {cert.reissueCount > 0 ? (
            <div className="text-amber-700">
              Reissued {cert.reissueCount} time{cert.reissueCount === 1 ? "" : "s"} (latest template)
              {cert.lastReissuedAt &&
                ` · last ${formatDistanceToNow(new Date(cert.lastReissuedAt), { addSuffix: true })}`}
            </div>
          ) : (
            cert.resendCount > 0 && (
              <div className="text-amber-700">
                Resent {cert.resendCount} time{cert.resendCount === 1 ? "" : "s"}
                {cert.lastResentAt &&
                  ` · last ${formatDistanceToNow(new Date(cert.lastResentAt), { addSuffix: true })}`}
              </div>
            )
          )}
          {isRevoked && (
            <div className="flex items-center gap-1 text-red-600">
              <XCircle className="h-3 w-3" />
              Revoked
              {cert.revocationReason && <> · {cert.revocationReason}</>}
            </div>
          )}
          {cert.issueRunItem?.errorMessage && (
            <div className="text-red-600">{cert.issueRunItem.errorMessage}</div>
          )}
        </div>
      </div>
      <div className="flex items-center gap-1 shrink-0">
        {cert.pdfUrl && (
          <Button
            asChild
            size="sm"
            variant="ghost"
            className="h-7 px-2 text-xs"
            title="Open certificate in a new tab"
          >
            <a href={cert.pdfUrl} target="_blank" rel="noreferrer">
              <ExternalLink className="h-3.5 w-3.5 mr-1" />
              Open
            </a>
          </Button>
        )}
        <Button
          size="sm"
          variant="ghost"
          className="h-7 px-2 text-xs"
          onClick={onResend}
          disabled={isResending || isRevoked || !cert.pdfUrl}
          title={
            isRevoked
              ? "Can't resend a revoked cert"
              : !cert.pdfUrl
                ? "PDF not rendered yet"
                : "Resend delivery email"
          }
        >
          {isResending ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <>
              <Send className="h-3.5 w-3.5 mr-1" />
              Resend
            </>
          )}
        </Button>
      </div>
    </li>
  );
}
