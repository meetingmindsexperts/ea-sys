/**
 * The review scores report (owner, Nov 20, 2026): "what reviewer scored what
 * abstract and what score under each criteria".
 *
 * One row per reviewer per abstract: every submitted review, with a column per
 * criterion, and every assignment that has no review yet (so the same sheet
 * shows who still owes one; a reviewer with a declared conflict of interest
 * is marked as such, since their review would be refused). An abstract with no reviewer and no review has no
 * row here; the abstracts export lists it with "Reviews 0".
 *
 * Columns that need saying:
 *   - Each criterion's column is the reviewer's RAW score on the event's scale
 *     (0 to 5, 10 or 100; `abstract-score.ts`), never converted. The header
 *     names the scale and the weight.
 *   - "Overall (0-100)" is the review's own overall score, always on 0 to 100
 *     whatever the scale, so it can be compared and averaged across events.
 *   - A criterion deleted after reviews were given still has its scores in
 *     them. They are kept, in a trailing column per deleted criterion, because
 *     the overall score was worked out with them.
 *
 * Pure: the route does the reads, the permission and the audit row.
 */
import { formatAbstractSerial } from "@/lib/abstract-serial";
import { formatPersonName } from "@/lib/utils";
import { toCsvRow } from "@/lib/csv-escape";

export interface ReviewScoresCriterion {
  id: string;
  name: string;
  weight: number;
}

export interface ReviewScoresPerson {
  firstName: string | null;
  lastName: string | null;
  email: string;
}

export interface ReviewScoresAbstract {
  serialId: number | null;
  title: string;
  status: string;
  presentationType: string | null;
  themeName: string | null;
  author: { title: string | null; firstName: string; lastName: string } | null;
  /** The reviewers assigned to it, with or without a review. */
  assigned: Array<{ userId: string; role: string; conflictFlag?: boolean }>;
  reviews: Array<{
    reviewerUserId: string;
    /** `{ [criterionId]: score }` as the review stored it; anything else reads as no scores. */
    criteriaScores: unknown;
    overallScore: number | null;
    recommendedFormat: string | null;
    confidence: number | null;
    reviewNotes: string | null;
    updatedAt: Date;
  }>;
}

export interface ReviewScoresInput {
  /** The event's criterion scale: 5, 10 or 100. */
  scale: number;
  /** The event's criteria, in their own order. */
  criteria: ReviewScoresCriterion[];
  abstracts: ReviewScoresAbstract[];
  /** Reviewer accounts by user id. */
  people: ReadonlyMap<string, ReviewScoresPerson>;
}

export const REVIEWED = "Reviewed";
export const NOT_REVIEWED = "Assigned, not reviewed yet";
/** A declared conflict of interest: the review is refused for good, so this is not someone to chase. */
export const CONFLICTED = "Assigned, conflict of interest (cannot review)";

function scoresOf(raw: unknown): Record<string, number> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: Record<string, number> = {};
  for (const [id, score] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof score === "number" && Number.isFinite(score)) out[id] = score;
  }
  return out;
}

function personName(p: ReviewScoresPerson | undefined): string {
  if (!p) return "";
  return [p.firstName, p.lastName].filter(Boolean).join(" ");
}

/** Criterion ids that reviews carry and the event no longer lists, in first-seen order. */
function deletedCriterionIds(input: ReviewScoresInput): string[] {
  const known = new Set(input.criteria.map((c) => c.id));
  const seen = new Set<string>();
  for (const a of input.abstracts) {
    for (const r of a.reviews) {
      for (const id of Object.keys(scoresOf(r.criteriaScores))) {
        if (!known.has(id)) seen.add(id);
      }
    }
  }
  return [...seen];
}

export function buildReviewScoresCsv(input: ReviewScoresInput): { csv: string; rowCount: number } {
  const deleted = deletedCriterionIds(input);
  const header = [
    "Abstract #", "Title", "Status", "Presentation Type", "Theme", "Author",
    "Reviewer", "Reviewer Email", "Reviewer Role", "Review",
    ...input.criteria.map((c) => `${c.name} (0-${input.scale}, weight ${c.weight}%)`),
    ...deleted.map((_, i) => `Deleted criterion ${i + 1} (0-${input.scale})`),
    "Overall (0-100)", "Recommended Format", "Confidence (1-5)", "Notes", "Reviewed At",
  ];

  const rows: unknown[][] = [];
  for (const a of input.abstracts) {
    const about = [
      formatAbstractSerial(a.serialId),
      a.title,
      a.status,
      a.presentationType ?? "",
      a.themeName ?? "",
      a.author ? formatPersonName(a.author.title, a.author.firstName, a.author.lastName) : "",
    ];
    const roleOf = new Map(a.assigned.map((r) => [r.userId, r.role]));
    const reviewed = new Set<string>();

    for (const r of a.reviews) {
      reviewed.add(r.reviewerUserId);
      const person = input.people.get(r.reviewerUserId);
      const scores = scoresOf(r.criteriaScores);
      rows.push([
        ...about,
        personName(person),
        person?.email ?? "",
        // A review can outlive its assignment (the reviewer was taken off the abstract).
        roleOf.get(r.reviewerUserId) ?? "",
        REVIEWED,
        ...input.criteria.map((c) => scores[c.id] ?? ""),
        ...deleted.map((id) => scores[id] ?? ""),
        r.overallScore ?? "",
        r.recommendedFormat ?? "",
        r.confidence ?? "",
        r.reviewNotes ?? "",
        r.updatedAt.toISOString(),
      ]);
    }

    for (const assignment of a.assigned) {
      if (reviewed.has(assignment.userId)) continue;
      const person = input.people.get(assignment.userId);
      rows.push([
        ...about,
        personName(person),
        person?.email ?? "",
        assignment.role,
        assignment.conflictFlag ? CONFLICTED : NOT_REVIEWED,
        ...input.criteria.map(() => ""),
        ...deleted.map(() => ""),
        "", "", "", "", "",
      ]);
    }
  }

  return { csv: [toCsvRow(header), ...rows.map(toCsvRow)].join("\n"), rowCount: rows.length };
}
