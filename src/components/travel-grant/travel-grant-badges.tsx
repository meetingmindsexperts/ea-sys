"use client";

/**
 * The two visual atoms both travel-grant surfaces render.
 *
 * Extracted because the console page and the speaker-profile card had their own
 * copies and had already drifted on wording before either shipped. Anything
 * added later -- a fourth residency class, a status rename -- now lands in one
 * place, and an organizer comparing a console row to a profile card sees the
 * same words for the same state.
 */

import { Check, X } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import type { ResidencyClass } from "@/lib/travel-grant/eligibility";
import {
  GRANT_STATUS_LABEL,
  RESIDENCY_LABEL,
  type TravelGrantStatusValue,
} from "@/lib/travel-grant/constants";

export function ResidencyBadge({ residency }: { residency: ResidencyClass }) {
  if (residency === "overseas") {
    return (
      <Badge variant="outline" className="border-emerald-300 text-emerald-700">
        {RESIDENCY_LABEL.overseas}
      </Badge>
    );
  }
  if (residency === "uae") {
    return (
      <Badge variant="outline" className="text-muted-foreground">
        {RESIDENCY_LABEL.uae}
      </Badge>
    );
  }
  return (
    <Badge
      variant="outline"
      className="border-rose-300 text-rose-700"
      title="Not emailed. Correct the country on their profile, then send their link."
    >
      {RESIDENCY_LABEL.unknown}
    </Badge>
  );
}

export function GrantStatusLabel({
  status,
  signedName,
}: {
  /** Null means no grant row exists: invited is a different thing from pending. */
  status: TravelGrantStatusValue | null;
  signedName?: string | null;
}) {
  if (!status) return <span className="text-muted-foreground">Not invited</span>;
  if (status === "CONSENTED") {
    return (
      <span className="flex items-center gap-1.5 text-emerald-700">
        <Check className="h-3.5 w-3.5" />
        {GRANT_STATUS_LABEL.CONSENTED}
        {signedName && <span className="text-xs text-muted-foreground">({signedName})</span>}
      </span>
    );
  }
  if (status === "DECLINED") {
    return (
      <span className="flex items-center gap-1.5 text-muted-foreground">
        <X className="h-3.5 w-3.5" />
        {GRANT_STATUS_LABEL.DECLINED}
      </span>
    );
  }
  return <span className="text-amber-700">{GRANT_STATUS_LABEL.PENDING}</span>;
}
