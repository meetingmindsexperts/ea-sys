/**
 * A minimal circuit breaker for calls to an external dependency (email
 * provider, Zoom, …). Its whole job is to STOP hammering a dependency that is
 * clearly down: after a run of infrastructure-level failures it "trips open"
 * and fails subsequent calls instantly (in microseconds) for a cooldown, then
 * lets ONE probe through to test recovery.
 *
 *   closed     → calls pass; consecutive infra-failures counted, reset on success
 *   open       → calls short-circuit (fail fast) until the cooldown elapses
 *   half_open  → exactly ONE probe allowed; success ⇒ closed, failure ⇒ open
 *
 * Design notes (why it is shaped this way — see the review that motivated it):
 *   - CONSECUTIVE failures, reset on any success — NOT an error rate. Email
 *     bounces / per-recipient rejections are normal background noise; only a
 *     genuine dependency outage produces an unbroken run of failures. The
 *     CALLER decides what counts as a failure vs a success (e.g. email.ts
 *     counts a per-address MessageRejected as a SUCCESS — the provider
 *     answered, so it's up — and only a 5xx / throttle / timeout as a failure).
 *   - Keyed registry: callers get INDEPENDENT breakers per key. email.ts keys
 *     by `stream` so a bulk-send storm that trips the "bulk" breaker can never
 *     short-circuit a transactional payment receipt (the "transactional"
 *     breaker is separate). That stream isolation is the load-bearing safety
 *     property of this whole feature.
 *   - In-memory, per-process (like the rate limiter). State resets on deploy —
 *     acceptable (a deploy is a natural "try again"). Web and worker get
 *     independent breakers, which reinforces the bulk/transactional split
 *     (bulk runs in the worker, transactional in web).
 *   - canRequest() is SYNCHRONOUS on purpose: the check-and-claim of the single
 *     half-open probe must be atomic, and JS async is cooperative, so a
 *     synchronous method is race-free even when 25 concurrent callers hit it.
 *
 * Leaf module — imports nothing from the app (no logger/db) so it stays pure +
 * unit-testable. Observability is the caller's `onTransition` callback.
 */

export type BreakerState = "closed" | "open" | "half_open";

export interface CircuitBreakerOptions {
  /** Consecutive infra-failures that trip the breaker open. Default 5. */
  failureThreshold?: number;
  /** How long the breaker stays open before allowing a half-open probe (ms). Default 30s. */
  cooldownMs?: number;
  /** Called on every state change — the caller wires logging + alerting here. */
  onTransition?: (from: BreakerState, to: BreakerState, key: string) => void;
}

export const DEFAULT_FAILURE_THRESHOLD = 5;
export const DEFAULT_COOLDOWN_MS = 30_000;

export class CircuitBreaker {
  private state: BreakerState = "closed";
  private consecutiveFailures = 0;
  private openedAt = 0;
  private probeInFlight = false;
  private readonly failureThreshold: number;
  private readonly cooldownMs: number;
  private readonly onTransition?: CircuitBreakerOptions["onTransition"];

  constructor(
    readonly key: string,
    opts: CircuitBreakerOptions = {},
  ) {
    this.failureThreshold = opts.failureThreshold ?? DEFAULT_FAILURE_THRESHOLD;
    this.cooldownMs = opts.cooldownMs ?? DEFAULT_COOLDOWN_MS;
    this.onTransition = opts.onTransition;
  }

  private transition(to: BreakerState, now: number): void {
    const from = this.state;
    if (from === to) return;
    this.state = to;
    if (to === "open") this.openedAt = now;
    try {
      this.onTransition?.(from, to, this.key);
    } catch {
      // An observability callback must never break the breaker.
    }
  }

  /**
   * Whether a call may proceed right now. SIDE-EFFECTING: transitions
   * open → half_open once the cooldown has elapsed and claims the single
   * half-open probe for the FIRST caller that asks (others get false until the
   * probe resolves). Synchronous ⇒ the claim is atomic under async concurrency.
   */
  canRequest(now: number = Date.now()): boolean {
    if (this.state === "closed") return true;

    if (this.state === "open") {
      if (now - this.openedAt < this.cooldownMs) return false;
      // Cooldown elapsed → half-open, and THIS caller is the probe.
      this.transition("half_open", now);
      this.probeInFlight = true;
      return true;
    }

    // half_open: allow exactly one probe in flight.
    if (!this.probeInFlight) {
      this.probeInFlight = true;
      return true;
    }
    return false;
  }

  /** The dependency answered healthily → reset + close. */
  recordSuccess(now: number = Date.now()): void {
    this.consecutiveFailures = 0;
    this.probeInFlight = false;
    if (this.state !== "closed") this.transition("closed", now);
  }

  /** An infrastructure-level failure (the CALLER decides what qualifies). */
  recordFailure(now: number = Date.now()): void {
    this.probeInFlight = false;
    this.consecutiveFailures += 1;
    if (this.state === "half_open") {
      this.transition("open", now); // probe failed → back open, restart cooldown
      return;
    }
    if (this.state === "closed" && this.consecutiveFailures >= this.failureThreshold) {
      this.transition("open", now);
    }
  }

  getState(): BreakerState {
    return this.state;
  }

  /** Test seam — drop cached state (also used if a caller wants a hard reset). */
  reset(): void {
    this.state = "closed";
    this.consecutiveFailures = 0;
    this.openedAt = 0;
    this.probeInFlight = false;
  }
}

// ── Keyed registry (per-process, in-memory) ─────────────────────────────────
const registry = new Map<string, CircuitBreaker>();

/**
 * Get (or lazily create) the breaker for `key`. Options are applied only on
 * first creation for a given key — a breaker's config is stable for the
 * process lifetime, which is what we want (the caller passes the same opts
 * each time).
 */
export function getBreaker(key: string, opts?: CircuitBreakerOptions): CircuitBreaker {
  let b = registry.get(key);
  if (!b) {
    b = new CircuitBreaker(key, opts);
    registry.set(key, b);
  }
  return b;
}

/** Test seam — clear the whole registry between test cases. */
export function __resetAllBreakersForTest(): void {
  registry.clear();
}
