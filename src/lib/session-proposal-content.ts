/**
 * Session-proposal description length limit.
 *
 * Characters, not words (unlike the abstract cap in `abstract-content.ts`),
 * because a proposal is a pitch rather than a formal abstract: the organiser
 * cares that the box stays readable in the review list and the CSV export, not
 * that it hits an academic word count.
 *
 * Shared by the proposal form (live counter + a hard `maxLength` on the field)
 * and by BOTH write routes, so a crafted request cannot store a description the
 * form would refuse. Pure and dependency-free, so the client can import it.
 */
export const MAX_PROPOSAL_DESCRIPTION_CHARS = 3000;

/** True when the description fits. Empty passes: "required" is a separate rule. */
export function withinProposalDescriptionLimit(text: string | null | undefined): boolean {
  return (text?.length ?? 0) <= MAX_PROPOSAL_DESCRIPTION_CHARS;
}
