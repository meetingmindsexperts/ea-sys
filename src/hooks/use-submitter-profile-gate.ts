"use client";

/**
 * Client half of the profile hard gate (Aug 5, 2026): a SUBMITTER opening a
 * submit/edit surface (Submit Abstract, Submit Session Proposal, abstract
 * edit) with an incomplete profile (role / specialty / organization / job
 * title / phone / city / country) is redirected to My Details FIRST, with a
 * `?next=` back-link so completing the form returns them to where they were
 * going. The server refuses the submission too (PROFILE_INCOMPLETE 403) —
 * this hook is the friendly half, that refusal is the bypass-proof half.
 *
 * No-op for every other role, and fails OPEN on a fetch error (a blip must
 * never lock a legitimate submitter out — the server gate still holds).
 */

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { useSession } from "next-auth/react";
import { toast } from "sonner";
import {
  isProfileIncomplete,
  type ProfileCompletenessInput,
} from "@/lib/submitter-profile-completeness";

export function useSubmitterProfileGate(eventId: string): void {
  const { data: session } = useSession();
  const isSubmitter = session?.user?.role === "SUBMITTER";
  const router = useRouter();

  useEffect(() => {
    if (!isSubmitter || !eventId) return;
    let cancelled = false;
    fetch(`/api/events/${eventId}/abstracts/my-profile`)
      .then(async (res) => (res.ok ? ((await res.json()) as ProfileCompletenessInput) : null))
      .then((profile) => {
        if (cancelled || !profile) return;
        if (!isProfileIncomplete(profile)) return;
        // Effect runs client-only, so window is safe — and reading the live
        // location avoids the useSearchParams Suspense requirement.
        const next = window.location.pathname + window.location.search;
        toast.info("Please complete your details first — then you can submit.");
        router.replace(`/events/${eventId}/my-details?next=${encodeURIComponent(next)}`);
      })
      .catch((err) => console.error("[submitter-profile-gate] load failed", err));
    return () => {
      cancelled = true;
    };
  }, [isSubmitter, eventId, router]);
}
