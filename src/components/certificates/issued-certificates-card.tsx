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
import { Checkbox } from "@/components/ui/checkbox";
import { Plus } from "lucide-react";
import {
  useIssuedCertificates,
  useReissueCertificate,
  useResendCertificateBundle,
  useIssueSingleCertificate,
  usePreviewResendEmail,
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
  /**
   * The person's tags (attendee tags on a registration card, speaker tags on
   * a speaker card) — drive the Issue dialog's "no tag, no certificate" gate
   * client-side (non-matching templates disabled with the reason). The
   * server enforces the same rule regardless, so omitting this only costs
   * the inline explanation, never correctness.
   */
  recipientTags?: string[];
}

export function IssuedCertificatesCard({
  eventId,
  registrationId,
  speakerId,
  recipientLabel,
  recipientTags,
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

  // Preview-before-resend (read-only): both confirm dialogs fetch a render
  // of EXACTLY what the resend would email (same server pipeline) and show
  // it above the confirm button. A preview failure never blocks the resend —
  // it degrades to the old no-preview confirm with a warning line.
  const previewMutation = usePreviewResendEmail(eventId);
  const [previewData, setPreviewData] = useState<{ subject: string; htmlContent: string; recipientEmail: string } | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);

  async function fetchResendPreview(body: { certificateId?: string; registrationId?: string; speakerId?: string }) {
    setPreviewData(null);
    setPreviewError(null);
    try {
      const res = await previewMutation.mutateAsync(body);
      setPreviewData(res);
    } catch (e) {
      setPreviewError(e instanceof Error ? e.message : "Failed to build the email preview");
    }
  }

  function openConfirmResend(cert: IssuedCertificateRow) {
    setConfirmCert(cert);
    void fetchResendPreview({ certificateId: cert.id });
  }

  function openResendAll() {
    setResendAllOpen(true);
    void fetchResendPreview(registrationId ? { registrationId } : { speakerId });
  }

  const certificates = data?.certificates ?? [];
  // Only non-revoked, rendered certs can be (re)sent.
  const resendableCerts = certificates.filter((c) => !c.revokedAt && c.pdfUrl);

  // ── On-demand issue (multi-select — one bundle email) ──
  const issueMutation = useIssueSingleCertificate(eventId);
  const [issueOpen, setIssueOpen] = useState(false);
  const [selectedTemplateIds, setSelectedTemplateIds] = useState<string[]>([]);
  // A registration card issues ATTENDANCE templates; a speaker card issues
  // APPRECIATION ones (the facet the recipient can hold).
  const facetCategory = speakerId ? "APPRECIATION" : "ATTENDANCE";
  const { data: templatesData } = useCertificateTemplates(eventId, issueOpen);
  const issuableTemplates = (templatesData?.templates ?? []).filter((t) => t.category === facetCategory);
  // Template ids this person already holds a (non-revoked) cert from —
  // selecting one re-attaches the existing cert (same serial) instead of
  // minting a duplicate, so annotate rather than disable.
  const heldTemplateIds = new Set(
    certificates.filter((c) => !c.revokedAt).map((c) => c.certificateTemplate?.id).filter(Boolean),
  );

  async function handleIssue() {
    if (selectedTemplateIds.length === 0) return;
    try {
      const body = registrationId
        ? { templateIds: selectedTemplateIds, registrationId }
        : { templateIds: selectedTemplateIds, speakerId };
      const res = await issueMutation.mutateAsync(body);
      const reused = res.certs.filter((c) => c.reused).length;
      const fresh = res.certs.length - reused;
      toast.success(
        `Emailed ${res.certs.length} certificate${res.certs.length === 1 ? "" : "s"} to ${res.recipientEmail}` +
          (reused > 0 ? ` (${fresh} newly issued, ${reused} already held — re-attached)` : ""),
      );
      if (res.failures.length > 0) {
        toast.error(
          `${res.failures.length} certificate${res.failures.length === 1 ? "" : "s"} could not be issued: ${res.failures
            .map((f) => f.templateName)
            .join(", ")}`,
        );
      }
      setIssueOpen(false);
      setSelectedTemplateIds([]);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to issue certificates");
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
              onClick={openResendAll}
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
              onResend={() => openConfirmResend(cert)}
            />
          ))}
        </ul>
      )}

      {/* Confirm dialog — single-instance, swap target via confirmCert. */}
      <Dialog open={!!confirmCert} onOpenChange={(open) => !open && setConfirmCert(null)}>
        <DialogContent className="sm:max-w-lg">
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
              <ResendEmailPreviewPanel
                loading={previewMutation.isPending}
                error={previewError}
                data={previewData}
              />
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
        <DialogContent className="sm:max-w-lg">
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
          <ResendEmailPreviewPanel
            loading={previewMutation.isPending}
            error={previewError}
            data={previewData}
          />
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

      {/* Issue-certificate dialog — multi-select templates, render + email
          to this person as ONE bundle email (one PDF per certificate). */}
      <Dialog
        open={issueOpen}
        onOpenChange={(open) => {
          if (issueMutation.isPending) return;
          setIssueOpen(open);
          if (!open) setSelectedTemplateIds([]);
        }}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Plus className="h-4 w-4" />
              Issue certificates
            </DialogTitle>
            <DialogDescription>
              Select the certificate templates to issue — they render and go out
              as <strong>one email</strong> to this{" "}
              {speakerId ? "speaker" : "registration"}, one PDF per certificate.
              Tags decide who receives what: only templates whose tag this person
              holds can be issued (&ldquo;no tag, no certificate&rdquo;).
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <label className="text-sm font-medium text-slate-700">Templates</label>
            {issuableTemplates.length === 0 ? (
              <p className="rounded-md border p-3 text-sm text-slate-400">
                No {facetCategory === "ATTENDANCE" ? "attendance" : "appreciation"} templates configured — create one under Certificates → Templates.
              </p>
            ) : (
              <div className="max-h-56 space-y-1.5 overflow-y-auto rounded-md border p-2.5">
                {issuableTemplates.map((t) => {
                  const held = heldTemplateIds.has(t.id);
                  const tag = t.autoIssueTag?.trim();
                  // "No tag, no certificate" — mirror the server gate so the
                  // operator sees WHY a template can't be issued instead of
                  // hitting the 422. When the parent didn't pass tags, leave
                  // enabled and let the server enforce.
                  const tagBlocked =
                    !tag || (recipientTags !== undefined && !recipientTags.includes(tag));
                  return (
                    <label
                      key={t.id}
                      className={`flex items-start gap-2 text-sm ${tagBlocked ? "opacity-50" : "cursor-pointer"}`}
                    >
                      <Checkbox
                        className="mt-0.5"
                        disabled={tagBlocked}
                        checked={selectedTemplateIds.includes(t.id)}
                        onCheckedChange={(c) =>
                          setSelectedTemplateIds((prev) =>
                            c === true ? [...prev, t.id] : prev.filter((id) => id !== t.id),
                          )
                        }
                      />
                      <span>
                        <span className="font-medium">{t.name}</span>
                        <span className="block text-xs text-muted-foreground">
                          {!tag
                            ? "no tag — set a tag on the template first (the tag decides who receives it)"
                            : tagBlocked
                              ? `requires tag "${tag}" — this person doesn't have it`
                              : `tag: ${tag}`}
                        </span>
                        {held && !tagBlocked && (
                          <span className="block text-xs text-amber-600">
                            Already issued — the existing certificate (same serial) will be re-attached, not duplicated.
                          </span>
                        )}
                      </span>
                    </label>
                  );
                })}
              </div>
            )}
            {recipientTags !== undefined && recipientTags.length === 0 && issuableTemplates.length > 0 && (
              <p className="rounded-md border border-amber-200 bg-amber-50 p-2.5 text-xs text-amber-800">
                This person has <strong>no tags</strong>, so no certificate can be
                issued to them — tag them first (
                {facetCategory === "ATTENDANCE"
                  ? "Registrations → select → Tags"
                  : "Speakers → select → Tags"}
                ).
              </p>
            )}
            <p className="text-xs text-slate-400">
              The email uses the editable{" "}
              <strong>&ldquo;Certificate Delivery (Multiple Certificates)&rdquo;</strong>{" "}
              template (Communications → Email Templates) when several certificates
              are selected; a single certificate uses that template&apos;s own saved
              cover email.
            </p>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setIssueOpen(false)} disabled={issueMutation.isPending}>
              Cancel
            </Button>
            <Button onClick={handleIssue} disabled={issueMutation.isPending || selectedTemplateIds.length === 0}>
              {issueMutation.isPending ? (
                <>
                  <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
                  Issuing…
                </>
              ) : (
                <>
                  <Plus className="h-3.5 w-3.5 mr-1.5" />
                  Issue &amp; email{selectedTemplateIds.length > 0 ? ` (${selectedTemplateIds.length})` : ""}
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

/** Read-only render of the email a resend would send — subject + branded
 *  HTML in a sandboxed iframe. Shown inside both resend confirm dialogs. */
function ResendEmailPreviewPanel({
  loading,
  error,
  data,
}: {
  loading: boolean;
  error: string | null;
  data: { subject: string; htmlContent: string; recipientEmail: string } | null;
}) {
  if (loading) {
    return (
      <div className="flex items-center gap-2 rounded-md border border-slate-200 bg-slate-50 p-3 text-xs text-slate-500">
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
        Building the email preview…
      </div>
    );
  }
  if (error) {
    return (
      <p className="rounded-md border border-amber-200 bg-amber-50 p-2.5 text-xs text-amber-800">
        Couldn&apos;t build the email preview ({error}) — you can still resend; the
        email is rendered independently at send time.
      </p>
    );
  }
  if (!data) return null;
  return (
    <div className="overflow-hidden rounded-md border border-slate-200">
      <div className="border-b border-slate-200 bg-slate-50 px-3 py-2">
        <p className="text-xs text-slate-500">
          To: <span className="text-slate-700">{data.recipientEmail}</span>
        </p>
        <p className="truncate text-xs font-medium text-slate-800" title={data.subject}>
          Subject: {data.subject}
        </p>
      </div>
      {/* sandbox with no allowances — the branded HTML renders, scripts don't. */}
      <iframe
        title="Email preview"
        sandbox=""
        srcDoc={data.htmlContent}
        className="h-64 w-full bg-white"
      />
    </div>
  );
}
