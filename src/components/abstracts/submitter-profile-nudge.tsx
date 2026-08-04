"use client";

/**
 * "Complete your details" nudge (Aug 4, 2026) — shown to a SUBMITTER whose
 * profile is missing the fields the signup form normally requires (typical
 * for accounts that entered via the sign-in shortcut). Mounted on the
 * Abstracts + Session Proposals pages so someone about to submit is nudged
 * BEFORE the organizing team has to chase them. Renders nothing for other
 * roles, complete profiles, or on any fetch error (a blip must never nag).
 */

import { useEffect, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useSession } from "next-auth/react";
import { Button } from "@/components/ui/button";
import { UserRound } from "lucide-react";
import { isProfileIncomplete, missingProfileFields, type ProfileCompletenessInput } from "@/lib/submitter-profile-completeness";

export function SubmitterProfileNudge() {
  const params = useParams();
  const eventId = params.eventId as string;
  const { data: session } = useSession();
  const isSubmitter = session?.user?.role === "SUBMITTER";
  const [missing, setMissing] = useState<string[]>([]);

  useEffect(() => {
    if (!isSubmitter || !eventId) return;
    let cancelled = false;
    fetch(`/api/events/${eventId}/abstracts/my-profile`)
      .then(async (res) => (res.ok ? ((await res.json()) as ProfileCompletenessInput) : null))
      .then((profile) => {
        if (cancelled || !profile) return;
        if (isProfileIncomplete(profile)) setMissing(missingProfileFields(profile));
      })
      .catch((err) => console.error("[submitter-profile-nudge] load failed", err));
    return () => {
      cancelled = true;
    };
  }, [isSubmitter, eventId]);

  if (!isSubmitter || missing.length === 0) return null;

  return (
    <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-amber-300 bg-amber-50 dark:bg-amber-950/40 dark:border-amber-800 px-4 py-3">
      <div className="text-sm text-amber-900 dark:text-amber-200">
        <strong>Please complete your details</strong> — the organizing team needs them for the
        programme. Missing: {missing.join(", ")}.
      </div>
      <Button asChild size="sm" variant="outline" className="border-amber-400">
        <Link href={`/events/${eventId}/abstracts/profile`}>
          <UserRound className="h-4 w-4 mr-1" /> Complete My Details
        </Link>
      </Button>
    </div>
  );
}
