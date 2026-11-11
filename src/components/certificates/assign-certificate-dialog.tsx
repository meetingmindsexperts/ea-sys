"use client";

/**
 * Assign (or remove) a certificate for the people selected on the
 * Registrations or Speakers page. The assignment decides who receives a
 * certificate on every path (src/lib/certificates/assignments.ts); this is
 * the door most people use.
 *
 * Survey auto-issue sends with no review step, so assigning people who have
 * ALREADY answered to a template that sends automatically would email them at
 * once. The server refuses that with CONFIRM_SEND_NOW and the count; this
 * dialog then shows the number and asks before sending the request again.
 */
import { useState } from "react";
import { toast } from "sonner";
import { Award, Loader2, Zap } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { ApiError } from "@/lib/api-fetch";
import {
  assignedCountOf,
  useAssignCertificate,
  useCertificateTemplates,
  useUnassignCertificate,
  type CertTemplateOption,
} from "@/hooks/use-api";

type Mode = "assign" | "remove";

interface AssignCertificateDialogProps {
  eventId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Which page opened it: registrations take attendance certificates, speakers appreciation ones. */
  kind: "registration" | "speaker";
  /** The selected registration or speaker ids. */
  ids: string[];
  /** Called after a change was saved (to clear the selection, for instance). */
  onDone?: () => void;
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** What the toast says once people were assigned. */
function assignedMessage(res: { templateName: string; assigned: number; alreadyAssigned: number; skipped: number; sendNow: number }): string {
  const parts = [`Assigned "${res.templateName}" to ${plural(res.assigned, "person", "people")}`];
  if (res.alreadyAssigned > 0) parts.push(`${res.alreadyAssigned} already had it`);
  if (res.skipped > 0) parts.push(`${res.skipped} skipped (cancelled)`);
  if (res.sendNow > 0) parts.push(`${plural(res.sendNow, "certificate is", "certificates are")} being sent now`);
  return `${parts.join(". ")}.`;
}

export function AssignCertificateDialog({ eventId, open, onOpenChange, kind, ids, onDone }: AssignCertificateDialogProps) {
  const category = kind === "registration" ? "ATTENDANCE" : "APPRECIATION";
  const peopleWord = kind === "registration" ? plural(ids.length, "registration", "registrations") : plural(ids.length, "speaker", "speakers");

  const templatesQuery = useCertificateTemplates(eventId, open);
  const assign = useAssignCertificate(eventId);
  const unassign = useUnassignCertificate(eventId);

  const [mode, setMode] = useState<Mode>("assign");
  const [templateId, setTemplateId] = useState<string | null>(null);
  /** Set when the server asked for the send-now confirmation: how many go out. */
  const [confirmSendNow, setConfirmSendNow] = useState<number | null>(null);

  const templates = (templatesQuery.data?.templates ?? []).filter((t) => t.category === category);
  const selected = templates.find((t) => t.id === templateId) ?? null;
  const busy = assign.isPending || unassign.isPending;

  function close(next: boolean) {
    if (busy) return;
    if (!next) {
      setConfirmSendNow(null);
      setTemplateId(null);
      setMode("assign");
    }
    onOpenChange(next);
  }

  const idsBody = kind === "registration" ? { registrationIds: ids } : { speakerIds: ids };

  async function submitAssign(confirmed: boolean) {
    if (!selected) return;
    try {
      const res = await assign.mutateAsync({ templateId: selected.id, ...idsBody, confirmSendNow: confirmed });
      toast.success(assignedMessage(res));
      onDone?.();
      close(false);
    } catch (err) {
      if (err instanceof ApiError && err.code === "CONFIRM_SEND_NOW") {
        setConfirmSendNow(Number(err.data?.sendNow ?? 0));
        return;
      }
      toast.error(err instanceof Error ? err.message : "Could not assign the certificate");
    }
  }

  async function submitRemove() {
    if (!selected) return;
    try {
      const res = await unassign.mutateAsync({ templateId: selected.id, ...idsBody });
      const kept = res.keptIssued > 0 ? ` ${plural(res.keptIssued, "person keeps", "people keep")} it because they already hold the certificate.` : "";
      toast.success(`Removed "${res.templateName}" from ${plural(res.removed, "person", "people")}.${kept}`);
      onDone?.();
      close(false);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not remove the certificate");
    }
  }

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Award className="h-4 w-4" />
            {confirmSendNow !== null ? "Send certificates now?" : "Assign certificate"}
          </DialogTitle>
          <DialogDescription>
            {confirmSendNow !== null
              ? `"${selected?.name}" is sent automatically once a person has answered the certificate survey.`
              : `Choose the certificate for the ${peopleWord} you selected. Being assigned a certificate is what decides who receives it.`}
          </DialogDescription>
        </DialogHeader>

        {confirmSendNow !== null ? (
          <div className="rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
            <strong>{plural(confirmSendNow, "person has", "people have")} already answered the survey.</strong>{" "}
            {confirmSendNow === 1 ? "Their certificate" : "Their certificates"} will be emailed within a few minutes,
            with no review step. Everyone else receives theirs when they answer.
          </div>
        ) : (
          <div className="space-y-3">
            <div className="inline-flex rounded-md border p-0.5 text-sm" role="tablist" aria-label="What to do">
              {(["assign", "remove"] as const).map((m) => (
                <button
                  key={m}
                  type="button"
                  role="tab"
                  aria-selected={mode === m}
                  onClick={() => setMode(m)}
                  className={`rounded px-3 py-1 ${mode === m ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground"}`}
                >
                  {m === "assign" ? "Assign" : "Remove"}
                </button>
              ))}
            </div>

            <TemplateChoices
              loading={templatesQuery.isLoading}
              templates={templates}
              category={category}
              templateId={templateId}
              onChoose={setTemplateId}
            />

            {mode === "remove" && (
              <p className="text-xs text-muted-foreground">
                Someone who already holds the certificate stays on its list. To take a certificate back, revoke it.
              </p>
            )}
          </div>
        )}

        <DialogFooter>
          {confirmSendNow !== null ? (
            <>
              <Button variant="outline" onClick={() => setConfirmSendNow(null)} disabled={busy}>
                Back
              </Button>
              <Button onClick={() => submitAssign(true)} disabled={busy}>
                {busy && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                Assign and send {plural(confirmSendNow, "certificate", "certificates")}
              </Button>
            </>
          ) : (
            <>
              <Button variant="outline" onClick={() => close(false)} disabled={busy}>
                Cancel
              </Button>
              <Button
                onClick={() => (mode === "assign" ? submitAssign(false) : submitRemove())}
                disabled={busy || !selected || ids.length === 0}
                variant={mode === "remove" ? "destructive" : "default"}
              >
                {busy && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                {mode === "assign" ? `Assign to ${ids.length}` : `Remove from ${ids.length}`}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** The certificates to choose from: one radio per template of the page's category. */
function TemplateChoices({
  loading,
  templates,
  category,
  templateId,
  onChoose,
}: {
  loading: boolean;
  templates: CertTemplateOption[];
  category: "ATTENDANCE" | "APPRECIATION";
  templateId: string | null;
  onChoose: (id: string) => void;
}) {
  if (loading) {
    return (
      <div className="flex items-center gap-2 rounded-md border p-3 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" /> Loading certificates
      </div>
    );
  }
  if (templates.length === 0) {
    return (
      <p className="rounded-md border p-3 text-sm text-muted-foreground">
        This event has no {category === "ATTENDANCE" ? "attendance" : "appreciation"} certificate yet. Create one
        under Certificates, Templates.
      </p>
    );
  }
  return (
    <div className="max-h-64 space-y-1.5 overflow-y-auto" role="radiogroup" aria-label="Certificate">
      {templates.map((t) => {
        const active = t.id === templateId;
        return (
          <button
            key={t.id}
            type="button"
            role="radio"
            aria-checked={active}
            onClick={() => onChoose(t.id)}
            className={`flex w-full items-start gap-3 rounded-md border p-2.5 text-left text-sm transition-colors ${active ? "border-primary bg-primary/5" : "hover:bg-muted/50"}`}
          >
            <span
              aria-hidden
              className={`mt-1 h-3.5 w-3.5 shrink-0 rounded-full border ${active ? "border-4 border-primary" : "border-muted-foreground/40"}`}
            />
            <span className="min-w-0">
              <span className="block font-medium">{t.name}</span>
              <span className="block text-xs text-muted-foreground">
                {plural(assignedCountOf(t), "person", "people")} assigned
                {t.autoIssueOnSurvey && (
                  <span className="ml-2 inline-flex items-center gap-1 text-amber-700">
                    <Zap className="h-3 w-3" /> sent automatically after the survey
                  </span>
                )}
              </span>
            </span>
          </button>
        );
      })}
    </div>
  );
}
