import { AbstractStatus } from "@prisma/client";

/**
 * DRAFT abstracts are the submitter's private work-in-progress and must never
 * be shown to organizers / admins / reviewers, nor the org-facing MCP surface.
 * Only the owning submitter sees their own drafts (scoped separately by
 * `speaker.userId`).
 *
 * Returns the Prisma `status` filter for an abstract LIST query:
 *  - Caller may see drafts (owning submitter): honor the requested status
 *    verbatim, or `undefined` (no status constraint) when none was requested.
 *  - Caller may NOT see drafts: no requested status → `{ not: DRAFT }`; an
 *    explicit DRAFT request → `{ in: [] }` (empty set, never a leak); any other
 *    requested status → that status.
 */
export function abstractListStatusFilter(opts: {
  canSeeDrafts: boolean;
  requestedStatus?: AbstractStatus | null;
}): AbstractStatus | { in: AbstractStatus[] } | { not: AbstractStatus } | undefined {
  const { canSeeDrafts, requestedStatus } = opts;

  if (requestedStatus) {
    if (!canSeeDrafts && requestedStatus === AbstractStatus.DRAFT) {
      return { in: [] };
    }
    return requestedStatus;
  }

  return canSeeDrafts ? undefined : { not: AbstractStatus.DRAFT };
}
