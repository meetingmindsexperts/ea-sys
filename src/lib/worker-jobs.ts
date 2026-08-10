/**
 * Canonical list of the background-worker cron jobs, for the Infra / Ops
 * "Cron / Jobs" card. Showing the FULL expected roster (not just jobs that
 * happen to have a recent JobRun) means a genuinely-silent job stands out
 * instead of being invisible — you can tell "hasn't run yet / broken" from
 * "just a slow cadence".
 *
 * Keep in sync with worker/jobs/*.ts (each exports JOB_NAME + SCHEDULE). A
 * drift test (__tests__/lib/worker-jobs-drift.test.ts) asserts this matches
 * the actual worker job files, so adding a worker job without listing it
 * here fails CI.
 */
export interface ExpectedJob {
  name: string;
  /** Human-readable cadence for display. */
  cadence: string;
  /**
   * Runs the cadence implies in 24h — the yardstick for "is this job actually
   * firing as often as it claims to?".
   *
   * This exists because a job can tick far below its schedule while looking
   * perfectly healthy: nothing FAILS, the last run is recent, and the Cron /
   * Jobs card shows a green tick. That is precisely how the pooler advisory-lock
   * leak hid for months — `scheduled-emails` was running 435 times a day
   * instead of 1,440 and every surface reported it as fine, because every
   * surface only ever asked "did the last run succeed?" rather than "did it run
   * as often as it should have?". The daily digest now asks the second question.
   *
   * `0` means "cadence is longer than a day" (monthly) — not checkable against a
   * 24h window, so skipped rather than guessed at.
   */
  expectedPerDay: number;
}

export const EXPECTED_JOBS: ExpectedJob[] = [
  { name: "scheduled-emails", cadence: "every minute", expectedPerDay: 1440 },
  { name: "crm-inbound-email", cadence: "every minute", expectedPerDay: 1440 },
  { name: "cert-issue", cadence: "every 3 min", expectedPerDay: 480 },
  { name: "webinar-recordings", cadence: "every 5 min", expectedPerDay: 288 },
  { name: "crm-reminders", cadence: "every 5 min", expectedPerDay: 288 },
  { name: "webinar-attendance", cadence: "every 10 min", expectedPerDay: 144 },
  { name: "invoice-reconciliation", cadence: "every 10 min", expectedPerDay: 144 },
  { name: "contacts-central-sync", cadence: "twice hourly (:16, :53)", expectedPerDay: 48 },
  { name: "oauth-cleanup", cadence: "hourly (:00)", expectedPerDay: 24 },
  { name: "contacts-central-reconcile", cadence: "daily 02:24 UTC", expectedPerDay: 1 },
  { name: "log-archive", cadence: "monthly (1st, 03:30)", expectedPerDay: 0 },
  { name: "email-log-prune", cadence: "daily 03:45 UTC", expectedPerDay: 1 },
  { name: "login-event-prune", cadence: "daily 04:15 UTC", expectedPerDay: 1 },
  { name: "system-log-prune", cadence: "daily 04:45 UTC", expectedPerDay: 1 },
  { name: "daily-digest", cadence: "daily 05:30 UTC", expectedPerDay: 1 },
];

/**
 * Fraction of the expected run count below which a job is considered to be
 * under-running. Generous on purpose: a deploy restarts the worker and dents
 * the count legitimately, and the 24h window is rolling. The failure this
 * catches (435 of 1,440 = 30%) is nowhere near the threshold.
 */
export const JOB_UNDERRUN_RATIO = 0.8;

export const EXPECTED_JOB_NAMES: ReadonlySet<string> = new Set(EXPECTED_JOBS.map((j) => j.name));
