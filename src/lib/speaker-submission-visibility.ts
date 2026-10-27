/**
 * A speaker row carries the speaker's abstracts and session proposals, which
 * have their own read keys. `speakers.read` alone is not enough to see them
 * (owner, Oct 27, 2026: "permission need to be given"): a custom role such as
 * Sales or Onsite that lists speakers without `abstracts.read` gets the row
 * without its abstracts (or their count), and without `proposals.read`
 * without its proposals. Pure, so the list and the detail route share it.
 */
import { can, type Principal } from "@/lib/permissions/can";
import { eventFactsOf } from "@/lib/permissions/event-facts";

export interface SubmissionVisibility {
  abstracts: boolean;
  proposals: boolean;
}

/** Neither list: the default wherever a caller has not said. */
export const NO_SUBMISSIONS: SubmissionVisibility = { abstracts: false, proposals: false };

/**
 * What this caller may see of the submissions on this event: each key judged on
 * the event's own scope, so an assigned-only grant does not reach another event.
 */
export function submissionVisibilityFor(
  principal: Principal,
  event: { organizationId: string; eventType?: string | null; staffAssignments?: { userId: string }[] | null },
): SubmissionVisibility {
  const facts = eventFactsOf({ ...event, staffUserIds: (event.staffAssignments ?? []).map((a) => a.userId) });
  if (!facts) return NO_SUBMISSIONS;
  return {
    abstracts: can(principal, "abstracts.read", { event: facts }),
    proposals: can(principal, "proposals.read", { event: facts }),
  };
}

/** Emails that tell an abstract's outcome, or that the person is an abstract author at all. */
const ABSTRACT_EMAIL_SLUGS = new Set(["presenter-agreement", "submitter-welcome", "travel-grant-invitation"]);

/**
 * The email templates that tell what a speaker submitted and how it was
 * decided: the subject alone ("Abstract Accepted!") is the decision. Bulk
 * sends count too: `bulk-abstract-*` (an abstract email type) and
 * `bulk-abstracts-*` (any type sent to the abstract authors).
 */
export function submissionEmailVisible(templateSlug: string | null | undefined, visible: SubmissionVisibility): boolean {
  if (!templateSlug) return true;
  if (templateSlug.startsWith("abstract-") || templateSlug.startsWith("bulk-abstract") || ABSTRACT_EMAIL_SLUGS.has(templateSlug)) {
    return visible.abstracts;
  }
  if (templateSlug.startsWith("session-proposal")) return visible.proposals;
  return true;
}

type WithSubmissions = {
  abstracts?: unknown;
  sessionProposals?: unknown;
  _count?: Record<string, number>;
};

export function withVisibleSubmissions<T extends WithSubmissions>(speaker: T, visible: SubmissionVisibility): T {
  if (visible.abstracts && visible.proposals) return speaker;
  const out: WithSubmissions = { ...speaker };
  if (!visible.abstracts) {
    delete out.abstracts;
    if (out._count) {
      const { abstracts: _hidden, ...count } = out._count;
      void _hidden;
      out._count = count;
    }
  }
  if (!visible.proposals) delete out.sessionProposals;
  return out as T;
}
