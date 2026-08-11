/**
 * Per-event abstract submission limits (Aug 11, 2026, organizer request).
 *
 * Four numbers organizers used to have no control over, because each was a
 * constant compiled into the app: how many co-authors an abstract may list,
 * how many words its title and body may run to, and how many abstracts one
 * submitter may have in the review pool at once.
 *
 * They live together in `Event.settings.abstractLimits` (JSON, no migration)
 * for the same reason `groupRegistration` does: they are one policy, read as a
 * set at every enforcement point, and a caller that forgets one of four
 * top-level keys is a bug waiting to happen.
 *
 * FAIL-SAFE BY DESIGN. An absent, malformed or out-of-range value falls back
 * to the historical default, so an event with no config behaves exactly as it
 * did before this shipped and a corrupted blob can never make submission
 * impossible. Ceilings exist so a typo (30 -> 3000) cannot turn a form into a
 * denial-of-service on the review committee.
 *
 * Client-safe: Prisma enum value import only, no Node built-ins, so the submit
 * and edit forms can render live counters from the same numbers the API
 * enforces.
 */
import type { AbstractStatus } from "@prisma/client";

/** Historical hardcoded values. Absent config resolves to exactly these. */
export const DEFAULT_MAX_CO_AUTHORS = 20;
export const DEFAULT_MAX_TITLE_WORDS = 30;
export const DEFAULT_MAX_CONTENT_WORDS = 300;
/** null = unlimited, which is what every event has had until now. */
export const DEFAULT_MAX_ABSTRACTS_PER_SUBMITTER: number | null = null;

/** Upper bounds an organizer may set. A cap above these is clamped, not obeyed. */
export const CO_AUTHORS_CEILING = 50;
export const TITLE_WORDS_CEILING = 200;
export const CONTENT_WORDS_CEILING = 5000;
export const ABSTRACTS_PER_SUBMITTER_CEILING = 100;

export interface AbstractLimits {
  maxCoAuthors: number;
  maxTitleWords: number;
  maxContentWords: number;
  /** null = unlimited. */
  maxAbstractsPerSubmitter: number | null;
}

export const DEFAULT_ABSTRACT_LIMITS: AbstractLimits = {
  maxCoAuthors: DEFAULT_MAX_CO_AUTHORS,
  maxTitleWords: DEFAULT_MAX_TITLE_WORDS,
  maxContentWords: DEFAULT_MAX_CONTENT_WORDS,
  maxAbstractsPerSubmitter: DEFAULT_MAX_ABSTRACTS_PER_SUBMITTER,
};

/**
 * Which of a submitter's abstracts occupy one of their slots (owner decision,
 * Aug 11 2026): everything from Submitted onwards, EXCEPT the two states that
 * take an abstract out of the pool.
 *
 *   DRAFT      free  - draft as much as you like, the cap bites at Submit
 *   WITHDRAWN  free  - withdrawing to resubmit a corrected version must work
 *   REJECTED   free  - a rejection returns the slot
 *
 * Deliberately NOT a "not in [...]" list: a future status value would then be
 * counted silently, and the safer default for a limit is to under-count.
 */
export const ABSTRACT_STATUSES_COUNTING_TOWARD_LIMIT: AbstractStatus[] = [
  "SUBMITTED",
  "UNDER_REVIEW",
  "ACCEPTED",
  "REVISION_REQUESTED",
];

/** Coerce one configured number, or fall back to the default. */
function readPositiveInt(raw: unknown, fallback: number, ceiling: number): number {
  const n = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(n)) return fallback;
  const i = Math.floor(n);
  if (i < 1) return fallback;
  return Math.min(i, ceiling);
}

/**
 * The event's abstract limits. Every field is independently defensive, so a
 * blob where one key is garbage still yields sane values for the rest.
 */
export function readAbstractLimits(settings: unknown): AbstractLimits {
  const raw = (settings as { abstractLimits?: unknown } | null | undefined)?.abstractLimits;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return DEFAULT_ABSTRACT_LIMITS;
  const r = raw as Record<string, unknown>;

  // Unlimited is the meaningful default here, so null/absent/0 all mean "no
  // cap" rather than falling back to some number nobody chose.
  const perSubmitterRaw = r.maxAbstractsPerSubmitter;
  const perSubmitter =
    perSubmitterRaw === null || perSubmitterRaw === undefined || perSubmitterRaw === ""
      ? null
      : readPositiveInt(perSubmitterRaw, 0, ABSTRACTS_PER_SUBMITTER_CEILING) || null;

  return {
    maxCoAuthors: readPositiveInt(r.maxCoAuthors, DEFAULT_MAX_CO_AUTHORS, CO_AUTHORS_CEILING),
    maxTitleWords: readPositiveInt(r.maxTitleWords, DEFAULT_MAX_TITLE_WORDS, TITLE_WORDS_CEILING),
    maxContentWords: readPositiveInt(
      r.maxContentWords,
      DEFAULT_MAX_CONTENT_WORDS,
      CONTENT_WORDS_CEILING,
    ),
    maxAbstractsPerSubmitter: perSubmitter,
  };
}

/**
 * Grandfathering rule (owner decision, Aug 11 2026): lowering a cap never
 * invalidates work that already exists. A value over the cap is refused only
 * when it is GROWING, so an existing abstract can always be kept or trimmed,
 * and only new material is held to the new limit.
 *
 * `existing` is undefined on create, where there is nothing to grandfather.
 */
export function exceedsAbstractLimit(next: number, cap: number, existing?: number): boolean {
  if (next <= cap) return false;
  if (existing === undefined) return true;
  return next > existing;
}

export const LIMIT_ERROR_CODES = {
  title: "TITLE_TOO_LONG",
  content: "CONTENT_TOO_LONG",
  coAuthors: "TOO_MANY_CO_AUTHORS",
  perSubmitter: "ABSTRACT_LIMIT_REACHED",
} as const;
