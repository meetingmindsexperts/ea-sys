/**
 * Hardcoded job IDs for Postgres advisory locks.
 *
 * Numeric so the lock API doesn't need a string→hash step.
 * Range 1000-1099 reserved for cron-driven worker jobs to avoid
 * clashes with any application-level advisory locks we might add
 * later (e.g., per-event locks during stats recompute).
 *
 * Two worker instances racing the same tick — Mumbai web container
 * during the dual-write window, Mumbai worker container, a future
 * Singapore DR worker — will all try `pg_try_advisory_lock(JOB_ID)`.
 * Only one gets the lock per job per tick; the others skip cleanly
 * and log `worker:skip-tick-locked`. The lock auto-releases at
 * connection close, so a crashed worker doesn't strand a held lock.
 */

export const JOB_IDS = {
  CERT_ISSUE: 1001,
  SCHEDULED_EMAILS: 1002,
  WEBINAR_RECORDINGS: 1003,
  WEBINAR_ATTENDANCE: 1004,
  OAUTH_CLEANUP: 1005,
  INVOICE_RECONCILIATION: 1006,
  CONTACTS_CENTRAL_SYNC: 1007,
} as const;

export type JobId = (typeof JOB_IDS)[keyof typeof JOB_IDS];
