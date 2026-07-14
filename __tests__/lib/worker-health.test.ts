/**
 * Worker /health staleness.
 *
 * The point of these: /health drives Docker's healthcheck, and an unhealthy
 * container gets RESTARTED. So a staleness heuristic that is too eager doesn't
 * just annoy someone — it puts the worker into a restart loop, killing eight
 * healthy jobs to punish the ninth. Hence the deliberately forgiving budget
 * (3x cadence, 2-minute floor), the "not up long enough to have missed one"
 * rule, and the refusal to judge a cron expression we don't understand.
 */

import { describe, it, expect } from "vitest";
import { maxIntervalMs, isStale } from "../../worker/lib/health-server";

const MIN = 60_000;
const HOUR = 60 * MIN;

describe("maxIntervalMs", () => {
  it("handles the cadences the worker actually uses", () => {
    expect(maxIntervalMs("* * * * *")).toBe(MIN); // scheduled-emails
    expect(maxIntervalMs("*/3 * * * *")).toBe(3 * MIN); // cert-issue
    expect(maxIntervalMs("*/5 * * * *")).toBe(5 * MIN); // webinar-recordings
    expect(maxIntervalMs("*/10 * * * *")).toBe(10 * MIN); // invoice-reconciliation
    expect(maxIntervalMs("0 * * * *")).toBe(HOUR); // oauth-cleanup
    expect(maxIntervalMs("16,53 * * * *")).toBe(30 * MIN); // contacts-central-sync
    expect(maxIntervalMs("24 2 * * *")).toBe(24 * HOUR); // contacts-central-reconcile
    expect(maxIntervalMs("30 3 1 * *")).toBe(32 * 24 * HOUR); // log-archive (monthly)
  });

  it("returns null for a shape it does not understand", () => {
    // An unknown cadence must be un-judgeable, never "stale" — see isStale.
    expect(maxIntervalMs("weird")).toBeNull();
    expect(maxIntervalMs("* * *")).toBeNull();
  });
});

describe("isStale", () => {
  const UPTIME_LONG = 7 * 24 * HOUR;

  it("is false for a job ticking on schedule", () => {
    const justNow = new Date(Date.now() - 30_000).toISOString();
    expect(isStale(justNow, "* * * * *", UPTIME_LONG)).toBe(false);
  });

  it("is true for an every-minute job that has not ticked in 10 minutes", () => {
    const old = new Date(Date.now() - 10 * MIN).toISOString();
    expect(isStale(old, "* * * * *", UPTIME_LONG)).toBe(true);
  });

  it("tolerates a slow tick — 3x the cadence before crying wolf", () => {
    // A job holding an advisory lock, or a genuinely long run, must not read as
    // broken. 2.5 minutes on a 1-minute cadence is within budget.
    const recentish = new Date(Date.now() - 2.5 * MIN).toISOString();
    expect(isStale(recentish, "* * * * *", UPTIME_LONG)).toBe(false);
  });

  it("does not flag a monthly job that ran last week", () => {
    // The exact case that was invisible before: log-archive is registered, it
    // ran, and its next run is weeks away. Perfectly healthy.
    const lastWeek = new Date(Date.now() - 7 * 24 * HOUR).toISOString();
    expect(isStale(lastWeek, "30 3 1 * *", UPTIME_LONG)).toBe(false);
  });

  it("does not flag a never-ticked job on a freshly started worker", () => {
    // A worker up for 30 seconds has not missed anything yet. Flagging here
    // would mean every restart briefly reports its own jobs as broken.
    expect(isStale(null, "0 * * * *", 30_000)).toBe(false);
  });

  it("DOES flag a never-ticked job once the worker has been up long enough", () => {
    // This is the finding the old /health could not even express: a registered
    // job that has never run was simply absent from the payload.
    expect(isStale(null, "* * * * *", UPTIME_LONG)).toBe(true);
  });

  it("never flags a job whose cadence it cannot parse", () => {
    // Rather be blind than wrong: a false stale on an unparseable schedule
    // would be a permanent red light nobody can clear.
    expect(isStale(null, "nonsense", UPTIME_LONG)).toBe(false);
  });
});
