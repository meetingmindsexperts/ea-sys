/** Shared by the question route and the attendee's box (Oct 1, 2026). */
export const QUESTION_MAX_LENGTH = 1000;

export type ViewerQuestionStatus = "NEW" | "ANSWERED" | "DISMISSED";

/**
 * How other attendees see an asker: first name and last initial ("Dana L."),
 * never the full name. Staff see the full name in the console.
 */
export function publicAskerName(fullName: string): string {
  const parts = fullName.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "Attendee";
  if (parts.length === 1) return parts[0];
  return `${parts[0]} ${parts[parts.length - 1][0].toUpperCase()}.`;
}

/**
 * Whether attendees may upvote public questions (Oct 6, 2026;
 * docs/WEBINAR_INTERACTION_PLAN.md §3). The producer's switch in the Webinar
 * Console, `settings.webinar.qaUpvote`; unset means on.
 */
export function qaUpvoteEnabled(webinar: { qaUpvote?: boolean } | null | undefined): boolean {
  return webinar?.qaUpvote !== false;
}

/** Public questions, most-wanted first: votes, then newest. */
export function sortByVotes<T extends { voteCount: number; createdAt: Date | string }>(questions: T[]): T[] {
  return [...questions].sort(
    (a, b) => b.voteCount - a.voteCount || new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
  );
}
