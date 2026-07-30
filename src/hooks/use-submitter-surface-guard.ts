"use client";

/**
 * Page-level half of the submitter surface separation (July 30, 2026):
 * a SUBMITTER who opens a surface their signup flow doesn't cover (e.g. a
 * proposal-only submitter typing an /abstracts URL) is redirected to their
 * home surface. Same truth table as the sidebar (src/lib/submitter-surfaces.ts)
 * so the two can never disagree. No-op for every other role, and fails OPEN on
 * a context-fetch error (a blip must never lock a legitimate submitter out).
 */

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { useSession } from "next-auth/react";
import { useSubmitterContext } from "@/hooks/use-api";
import {
  submitterSeesAbstracts,
  submitterSeesProposals,
  submitterHomePath,
} from "@/lib/submitter-surfaces";

export function useSubmitterSurfaceGuard(
  eventId: string,
  surface: "abstracts" | "session-proposals",
): void {
  const { data: session } = useSession();
  const isSubmitter = session?.user?.role === "SUBMITTER";
  const { data: ctx } = useSubmitterContext(isSubmitter ? eventId : "");
  const router = useRouter();

  useEffect(() => {
    if (!isSubmitter || !ctx) return;
    const allowed =
      surface === "abstracts" ? submitterSeesAbstracts(ctx) : submitterSeesProposals(ctx);
    if (!allowed) {
      router.replace(submitterHomePath(eventId, ctx));
    }
  }, [isSubmitter, ctx, surface, eventId, router]);
}
