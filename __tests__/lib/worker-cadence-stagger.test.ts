/**
 * Job cadences must not converge on the same minute.
 *
 * Every sub-hourly job used to be a bare step expression (star-slash-N), so
 * every one of them fired on minute :00 and most again on :30. That put EIGHT of the
 * fifteen jobs on the same second, each wanting a connection from a pool of
 * ten, and on 2026-08-12 it produced a P2024 pool timeout on the crm-reminders
 * lease claim. It was handled (the claim is classified retryable, so the tick
 * skipped and retried), but it is a standing fragility: it stays invisible
 * while the database is fast and shows up the moment it is not.
 *
 * The fix was to shift the PHASE of each poller, not its frequency, so the
 * peak fell from 8 concurrent to 4. Two of those 4 are the two every-minute
 * jobs, which is an irreducible floor.
 *
 * This test pins the PROPERTY, not the strings. Someone adding the sixteenth
 * job on a plain star-slash-5 fails here and is told to stagger it. That is the
 * whole point: a comment asking people to remember would not have survived.
 */

import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { maxIntervalMs } from "../../worker/lib/health-server";

const JOBS_DIR = join(process.cwd(), "worker", "jobs");

/** Minutes of the hour a cron expression fires on, for the forms we use. */
function firingMinutes(minuteField: string): number[] {
  if (minuteField === "*") return [...Array(60).keys()];
  const step = minuteField.match(/^\*\/(\d+)$/);
  if (step) {
    const n = Number(step[1]);
    return [...Array(60).keys()].filter((m) => m % n === 0);
  }
  const offset = minuteField.match(/^(\d+)-59\/(\d+)$/);
  if (offset) {
    const [start, n] = [Number(offset[1]), Number(offset[2])];
    const out: number[] = [];
    for (let m = start; m < 60; m += n) out.push(m);
    return out;
  }
  return minuteField.split(",").map(Number);
}

interface Job {
  name: string;
  schedule: string;
  minuteField: string;
  everyHour: boolean;
}

const jobs: Job[] = readdirSync(JOBS_DIR)
  .filter((f) => f.endsWith(".ts"))
  .map((f) => {
    const src = readFileSync(join(JOBS_DIR, f), "utf8");
    const schedule = src.match(/export const SCHEDULE = "([^"]+)"/)?.[1] ?? "";
    const [minuteField, hourField] = schedule.split(/\s+/);
    return { name: f.replace(/\.ts$/, ""), schedule, minuteField, everyHour: hourField === "*" };
  });

describe("job cadence staggering", () => {
  it("reads a schedule from every job file", () => {
    expect(jobs.length).toBeGreaterThan(10);
    for (const j of jobs) expect(j.schedule, `${j.name} has no SCHEDULE`).not.toBe("");
  });

  it("never puts more than 4 jobs on the same minute", () => {
    const subHourly = jobs.filter((j) => j.everyHour);
    const load = new Map<number, string[]>();
    for (const j of subHourly) {
      for (const m of firingMinutes(j.minuteField)) {
        load.set(m, [...(load.get(m) ?? []), j.name]);
      }
    }

    const worst = [...load.entries()].sort((a, b) => b[1].length - a[1].length)[0];
    // 4 is the measured peak after staggering (was 8). Two of those are the
    // two every-minute jobs, which cannot be moved. If this fails, do not raise
    // the number: shift the new job's phase to a quieter minute.
    expect(
      worst[1].length,
      `minute :${worst[0]} has ${worst[1].length} jobs (${worst[1].join(", ")}). ` +
        `Stagger the newest one (e.g. "7-59/5" instead of "*/5") rather than raising this bound.`,
    ).toBeLessThanOrEqual(4);
  });

  it("keeps every job's FREQUENCY unchanged, only its phase", () => {
    // Staggering must not change how often a job runs: the daily-digest's
    // expected-vs-actual check and the staleness threshold both derive from it.
    const perHour = (j: Job) => (j.everyHour ? firingMinutes(j.minuteField).length : 0);
    const expected: Record<string, number> = {
      "scheduled-emails": 60,
      "crm-inbound-email": 60,
      "cert-issue": 20,
      "crm-reminders": 12,
      "webinar-recordings": 12,
      "invoice-reconciliation": 6,
      "webinar-attendance": 6,
      "oauth-cleanup": 1,
    };
    for (const [name, runsPerHour] of Object.entries(expected)) {
      const job = jobs.find((j) => j.name === name);
      expect(job, `${name} not found`).toBeDefined();
      expect(perHour(job!), `${name} changed frequency, not just phase`).toBe(runsPerHour);
    }
  });

  it("the staleness parser understands every schedule in use", () => {
    // The trap this test exists for: maxIntervalMs only knew the plain step
    // form, so a staggered "2-59/5" fell through to the comma branch and was
    // read as HOURLY. A five-minute job's stale threshold would have gone from 15
    // minutes to three hours, silently, at the exact moment the schedules
    // became harder to read by eye.
    for (const j of jobs) {
      expect(maxIntervalMs(j.schedule), `${j.name} (${j.schedule}) is unparseable`).not.toBeNull();
    }
  });

  it("prices an offset step the same as its plain equivalent", () => {
    expect(maxIntervalMs("2-59/5 * * * *")).toBe(maxIntervalMs("*/5 * * * *"));
    expect(maxIntervalMs("8-59/10 * * * *")).toBe(maxIntervalMs("*/10 * * * *"));
    expect(maxIntervalMs("1-59/3 * * * *")).toBe(maxIntervalMs("*/3 * * * *"));
  });
});
