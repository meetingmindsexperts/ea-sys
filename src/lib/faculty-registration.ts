/**
 * Adding someone as Faculty from the admin Add Registration form (Nov 10, 2026).
 *
 * Owner ruling, Nov 9, 2026: Faculty is the umbrella for invited speakers AND
 * committee members. A committee member needs no speaker record, so the form
 * offers Faculty directly, with the committee role on top. Committee stays
 * what docs/COMMITTEE_MEMBERS.md made it: a tag (always "Committee", the
 * anchor), a second tag when the event splits its committees, and the badge.
 *
 * Tags are written the way the dashboard writes every tag, Title Case
 * (normalizeTag): production holds "Committee", never the lowercase
 * `committee` the design record spelled, and the tag filter is case-sensitive.
 *
 * Pure and client-safe: the form shows these choices and the route applies them.
 */

export const COMMITTEE_ROLES = ["NONE", "COMMITTEE", "ORGANIZING", "SCIENTIFIC"] as const;
export type CommitteeRole = (typeof COMMITTEE_ROLES)[number];

export const COMMITTEE_ROLE_LABELS: Record<CommitteeRole, string> = {
  NONE: "Not on a committee",
  COMMITTEE: "Committee",
  ORGANIZING: "Organizing committee",
  SCIENTIFIC: "Scientific committee",
};

/** The printed badge label for a Faculty registration. */
export function facultyBadgeType(role: CommitteeRole): string {
  if (role === "ORGANIZING") return "Organizing Committee";
  if (role === "SCIENTIFIC") return "Scientific Committee";
  if (role === "COMMITTEE") return "Committee";
  return "Faculty";
}

/**
 * The badge a speaker's Faculty registration is made with, when they are on no committee.
 *
 * LEAVING THE FACULTY TYPE CLEARS IT (review of 8eaa3550, MED): moved onto a delegate type, a registration
 * still carrying exactly this badge would print FACULTY for someone the organisers have just said is not
 * faculty, and "Make presenters" would then keep it as a badge set by hand. `badgeOnLeavingFaculty` is spread
 * into the write of both type changes (the single edit and the bulk move). A committee badge, or any other the
 * team chose, is kept: it says something the type did not.
 */
export const FACULTY_BADGE = facultyBadgeType("NONE");

export function badgeOnLeavingFaculty(current: { badgeType: string | null; onFacultyType: boolean }): { badgeType?: null } {
  return current.onFacultyType && (current.badgeType ?? "").trim() === FACULTY_BADGE ? { badgeType: null } : {};
}

/** The committee tags: "Committee" whenever there is a role, plus the split's own tag. */
export function committeeTags(role: CommitteeRole): string[] {
  if (role === "ORGANIZING") return ["Committee", "Organizing Committee"];
  if (role === "SCIENTIFIC") return ["Committee", "Scientific Committee"];
  if (role === "COMMITTEE") return ["Committee"];
  return [];
}

/** Tags merged in order (the person's own first), a duplicate dropped whatever its case. */
export function withCommitteeTags(tags: readonly string[] | undefined, role: CommitteeRole): string[] {
  const out: string[] = [];
  for (const tag of [...(tags ?? []), ...committeeTags(role)]) {
    if (!out.some((t) => t.toLowerCase() === tag.toLowerCase())) out.push(tag);
  }
  return out;
}
