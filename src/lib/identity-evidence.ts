/**
 * Which identity evidence a registration type asks for (Sept 2, 2026).
 *
 * WHAT THIS REPLACES. The rule used to be a NAME MATCH: a type whose name
 * contained "member" asked for a membership number, one containing "student"
 * asked for a student ID and its expiry. That is configuration encoded in a
 * name, which means nobody can see it, change it, or audit it:
 *
 *   - Renaming "Student" to "Undergraduate" switched verification OFF, with no
 *     warning and no log line.
 *   - "Trainee / Student" asked only because of the slash in its name.
 *   - "Resident" — the most-registered type in this family, defined on 19
 *     events — matched neither pattern, so it asked for nothing at all. No
 *     organizer who created a Resident rate meant that.
 *
 * Same correction the supporting-document switches made on Aug 13, one field
 * over. See [supporting-document.ts](./supporting-document.ts).
 *
 * WHY THERE IS NO "ask but do not block" FLAG. The document feature keeps two
 * booleans so that collecting-without-blocking stays expressible, because a
 * delegate registering at 11pm may genuinely not have a PDF to hand. An ID
 * NUMBER is different: they know it by heart. Asked means required, and a
 * second switch here would be a control nobody ever sets.
 *
 * Client-safe and pure: the two public forms and the two write routes all read
 * this, so the form cannot ask for something the server does not enforce, or
 * the reverse. That reverse is not hypothetical — before this the completion
 * form required these fields in the browser and its route never checked them.
 */

/** The switches as stored on TicketType. */
export interface IdentityEvidencePolicy {
  requiresMemberId: boolean;
  requiresStudentId: boolean;
  requiresStudentIdExpiry: boolean;
}

export interface IdentityEvidenceValues {
  memberId?: string | null;
  studentId?: string | null;
  studentIdExpiry?: string | null;
}

/**
 * Read the policy off a ticket type, normalising the one incoherent
 * combination.
 *
 * Expiry collapses to false when the student ID itself is not asked for: an
 * expiry with no ID to expire is not something anyone means to request, and
 * resolving it HERE means every consumer gets the rule rather than each form
 * remembering it.
 *
 * Fails CLOSED in the sense that matters: an absent or malformed type asks for
 * nothing. These switches gate a public registration form, so the failure to
 * avoid is blocking a paying delegate over a field the organizer never
 * configured — not a missing ID number, which staff can collect at the desk.
 */
export function readIdentityEvidencePolicy(
  ticketType: Partial<IdentityEvidencePolicy> | null | undefined,
): IdentityEvidencePolicy {
  const requiresStudentId = ticketType?.requiresStudentId === true;
  return {
    requiresMemberId: ticketType?.requiresMemberId === true,
    requiresStudentId,
    requiresStudentIdExpiry: requiresStudentId && ticketType?.requiresStudentIdExpiry === true,
  };
}

/** True when this type asks for nothing — the form renders no extra fields. */
export function asksForIdentityEvidence(policy: IdentityEvidencePolicy): boolean {
  return policy.requiresMemberId || policy.requiresStudentId;
}

/**
 * Human-readable labels of what is still missing. Empty array = satisfied.
 *
 * Returns LABELS rather than a boolean so the caller can name the field in the
 * error instead of saying "something is missing" — the difference between a
 * registrant fixing it themselves and mailing the organizer.
 */
export function missingIdentityEvidence(
  policy: IdentityEvidencePolicy,
  values: IdentityEvidenceValues,
): string[] {
  const missing: string[] = [];
  if (policy.requiresMemberId && !values.memberId?.trim()) missing.push("Member ID");
  if (policy.requiresStudentId && !values.studentId?.trim()) missing.push("Student ID");
  if (policy.requiresStudentIdExpiry && !values.studentIdExpiry?.trim()) {
    missing.push("Student ID expiry date");
  }
  return missing;
}

/**
 * True when an expiry was supplied but is not a real date.
 *
 * Separate from `missingIdentityEvidence` because it is a different failure:
 * one is "you left it blank", the other is "that is not a date", and telling a
 * registrant the wrong one sends them looking in the wrong place. Only checks a
 * value that is actually present — absence is the other function's job.
 */
export function hasInvalidExpiryDate(values: IdentityEvidenceValues): boolean {
  const raw = values.studentIdExpiry?.trim();
  if (!raw) return false;
  return Number.isNaN(new Date(raw).getTime());
}

/** Prisma `select` fragment — spread it wherever the policy is needed. */
export const IDENTITY_EVIDENCE_SELECT = {
  requiresMemberId: true,
  requiresStudentId: true,
  requiresStudentIdExpiry: true,
} as const;
