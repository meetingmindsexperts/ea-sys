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
}

export const EXPECTED_JOBS: ExpectedJob[] = [
  { name: "scheduled-emails", cadence: "every minute" },
  { name: "crm-inbound-email", cadence: "every minute" },
  { name: "cert-issue", cadence: "every 3 min" },
  { name: "webinar-recordings", cadence: "every 5 min" },
  { name: "crm-reminders", cadence: "every 5 min" },
  { name: "webinar-attendance", cadence: "every 10 min" },
  { name: "invoice-reconciliation", cadence: "every 10 min" },
  { name: "contacts-central-sync", cadence: "twice hourly (:16, :53)" },
  { name: "oauth-cleanup", cadence: "hourly (:00)" },
  { name: "contacts-central-reconcile", cadence: "daily 02:24 UTC" },
  { name: "log-archive", cadence: "monthly (1st, 03:30)" },
  { name: "email-log-prune", cadence: "daily 03:45 UTC" },
];

export const EXPECTED_JOB_NAMES: ReadonlySet<string> = new Set(EXPECTED_JOBS.map((j) => j.name));
