/**
 * The webinar email sequence the ORGANISER chose (Nov 25, 2026; owner: "make it manual, let the
 * organiser decide what is the sequence"). Decided: the card is pre-filled with the five usual
 * emails and nothing is queued until the organiser confirms; each email can be switched off and its
 * time set; webinars that already had a sequence queued keep it.
 *
 * Stored at `Event.settings.webinar.sequence` (route-owned: only the console's sequence route writes
 * it). Absent means the organiser never confirmed one: such a webinar is SCHEDULED only when it
 * already holds sequence rows (every webinar created before this change), so those keep working as
 * they did, date moves included, and a new or cloned webinar sends nothing until confirmed.
 *
 * Pure and client-safe: the console's card and the engine (`webinar-email-sequence.ts`) share it.
 */
import { z } from "zod";

export const SEQUENCE_PHASES = [
  "webinar-reminder-24h",
  "webinar-reminder-1h",
  "webinar-reminder-15m",
  "webinar-live-now",
  "webinar-thank-you",
] as const;
export type SequencePhase = (typeof SEQUENCE_PHASES)[number];

/** What a phase's minutes count from. */
export type PhaseAnchor = "before-start" | "after-start" | "after-close";

export interface PhaseRule {
  anchor: PhaseAnchor;
  /** The usual time, in minutes: what the card is pre-filled with. */
  defaultMinutes: number;
  min: number;
  max: number;
  /** The card's name for it. */
  label: string;
}

const DAY = 24 * 60;

export const PHASE_RULES: Record<SequencePhase, PhaseRule> = {
  "webinar-reminder-24h": { anchor: "before-start", defaultMinutes: DAY, min: 5, max: 14 * DAY, label: "First reminder" },
  "webinar-reminder-1h": { anchor: "before-start", defaultMinutes: 60, min: 5, max: 14 * DAY, label: "Second reminder" },
  // When the doors open: the session page lets attendees in from 15 minutes before (Oct 28, 2026).
  "webinar-reminder-15m": { anchor: "before-start", defaultMinutes: 15, min: 1, max: 14 * DAY, label: "Doors-open reminder" },
  "webinar-live-now": { anchor: "after-start", defaultMinutes: 0, min: 0, max: 60, label: "We're live" },
  // Five minutes after the room closes (owner, Nov 25, 2026); it follows the close, not the clock.
  "webinar-thank-you": { anchor: "after-close", defaultMinutes: 5, min: 1, max: 4 * 60, label: "Thank you" },
};

export interface PhaseChoice {
  enabled: boolean;
  minutes: number;
}

export interface SequencePlan {
  /** True once the organiser confirmed it (or, absent a stored plan, when rows already exist). */
  stored: boolean;
  confirmed: boolean;
  phases: Record<SequencePhase, PhaseChoice>;
}

export function defaultPhaseChoices(): Record<SequencePhase, PhaseChoice> {
  return Object.fromEntries(SEQUENCE_PHASES.map((p) => [p, { enabled: true, minutes: PHASE_RULES[p].defaultMinutes }])) as Record<
    SequencePhase,
    PhaseChoice
  >;
}

function clampMinutes(phase: SequencePhase, value: unknown): number {
  const rule = PHASE_RULES[phase];
  const n = typeof value === "number" && Number.isFinite(value) ? Math.round(value) : rule.defaultMinutes;
  return Math.min(rule.max, Math.max(rule.min, n));
}

/** The stored plan, repaired: an unknown or out-of-range value falls back to the usual one. */
export function readSequencePlan(eventSettings: unknown): SequencePlan {
  const webinar = (eventSettings as { webinar?: { sequence?: unknown } } | null)?.webinar;
  const raw = webinar && typeof webinar === "object" ? (webinar as { sequence?: unknown }).sequence : undefined;
  const phases = defaultPhaseChoices();
  if (!raw || typeof raw !== "object") return { stored: false, confirmed: false, phases };
  const stored = raw as { confirmed?: unknown; phases?: Record<string, { enabled?: unknown; minutes?: unknown } | undefined> };
  for (const p of SEQUENCE_PHASES) {
    const choice = stored.phases?.[p];
    if (!choice || typeof choice !== "object") continue;
    phases[p] = { enabled: choice.enabled !== false, minutes: clampMinutes(p, choice.minutes) };
  }
  return { stored: true, confirmed: stored.confirmed === true, phases };
}

/** What the sequence route takes: every phase, on or off, with its minutes inside its bounds. */
export const sequencePlanSchema = z
  .object({
    phases: z
      .object(
        Object.fromEntries(
          SEQUENCE_PHASES.map((p) => [
            p,
            z.object({ enabled: z.boolean(), minutes: z.number().int().min(PHASE_RULES[p].min).max(PHASE_RULES[p].max) }).strict(),
          ]),
        ) as unknown as Record<SequencePhase, z.ZodType<PhaseChoice>>,
      )
      .strict(),
    /**
     * The phases whose switch the organiser turned on in this edit (review of 3e967af29). Only these,
     * and the phases switched on against the saved plan, may come back after someone cancelled them.
     */
    switchedOn: z.array(z.enum(SEQUENCE_PHASES)).max(SEQUENCE_PHASES.length).optional(),
  })
  .strict();

/**
 * The phases a save switched on, the only ones it may bring back after someone cancelled them (review
 * of 3e967af29): changing the thank-you's delay must not re-send a "We're live" an operator cancelled.
 */
export function phasesSwitchedOn(
  before: Record<SequencePhase, PhaseChoice>,
  after: Record<SequencePhase, PhaseChoice>,
  toggledOn: readonly SequencePhase[] = [],
): SequencePhase[] {
  return SEQUENCE_PHASES.filter((p) => after[p].enabled && (!before[p].enabled || toggledOn.includes(p)));
}

/**
 * What a date move did to the emails, as the screens and the assistant report it (review of 3e967af29):
 * a webinar whose emails are not scheduled had nothing to move, which is neither "rescheduled" nor
 * "failed".
 */
export type SequenceSync = "rescheduled" | "not-scheduled" | "failed";

export function sequenceSyncOf(result: { ok: boolean; skipped: string | null }): SequenceSync {
  if (!result.ok) return "failed";
  return result.skipped === "not-scheduled" ? "not-scheduled" : "rescheduled";
}

/** The stored form of a confirmed plan. */
export function storedSequencePlan(phases: Record<SequencePhase, PhaseChoice>, confirmed: boolean) {
  return { confirmed, phases };
}

/** A clone keeps the organiser's choices but never their confirmation: the copy sends nothing until confirmed. */
export function cloneSequencePlan(sequence: unknown): Record<string, unknown> | undefined {
  if (!sequence || typeof sequence !== "object") return undefined;
  return { ...(sequence as Record<string, unknown>), confirmed: false };
}

function amountOfTime(minutes: number): string {
  if (minutes % DAY === 0) return `${minutes / DAY} day${minutes === DAY ? "" : "s"}`;
  if (minutes % 60 === 0) return `${minutes / 60} hour${minutes === 60 ? "" : "s"}`;
  return `${minutes} minute${minutes === 1 ? "" : "s"}`;
}

/** "24 hours before the start", "5 minutes after the room closes": the card's and the log's words. */
export function describePhaseTime(phase: SequencePhase, minutes: number): string {
  const anchor = PHASE_RULES[phase].anchor;
  if (anchor === "after-start" && minutes === 0) return "when it starts";
  const amount = amountOfTime(minutes);
  if (anchor === "before-start") return `${amount} before the start`;
  if (anchor === "after-start") return `${amount} after the start`;
  return `${amount} after the room closes`;
}
