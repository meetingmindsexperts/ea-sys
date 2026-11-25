/**
 * Keeping bulk email under the mail service's sending speed (Nov 25, 2026).
 *
 * What happened: on Nov 24, 2026 at 15:00 UTC two webinar reminders came due in the same second (a
 * 1-hour reminder for one webinar, a 24-hour reminder for the next day's). Each sent 25 at a time
 * with nothing between the batches, about 320 emails in 6 seconds against an account limit of 14 a
 * second. Amazon refused 102 of them ("Maximum sending rate exceeded"), nothing tried them again,
 * and the people never got the reminder.
 *
 * Two rules, both applied in `sendEmail` (email.ts), so every sender gets them:
 *  1. PACE: one bulk email at a time leaves this process, evenly spaced. The pacer is one per
 *     process, so two bulk sends running together share the speed instead of each taking it all.
 *     Transactional email (a confirmation, a password reset) is never paced: it is one email, and it
 *     must not queue behind a bulk send.
 *  2. RETRY: an email the service refuses for speed was not sent, so it is sent again after a
 *     wait, a few times, before it counts as failed. The web containers and the worker are separate
 *     processes sharing one account limit, so pacing alone cannot promise the limit is never hit.
 *
 * The speed is `EMAIL_BULK_SEND_RATE` emails a second (default 10, under the account's 14 so a
 * transactional email sent meanwhile still fits); 0 switches pacing off. Read the account's own limit
 * with `aws sesv2 get-account --region ap-south-1` before raising it.
 */

/** Emails a second for bulk sends from one process. */
export const DEFAULT_BULK_SEND_RATE = 10;

type Sleep = (ms: number) => Promise<void>;
const realSleep: Sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * The configured bulk speed. Off (0) under the test runner unless the variable is set: a test that
 * sends several bulk emails must not wait on real time, and one on fake timers would never finish.
 */
export function bulkSendRate(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.EMAIL_BULK_SEND_RATE;
  if (raw === undefined || raw.trim() === "") return env.NODE_ENV === "test" ? 0 : DEFAULT_BULK_SEND_RATE;
  const rate = Number(raw);
  if (!Number.isFinite(rate) || rate < 0) return DEFAULT_BULK_SEND_RATE;
  // Above 0 it is at least 1 a second: "0.001" would be one email every 17 minutes, which is a typo.
  return rate === 0 ? 0 : Math.max(1, rate);
}

export interface Pacer {
  /** Resolves when the caller may send: at once when the line is clear, otherwise in its turn. */
  take(): Promise<void>;
}

/**
 * Evenly spaced turns: at `ratePerSecond` 10, one every 100 ms, however many callers ask at once.
 * No burst allowance on purpose: a burst is what the service refused.
 */
export function createPacer(ratePerSecond: number, deps: { now?: () => number; sleep?: Sleep } = {}): Pacer {
  // A clock that only goes forward: the wall clock stepping back an hour (a time sync) would make
  // every bulk email wait that hour, silently (review of a7cb314ef).
  const now = deps.now ?? (() => performance.now());
  const sleep = deps.sleep ?? realSleep;
  if (!(ratePerSecond > 0)) return { take: async () => {} };
  const intervalMs = 1000 / ratePerSecond;
  let nextTurnAt = 0;
  return {
    async take() {
      const current = now();
      const turnAt = Math.max(current, nextTurnAt);
      nextTurnAt = turnAt + intervalMs;
      if (turnAt > current) await sleep(turnAt - current);
    },
  };
}

let bulkPacer: Pacer | null = null;

/** Wait for this process's next bulk turn. */
export function paceBulkSend(): Promise<void> {
  bulkPacer ??= createPacer(bulkSendRate());
  return bulkPacer.take();
}

/**
 * Refused for speed, and so not sent: safe to send again. NOT the daily quota or a paused account
 * (`LimitExceededException`, `SendingPausedException`): waiting a few seconds does not fix those.
 */
export function isSendRateRefusal(error: unknown): boolean {
  const e = error as { name?: string; message?: string } | null;
  const name = e?.name ?? "";
  if (name !== "TooManyRequestsException" && name !== "ThrottlingException" && name !== "Throttling") return false;
  // The day's quota, whatever name the service gives it: not fixed by a few seconds (review of a7cb314ef).
  return !/daily|quota/i.test(e?.message ?? "");
}

/**
 * How long to wait before each further try. A bulk email can wait: its send is a background job and
 * the person is better served late than never. A transactional one is often inside someone's
 * request, so it tries twice more, quickly.
 */
export const SEND_RATE_RETRY_DELAYS_MS: Record<"bulk" | "transactional", readonly number[]> = {
  bulk: [1_000, 2_000, 4_000, 8_000],
  transactional: [500, 1_500],
};

/**
 * Send, and send again after a wait when the service refuses for speed. Anything else it throws is
 * thrown at once, and so is the last speed refusal once the tries run out. `beforeAttempt` runs
 * before every try (the bulk pacer: a retry takes its turn like any other email).
 */
export async function sendWithRateRetry<T>(
  send: () => Promise<T>,
  opts: {
    stream: "bulk" | "transactional";
    beforeAttempt?: () => Promise<void>;
    onRetry?: (info: { attempt: number; waitMs: number; error: unknown }) => void;
    sleep?: Sleep;
    /** 0 to 1; spreads the waits so refused emails do not all come back in the same instant. */
    random?: () => number;
  },
): Promise<T> {
  const delays = SEND_RATE_RETRY_DELAYS_MS[opts.stream];
  const sleep = opts.sleep ?? realSleep;
  const random = opts.random ?? Math.random;
  for (let attempt = 0; ; attempt++) {
    if (opts.beforeAttempt) await opts.beforeAttempt();
    try {
      return await send();
    } catch (error) {
      if (!isSendRateRefusal(error) || attempt >= delays.length) throw error;
      // The wait, plus up to half of it again.
      const waitMs = Math.round(delays[attempt] * (1 + random() / 2));
      opts.onRetry?.({ attempt: attempt + 1, waitMs, error });
      await sleep(waitMs);
    }
  }
}
