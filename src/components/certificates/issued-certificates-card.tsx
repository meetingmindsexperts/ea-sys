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
  useIssuedCertificates,
  useResendCertificate,
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

  const resendMutation = useResendCertificate(eventId);

  // Confirm dialog state — single cert at a time. We track the whole
  // row (not just id) so the dialog can show the cert's type + serial
  // without re-fetching.
  const [confirmCert, setConfirmCert] = useState<IssuedCertificateRow | null>(null);

  const certificates = data?.certificates ?? [];

  async function handleResend(cert: IssuedCertificateRow) {
    try {
      const result = await resendMutation.mutateAsync(cert.id);
      // H4 fix (review round): the previous wording "sent N times" was
      // ambiguous — N is the resend count, but the cert was also sent
      // ONCE via the original CertificateIssueRun. So a fresh cert
      // post-first-resend reads as resendCount=1, and "sent 1 time" is
      // misleading (it's been sent 2 times total). Spell out both
      // numbers so the operator can correlate with what they see in
      // the row and in EmailHistory.
      const totalSent = result.resendCount + 1; // original + resends
      const category = cert.type === "ATTENDANCE" ? "attendance" : "appreciation";
      toast.success(
        `Resent ${category} certificate · now sent ${totalSent} time${totalSent === 1 ? "" : "s"} total`,
      );
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
              Resend certificate
            </DialogTitle>
            <DialogDescription>
              This re-fires the original delivery email with the same PDF and
              the same cover-email text the recipient would have received the
              first time. No new certificate is generated; the serial stays
              the same.
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
          {cert.resendCount > 0 && (
            <div className="text-amber-700">
              Resent {cert.resendCount} time{cert.resendCount === 1 ? "" : "s"}
              {cert.lastResentAt &&
                ` · last ${formatDistanceToNow(new Date(cert.lastResentAt), {
                  addSuffix: true,
                })}`}
            </div>
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
