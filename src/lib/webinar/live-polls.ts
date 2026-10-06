/**
 * Live polls on the webinar's custom-stream page (Oct 6, 2026;
 * docs/WEBINAR_INTERACTION_PLAN.md §5). Pure and client-safe: the shapes,
 * the validation the console and the routes share, and the tally.
 *
 * Rules: at most one OPEN poll per session (launching closes the others); one
 * vote per registration, final once given; results reach attendees only when
 * the producer shows them (D5).
 */
import { z } from "zod";

export type LivePollStatus = "DRAFT" | "OPEN" | "CLOSED";

export interface LivePollOption {
  id: string;
  label: string;
}

export const MIN_POLL_OPTIONS = 2;
export const MAX_POLL_OPTIONS = 6;
export const POLL_QUESTION_MAX = 300;
export const POLL_OPTION_MAX = 120;

/** The organiser's switch (settings.webinar.livePolls): off unless turned on. */
export function livePollsEnabled(webinar: { livePolls?: boolean } | null | undefined): boolean {
  return webinar?.livePolls === true;
}

/** What the console sends to create or edit a draft. Option ids are assigned by the server. */
export const pollDraftSchema = z.object({
  question: z.string().trim().min(3, "Type the question").max(POLL_QUESTION_MAX),
  options: z
    .array(z.string().trim().min(1, "An option is empty").max(POLL_OPTION_MAX))
    .min(MIN_POLL_OPTIONS, `At least ${MIN_POLL_OPTIONS} options`)
    .max(MAX_POLL_OPTIONS, `At most ${MAX_POLL_OPTIONS} options`)
    .refine((opts) => new Set(opts.map((o) => o.toLowerCase())).size === opts.length, "Two options are the same"),
  allowMultiple: z.boolean().default(false),
});
export type PollDraft = z.infer<typeof pollDraftSchema>;

/** The stored options, ignoring anything malformed. */
export function readPollOptions(value: unknown): LivePollOption[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (o): o is LivePollOption => !!o && typeof o === "object" && typeof o.id === "string" && typeof o.label === "string",
  );
}

/** Stored choices, as option ids. */
export function readChoices(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((c): c is string => typeof c === "string") : [];
}

/**
 * Whether a vote is valid for the poll: at least one choice, only the poll's
 * own option ids, no repeats, and one choice unless the poll allows several.
 */
export function validChoices(choices: string[], options: LivePollOption[], allowMultiple: boolean): boolean {
  if (choices.length === 0) return false;
  if (!allowMultiple && choices.length > 1) return false;
  if (new Set(choices).size !== choices.length) return false;
  const ids = new Set(options.map((o) => o.id));
  return choices.every((c) => ids.has(c));
}

export interface PollTally {
  /** Option id -> how many voters chose it. */
  counts: Record<string, number>;
  /** People who voted (a multiple-choice voter counts once). */
  voters: number;
}

export function tallyPoll(options: LivePollOption[], votes: { choices: unknown }[]): PollTally {
  const counts: Record<string, number> = Object.fromEntries(options.map((o) => [o.id, 0]));
  for (const v of votes) {
    for (const c of new Set(readChoices(v.choices))) if (c in counts) counts[c] += 1;
  }
  return { counts, voters: votes.length };
}

/** Share of voters, as a whole percentage, for the result bars. */
export function percentOf(count: number, voters: number): number {
  return voters > 0 ? Math.round((count / voters) * 100) : 0;
}
