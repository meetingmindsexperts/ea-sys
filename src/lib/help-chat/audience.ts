/**
 * Who the Help Assistant is talking to (Nov 2, 2026). Client-safe on
 * purpose: the chat panel and the system prompt both ask, and the prompt
 * module reads the guide from disk, which cannot ride into a browser bundle.
 *
 * People outside the organising team who can open the Help Assistant. The
 * staff guide and staff wording (paths, role names, "ask an admin", the AI
 * Agent) confused them: a submitter asking who the organiser was got "I
 * wouldn't know", and one asking about a case study got every presentation
 * type in the system rather than the ones their event offers.
 */
const EXTERNAL_ROLES: ReadonlySet<string> = new Set(["SUBMITTER", "REVIEWER", "REGISTRANT"]);

export function isExternalHelpRole(role: string | null | undefined): boolean {
  return EXTERNAL_ROLES.has((role ?? "").trim());
}
