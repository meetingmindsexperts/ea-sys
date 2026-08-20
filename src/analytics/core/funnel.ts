/**
 * Funnel arithmetic.
 *
 * CLIENT-SAFE. No node: imports, no dependency, no I/O. Counts in, rates out.
 *
 * This is the whole reason the feature exists. EA-SYS can already tell you how
 * many people completed a registration; what it cannot tell you is how many
 * started and left, or where. Everything else in the module is plumbing to get
 * honest numbers into this function.
 */

export interface FunnelInput {
  /** Stable key, e.g. "register_viewed". */
  name: string;
  /** Human label for the chart. */
  label: string;
  /** How many distinct visitors reached this step. */
  count: number;
}

export interface FunnelStep extends FunnelInput {
  /** Share of the FIRST step that reached this one, 0..1 (see note below). */
  conversionRate: number;
  /** Share of the PREVIOUS step that reached this one, 0..1. */
  stepRate: number;
  /** How many were lost between the previous step and this one. */
  dropOff: number;
  /** Share of the previous step that was lost, 0..1. */
  dropOffRate: number;
}

/**
 * Turn ordered step counts into a funnel.
 *
 * A note on rates above 1, because it will happen and it is not a bug. Steps
 * are counted independently, so someone can arrive directly at step two from an
 * emailed link without ever seeing step one. That makes step two larger than
 * step one and its rate greater than 100%.
 *
 * The rate is reported as measured rather than clamped, because clamping would
 * hide exactly that: a step whose rate exceeds 100% is telling you people are
 * entering the funnel in the middle, which is worth knowing. Presentation can
 * decide how to draw it; the arithmetic should not lie about it.
 *
 * `dropOff` is floored at zero, since a negative loss is not a meaningful
 * number to put in front of anyone.
 */
export function buildFunnel(steps: readonly FunnelInput[]): FunnelStep[] {
  if (steps.length === 0) return [];

  const first = Math.max(0, steps[0].count);

  return steps.map((step, i) => {
    const count = Math.max(0, step.count);
    const prev = i === 0 ? count : Math.max(0, steps[i - 1].count);

    // Zero guards throughout. An empty funnel must render as zeros, never as
    // NaN or Infinity leaking into a chart or a CSV.
    const conversionRate = first === 0 ? 0 : count / first;
    const stepRate = prev === 0 ? 0 : count / prev;
    const dropOff = Math.max(0, prev - count);
    const dropOffRate = prev === 0 ? 0 : dropOff / prev;

    return { ...step, count, conversionRate, stepRate, dropOff, dropOffRate };
  });
}

/**
 * The step that loses the most people, which is where to look first.
 *
 * Returns null for a funnel with fewer than two steps, or one that loses
 * nobody. The first step is excluded by definition: it has no predecessor, so
 * it cannot have lost anyone.
 */
export function worstDropOff(steps: readonly FunnelStep[]): FunnelStep | null {
  let worst: FunnelStep | null = null;
  for (let i = 1; i < steps.length; i++) {
    const step = steps[i];
    if (step.dropOff <= 0) continue;
    if (!worst || step.dropOff > worst.dropOff) worst = step;
  }
  return worst;
}
