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
