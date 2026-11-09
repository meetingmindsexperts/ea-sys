"use client";

import { useState } from "react";
import { ClipboardList, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";

/**
 * "Take survey" on My events: asks for a fresh personal link (the emailed one
 * cannot be shown again, only its hash is kept) and goes there. The route
 * checks ownership and that the survey is open and unanswered; this only
 * shows what it says when it refuses.
 */
export function TakeSurveyButton({ registrationId, surveyId }: { registrationId: string; surveyId: string | null }) {
  const [busy, setBusy] = useState(false);

  const open = async () => {
    setBusy(true);
    try {
      const res = await fetch(`/api/registrant/registrations/${encodeURIComponent(registrationId)}/survey-link`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ surveyId }),
      });
      const data = (await res.json().catch(() => ({}))) as { url?: string; error?: string };
      if (!res.ok || !data.url) {
        console.error("registrant-portal: survey link refused", res.status, data.error);
        toast.error(data.error || "Could not open the survey. Please try again.");
        setBusy(false);
        return;
      }
      // Stays busy: the page is leaving.
      window.location.assign(data.url);
    } catch (err) {
      console.error("registrant-portal: survey link failed", err);
      toast.error("Could not open the survey. Please try again.");
      setBusy(false);
    }
  };

  return (
    <Button onClick={open} disabled={busy} size="sm" className="h-10 w-full sm:h-8 sm:w-auto">
      {busy ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" aria-hidden /> : <ClipboardList className="mr-1.5 h-4 w-4" aria-hidden />}
      Take survey
    </Button>
  );
}
