"use client";

/**
 * Confirm-and-reset for one person's submitted survey (Sep 17, 2026). Used by
 * the registration detail sheet and the survey responses page, which both call
 * DELETE /api/events/[eventId]/registrations/[registrationId]/survey.
 *
 * Before confirming, it lists the certificates the person holds: resetting a
 * survey never takes a credential back (owner decision), and answering again
 * does not issue a second copy of the same certificate.
 */

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Loader2, RotateCcw } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

/** Same population the route allows (denyReviewer with no allow-list). */
const SURVEY_RESET_ROLES = new Set(["SUPER_ADMIN", "ADMIN", "ORGANIZER"]);

export function canResetSurvey(role: string | null | undefined): boolean {
  return !!role && SURVEY_RESET_ROLES.has(role);
}

interface HeldCertificate {
  serial: string;
  templateName: string | null;
}

interface Props {
  eventId: string;
  registrationId: string | null;
  personName: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onReset: () => void;
}

export function ResetSurveyDialog({ eventId, registrationId, personName, open, onOpenChange, onReset }: Props) {
  const [pending, setPending] = useState(false);

  const certificates = useQuery<HeldCertificate[]>({
    queryKey: ["survey-reset-certificates", eventId, registrationId],
    enabled: open && !!registrationId,
    queryFn: async () => {
      const res = await fetch(`/api/events/${eventId}/certificates/issued?registrationId=${registrationId}`);
      if (!res.ok) throw new Error(`certificates lookup failed (${res.status})`);
      const body = (await res.json()) as {
        certificates: Array<{ serial: string; revokedAt: string | null; certificateTemplate: { name: string } | null }>;
      };
      return body.certificates
        .filter((c) => !c.revokedAt)
        .map((c) => ({ serial: c.serial, templateName: c.certificateTemplate?.name ?? null }));
    },
  });

  const handleReset = async () => {
    if (!registrationId) return;
    setPending(true);
    try {
      const res = await fetch(`/api/events/${eventId}/registrations/${registrationId}/survey`, { method: "DELETE" });
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) {
        toast.error(body.error || "Could not reset the survey.");
        return;
      }
      toast.success(`${personName}'s survey was reset. Send a new link from Send Email, Survey Invitation.`);
      onOpenChange(false);
      onReset();
    } catch (err) {
      console.error("survey-reset:request-failed", err);
      toast.error("Could not reset the survey. Check your connection and try again.");
    } finally {
      setPending(false);
    }
  };

  const held = certificates.data ?? [];

  return (
    <Dialog open={open} onOpenChange={(next) => !pending && onOpenChange(next)}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Reset survey?</DialogTitle>
          <DialogDescription>
            {personName}&apos;s answers will be deleted and they can take the survey again. Send them a new link
            afterwards from Send Email, Survey Invitation.
          </DialogDescription>
        </DialogHeader>

        {certificates.isLoading && (
          <p className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" /> Checking their certificates…
          </p>
        )}
        {certificates.isError && (
          <p className="text-sm text-muted-foreground">
            Their certificates could not be checked. Any they hold are kept.
          </p>
        )}
        {held.length > 0 && (
          <div className="rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-900/50 dark:bg-amber-950/40 dark:text-amber-200">
            <p className="font-medium">They keep {held.length === 1 ? "this certificate" : "these certificates"}:</p>
            <ul className="mt-1 list-disc pl-5">
              {held.map((c) => (
                <li key={c.serial}>
                  {c.templateName ? `${c.templateName} · ` : ""}
                  <span className="font-mono text-xs">{c.serial}</span>
                </li>
              ))}
            </ul>
            <p className="mt-2">
              Resetting the survey does not revoke them, and answering again does not issue a second copy.
            </p>
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={pending}>
            Cancel
          </Button>
          <Button variant="destructive" onClick={handleReset} disabled={pending || !registrationId}>
            {pending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <RotateCcw className="mr-2 h-4 w-4" />}
            Reset survey
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
